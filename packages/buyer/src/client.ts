import { decodePaymentResponseHeader } from "@x402/core/http";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { PAYMENT_IDENTIFIER, appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  FAULT_HEADER,
  REQUEST_ID_HEADER,
  parseServerTiming,
  round,
  type BuyerRecord,
  type Fault,
  type PaymentReceipt,
  type Suite,
} from "@x402-bench/shared";
import { packageVersions, type BuyerConfig } from "./config.ts";

export interface BuyerContext {
  cfg: BuyerConfig;
  account: PrivateKeyAccount;
  versions: Record<string, string>;
}

export function createContext(cfg: BuyerConfig, account: PrivateKeyAccount): BuyerContext {
  return { cfg, account, versions: packageVersions() };
}

/** Timing captured by the client hooks around signature construction (T2). */
export interface CreationTiming {
  startMs?: number;
  endMs?: number;
  selected?: PaymentRequirements;
  error?: string;
}

export interface ClientOptions {
  /** Payment identifier to attach (Suite E4). Reuse the same id to test deduplication. */
  paymentId?: string;
  timing?: CreationTiming;
}

/** Build an x402 client that can pay both exact and upto requirements on the configured network. */
export function createClient(ctx: BuyerContext, opts: ClientOptions = {}): x402Client {
  const network = ctx.cfg.network as Network;
  const timing = opts.timing ?? {};
  const client = new x402Client()
    .register(network, new ExactEvmScheme(ctx.account))
    .register(network, new UptoEvmScheme(ctx.account));

  client
    .onBeforePaymentCreation(async (hookCtx) => {
      timing.startMs = performance.now();
      timing.selected = hookCtx.selectedRequirements;
    })
    .onAfterPaymentCreation(async (hookCtx) => {
      timing.endMs = performance.now();
      if (opts.paymentId) attachPaymentId(hookCtx.paymentPayload, hookCtx.paymentRequired, opts.paymentId);
    })
    .onPaymentCreationFailure(async (hookCtx) => {
      timing.endMs = performance.now();
      timing.error = hookCtx.error.message;
    });

  return client;
}

/** Copy the server's payment-identifier declaration into the payload and set the id. */
export function attachPaymentId(payload: PaymentPayload, paymentRequired: PaymentRequired, id: string): void {
  const declared = paymentRequired.extensions?.[PAYMENT_IDENTIFIER];
  if (!declared) return;
  const extensions: Record<string, unknown> = { ...(payload.extensions ?? {}) };
  extensions[PAYMENT_IDENTIFIER] = structuredClone(declared);
  appendPaymentIdentifierToExtensions(extensions, id);
  payload.extensions = extensions;
}

export interface RequestOptions {
  /** Path on the seller, e.g. /paid/exact, or a full URL. */
  route: string;
  suite: Suite;
  test: string;
  label?: string;
  fault?: Fault;
  paymentId?: string;
  requestId?: string;
  /**
   * Suite A2: request the gated route and stop at the 402. No payment is constructed, so the
   * run costs nothing and isolates the gate's own cost from signature and facilitator time.
   */
  noPay?: boolean;
}

interface CallSample {
  startMs: number;
  endMs: number;
  status: number;
  serverTiming: string | null;
  paymentResponse: string | null;
  /** The PAYMENT-REQUIRED header of a 402. On the paid retry it carries the seller's rejection reason. */
  paymentRequired: string | null;
}

export function resolveUrl(cfg: BuyerConfig, route: string): string {
  return /^https?:\/\//.test(route) ? route : `${cfg.sellerUrl}${route.startsWith("/") ? "" : "/"}${route}`;
}

/** Wrap fetch so every HTTP call carries the bench headers and is timed individually. */
export function instrumentedFetch(requestId: string, fault: Fault | undefined, samples: CallSample[]): typeof fetch {
  return async (input, init) => {
    // @x402/fetch may pass headers on a Request object, on init, or both. Merge all of them.
    const headers = input instanceof Request ? new Headers(input.headers) : new Headers();
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set(REQUEST_ID_HEADER, requestId);
    if (fault) headers.set(FAULT_HEADER, fault);
    const startMs = performance.now();
    const res = await fetch(input, { ...init, headers });
    samples.push({
      startMs,
      endMs: performance.now(),
      status: res.status,
      serverTiming: res.headers.get("server-timing"),
      paymentResponse: res.headers.get("payment-response"),
      paymentRequired: res.headers.get("payment-required"),
    });
    return res;
  };
}

/** The `error` string a seller puts in the PAYMENT-REQUIRED header when it rejects a presented payment. */
export function decode402Reason(header: string | null): string | undefined {
  if (!header) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { error?: unknown };
    return typeof decoded.error === "string" && decoded.error.length > 0 ? decoded.error : undefined;
  } catch {
    return undefined;
  }
}

export function decodeReceipt(header: string | null): PaymentReceipt | undefined {
  if (!header) return undefined;
  try {
    const decoded = decodePaymentResponseHeader(header) as PaymentReceipt;
    return {
      success: decoded.success,
      transaction: decoded.transaction,
      network: decoded.network,
      payer: decoded.payer,
      amount: decoded.amount,
      errorReason: decoded.errorReason,
    };
  } catch (err) {
    return { success: false, errorReason: `undecodable PAYMENT-RESPONSE: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * One full paid request through @x402/fetch: unpaid request (T1), signature (T2),
 * paid retry (verify T3 + handler + settle T4 on the seller, delivery T5).
 */
export async function paidRequest(ctx: BuyerContext, opts: RequestOptions): Promise<BuyerRecord> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  const url = resolveUrl(ctx.cfg, opts.route);
  const samples: CallSample[] = [];
  const timing: CreationTiming = {};
  const client = createClient(ctx, { paymentId: opts.paymentId, timing });
  const instrumented = instrumentedFetch(requestId, opts.fault, samples);
  // A2 stops at the 402; every other test lets the client pay and retry.
  const fetchWithPayment = opts.noPay ? instrumented : wrapFetchWithPayment(instrumented, client);

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let finalStatus: number | undefined;
  let error: string | undefined;
  try {
    const res = await fetchWithPayment(url, { method: "GET" });
    finalStatus = res.status;
    await res.arrayBuffer();
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const totalMs = round(performance.now() - t0);

  const first = samples[0];
  const paid = samples[1];
  const serverTiming = parseServerTiming(paid?.serverTiming);
  const paidRoundTripMs = paid ? round(paid.endMs - paid.startMs) : undefined;
  const serverKnown = (serverTiming.verify ?? 0) + (serverTiming.settle ?? 0) + (serverTiming.handler ?? 0);

  return {
    kind: "buyer",
    v: 1,
    requestId,
    suite: opts.suite,
    test: opts.test,
    label: opts.label,
    startedAt,
    url,
    path: new URL(url).pathname,
    buyer: ctx.account.address,
    network: ctx.cfg.network,
    scheme: timing.selected?.scheme,
    amount: timing.selected?.amount,
    asset: timing.selected?.asset,
    maxTimeoutSeconds: timing.selected?.maxTimeoutSeconds,
    paymentId: opts.paymentId,
    fault: opts.fault,
    t1Ms: first ? round(first.endMs - first.startMs) : undefined,
    t2Ms: timing.startMs !== undefined && timing.endMs !== undefined ? round(timing.endMs - timing.startMs) : undefined,
    paidRoundTripMs,
    t3Ms: serverTiming.verify,
    t4Ms: serverTiming.settle,
    handlerMs: serverTiming.handler,
    t5Ms: paidRoundTripMs !== undefined && paid?.serverTiming ? round(paidRoundTripMs - serverKnown) : undefined,
    totalMs,
    firstStatus: first?.status,
    finalStatus: finalStatus ?? paid?.status ?? first?.status,
    receipt: decodeReceipt(paid?.paymentResponse ?? null),
    // A paid retry that comes back 402 carries the seller's reason in PAYMENT-REQUIRED, not in a body the
    // client throws on; without this the record shows a bare 402 and the reason is lost.
    error: error ?? timing.error ?? (paid?.status === 402 ? decode402Reason(paid.paymentRequired) : undefined),
    versions: ctx.versions,
  };
}

/** Helper for the split authorize/settle flow used by Suite D. */
export function httpClient(ctx: BuyerContext, opts: ClientOptions = {}): x402HTTPClient {
  return new x402HTTPClient(createClient(ctx, opts));
}

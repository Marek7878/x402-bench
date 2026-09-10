/**
 * Suite E, the cases that need a tampered or replayed payment rather than a fault header.
 *
 *   pnpm abuse --case replay        # E3: present the same signed payload twice
 *   pnpm abuse --case underfunded   # E5: pay from a fresh key with no USDC
 *   pnpm abuse --case wrong-network # E6: rewrite the network in a signed payload
 *   pnpm abuse --case malformed     # E7: corrupt the signature bytes
 *   pnpm abuse --case all
 *
 * Each case prints what the client saw and appends a BuyerRecord, so `pnpm report`
 * can put it in the Suite E failure table next to the fault-header cases.
 */
import { REQUEST_ID_HEADER, round, type BuyerRecord } from "@x402-bench/shared";
import type { Network, PaymentPayload } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isMain, parseArgs, str } from "./cli.ts";
import { createContext, decodeReceipt, httpClient, resolveUrl, type BuyerContext, type CreationTiming } from "./client.ts";
import { loadConfig, type BuyerConfig } from "./config.ts";
import { appendRecord } from "./recorder.ts";
import { loadOrCreateAccount } from "./wallet.ts";

const CASES = ["replay", "underfunded", "wrong-network", "malformed"] as const;
type Case = (typeof CASES)[number];

/** Which Suite E test each case answers. */
const TEST_ID: Record<Case, string> = {
  replay: "E3",
  underfunded: "E5",
  "wrong-network": "E6",
  malformed: "E7",
};

interface Attempt {
  status?: number;
  body: string;
  paymentResponse: string | null;
  serverTiming: string | null;
  roundTripMs: number;
  error?: string;
}

/** Ask the seller for requirements and sign a payment, without sending it. */
async function signPayment(
  ctx: BuyerContext,
  url: string,
  requestId: string,
): Promise<{ payload: PaymentPayload; timing: CreationTiming; t1Ms: number }> {
  const timing: CreationTiming = {};
  const client = httpClient(ctx, { timing });
  const t0 = performance.now();
  const res = await fetch(url, { headers: { [REQUEST_ID_HEADER]: requestId } });
  const body = await res.text();
  const t1Ms = round(performance.now() - t0);
  if (res.status !== 402) throw new Error(`Expected 402 from ${url}, got ${res.status}: ${body.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const paymentRequired = client.getPaymentRequiredResponse((name) => res.headers.get(name), parsed);
  const payload = await client.createPaymentPayload(paymentRequired);
  return { payload, timing, t1Ms };
}

/** Send an already-signed payload, tampered or not, and report what came back. */
async function present(ctx: BuyerContext, url: string, payload: PaymentPayload, requestId: string): Promise<Attempt> {
  const client = httpClient(ctx);
  const headers = new Headers(client.encodePaymentSignatureHeader(payload));
  headers.set(REQUEST_ID_HEADER, requestId);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    return {
      status: res.status,
      body,
      paymentResponse: res.headers.get("payment-response"),
      serverTiming: res.headers.get("server-timing"),
      roundTripMs: round(performance.now() - t0),
    };
  } catch (err) {
    return {
      body: "",
      paymentResponse: null,
      serverTiming: null,
      roundTripMs: round(performance.now() - t0),
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

function record(
  ctx: BuyerContext,
  opts: { requestId: string; test: string; label: string; url: string; payer: string; t1Ms?: number; t2Ms?: number },
  attempt: Attempt,
): BuyerRecord {
  return {
    kind: "buyer",
    v: 1,
    requestId: opts.requestId,
    suite: "E",
    test: opts.test,
    label: opts.label,
    startedAt: new Date().toISOString(),
    url: opts.url,
    path: new URL(opts.url).pathname,
    buyer: opts.payer,
    network: ctx.cfg.network,
    t1Ms: opts.t1Ms,
    t2Ms: opts.t2Ms,
    paidRoundTripMs: attempt.roundTripMs,
    totalMs: round((opts.t1Ms ?? 0) + (opts.t2Ms ?? 0) + attempt.roundTripMs),
    firstStatus: 402,
    finalStatus: attempt.status,
    receipt: decodeReceipt(attempt.paymentResponse),
    error: attempt.error ?? (attempt.status !== 200 ? `HTTP ${attempt.status}: ${attempt.body.slice(0, 200)}` : undefined),
    versions: ctx.versions,
  };
}

function show(label: string, attempt: Attempt): void {
  const receipt = decodeReceipt(attempt.paymentResponse);
  const money = receipt?.transaction ? `tx ${receipt.transaction.slice(0, 12)}…` : "no transaction";
  const detail = attempt.error ?? (attempt.status === 200 ? "content delivered" : attempt.body.slice(0, 160).replace(/\s+/g, " "));
  console.log(`  ${label.padEnd(22)} status=${String(attempt.status ?? "-").padStart(3)}  ${money}  ${detail}`);
}

const t2Of = (timing: CreationTiming): number | undefined =>
  timing.startMs !== undefined && timing.endMs !== undefined ? round(timing.endMs - timing.startMs) : undefined;

/** E3: a payload that settled once must not settle again. */
async function replayCase(ctx: BuyerContext, cfg: BuyerConfig, route: string): Promise<void> {
  const url = resolveUrl(cfg, route);
  console.log(`\nE3 replay — present one signed payload twice (${url})`);
  const firstId = crypto.randomUUID();
  const { payload, timing, t1Ms } = await signPayment(ctx, url, firstId);

  const first = await present(ctx, url, payload, firstId);
  show("first presentation", first);
  appendRecord(cfg, record(ctx, { requestId: firstId, test: "E3", label: "first-presentation", url, payer: ctx.account.address, t1Ms, t2Ms: t2Of(timing) }, first));

  const replayId = crypto.randomUUID();
  const second = await present(ctx, url, payload, replayId);
  show("replay of the same", second);
  appendRecord(cfg, record(ctx, { requestId: replayId, test: "E3", label: "replay", url, payer: ctx.account.address }, second));

  const bothSettled = first.status === 200 && second.status === 200;
  console.log(`  => ${bothSettled ? "DOUBLE SPEND: both presentations settled" : "replay rejected, as required"}`);
}

/** E5: sign with a brand-new key that holds no USDC at all. */
async function underfundedCase(ctx: BuyerContext, cfg: BuyerConfig, route: string): Promise<void> {
  const url = resolveUrl(cfg, route);
  const account = privateKeyToAccount(generatePrivateKey());
  console.log(`\nE5 underfunded — pay from an empty wallet ${account.address}`);
  // A throwaway context: same config, different signer. The key is never written to disk.
  const emptyCtx: BuyerContext = { ...ctx, account };
  const requestId = crypto.randomUUID();
  const { payload, timing, t1Ms } = await signPayment(emptyCtx, url, requestId);
  const attempt = await present(emptyCtx, url, payload, requestId);
  show("empty wallet", attempt);
  appendRecord(cfg, record(emptyCtx, { requestId, test: "E5", label: "empty-wallet", url, payer: account.address, t1Ms, t2Ms: t2Of(timing) }, attempt));
}

/** E6: keep a valid signature but claim a different chain. */
async function wrongNetworkCase(ctx: BuyerContext, cfg: BuyerConfig, route: string): Promise<void> {
  const url = resolveUrl(cfg, route);
  // Ethereum Sepolia: a real network, but not the one the seller asked to be paid on.
  const wrong = cfg.network === "eip155:11155111" ? "eip155:1" : "eip155:11155111";
  console.log(`\nE6 wrong network — signed for ${cfg.network}, presented as ${wrong} (${url})`);
  const requestId = crypto.randomUUID();
  const { payload, timing, t1Ms } = await signPayment(ctx, url, requestId);
  // The network the client claims to be paying on lives in payload.accepted, the copy of the
  // requirements it selected. A top-level `network` key is ignored, so tampering there proves
  // nothing.
  const accepted = payload.accepted;
  if (!accepted) throw new Error("payload has no accepted requirements to tamper with");
  const tampered: PaymentPayload = { ...payload, accepted: { ...accepted, network: wrong as Network } };
  const attempt = await present(ctx, url, tampered, requestId);
  show(`network=${wrong}`, attempt);
  appendRecord(cfg, record(ctx, { requestId, test: "E6", label: `network-${wrong}`, url, payer: ctx.account.address, t1Ms, t2Ms: t2Of(timing) }, attempt));
}

/** E7: flip bytes in the signature so it recovers to nobody. */
async function malformedCase(ctx: BuyerContext, cfg: BuyerConfig, route: string): Promise<void> {
  const url = resolveUrl(cfg, route);
  console.log(`\nE7 malformed signature — corrupt the signature bytes (${url})`);
  const requestId = crypto.randomUUID();
  const { payload, timing, t1Ms } = await signPayment(ctx, url, requestId);

  const inner = payload.payload as Record<string, unknown>;
  const signature = typeof inner.signature === "string" ? inner.signature : undefined;
  if (!signature) throw new Error("payload has no signature field to corrupt");
  // Replace the middle of the signature with zeroes: same length and shape, invalid content.
  const corrupted = `${signature.slice(0, 10)}${"0".repeat(40)}${signature.slice(50)}`;
  const tampered = { ...payload, payload: { ...inner, signature: corrupted } } as PaymentPayload;

  const attempt = await present(ctx, url, tampered, requestId);
  show("corrupted signature", attempt);
  appendRecord(cfg, record(ctx, { requestId, test: "E7", label: "corrupt-signature", url, payer: ctx.account.address, t1Ms, t2Ms: t2Of(timing) }, attempt));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const requested = str(args, "case", "all");
  const route = str(args, "route", "/paid/exact");
  const selected: Case[] = requested === "all" ? [...CASES] : [requested as Case];
  for (const c of selected) {
    if (!CASES.includes(c)) throw new Error(`Unknown case "${c}". Use ${CASES.join(", ")}, or all.`);
  }

  const cfg = loadConfig();
  const { account } = loadOrCreateAccount(cfg);
  const ctx = createContext(cfg, account);
  console.log(`seller=${cfg.sellerUrl} buyer=${account.address} cases=${selected.join(",")}`);

  for (const c of selected) {
    const run = { replay: replayCase, underfunded: underfundedCase, "wrong-network": wrongNetworkCase, malformed: malformedCase }[c];
    try {
      await run(ctx, cfg, route);
    } catch (err) {
      console.error(`  ${TEST_ID[c]} ${c} could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\nrecords appended under results/. Run pnpm report for the Suite E table.");
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

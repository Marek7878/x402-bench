/**
 * Suite D, step 1: request the 402, sign an authorization, and store it without sending.
 * The upto deadline is now + maxTimeoutSeconds from the seller's requirements, so the
 * stored authorization can be presented later with `pnpm settle`.
 *
 *   pnpm authorize --route /paid/upto
 *   pnpm authorize --route "/paid/upto?charge=40%"
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { REQUEST_ID_HEADER, round } from "@x402-bench/shared";
import { isMain, num, parseArgs, str } from "./cli.ts";
import { createContext, httpClient, resolveUrl, type CreationTiming } from "./client.ts";
import { loadConfig } from "./config.ts";
import { pendingDir } from "./recorder.ts";
import { loadOrCreateAccount } from "./wallet.ts";

export interface PendingAuthorization {
  requestId: string;
  url: string;
  authorizedAt: string;
  t1Ms: number;
  t2Ms?: number;
  scheme?: string;
  amount?: string;
  maxTimeoutSeconds?: number;
  /** now + maxTimeoutSeconds at authorization time, ISO. */
  expectedDeadline?: string;
  paymentRequired: unknown;
  paymentPayload: unknown;
  buyer: string;
  network: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const route = str(args, "route", "/paid/upto");
  const paymentId = str(args, "payment-id");
  // Suite D needs one authorization per hold length (1 h, 6 h, 24 h, 48 h); each is single use.
  const n = Math.max(1, Math.floor(num(args, "n", 1)));

  const cfg = loadConfig();
  const { account } = loadOrCreateAccount(cfg);
  const ctx = createContext(cfg, account);
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    if (n > 1) console.log(`\n[${i}/${n}]`);
    ids.push(await authorizeOne(cfg, account, ctx, route, paymentId));
  }
  if (n > 1) {
    console.log(`\n${n} authorizations stored. Settle each after its own hold, for example:`);
    ids.forEach((id, i) => console.log(`  pnpm settle --id ${id} --test D${i + 3} --after ${[1, 6, 24, 48][i] ?? 1}h`));
  }
}

async function authorizeOne(
  cfg: ReturnType<typeof loadConfig>,
  account: ReturnType<typeof loadOrCreateAccount>["account"],
  ctx: ReturnType<typeof createContext>,
  route: string,
  paymentId: string | undefined,
): Promise<string> {
  const timing: CreationTiming = {};
  const client = httpClient(ctx, { paymentId, timing });

  const requestId = crypto.randomUUID();
  const url = resolveUrl(cfg, route);

  const t0 = performance.now();
  const res = await fetch(url, { headers: { [REQUEST_ID_HEADER]: requestId } });
  const body = await res.text();
  const t1Ms = round(performance.now() - t0);
  if (res.status !== 402) {
    throw new Error(`Expected 402 from ${url}, got ${res.status}: ${body.slice(0, 200)}`);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = undefined;
  }
  const paymentRequired = client.getPaymentRequiredResponse((name) => res.headers.get(name), parsedBody);
  const paymentPayload = await client.createPaymentPayload(paymentRequired);

  const authorizedAt = new Date();
  const selected = timing.selected;
  const pending: PendingAuthorization = {
    requestId,
    url,
    authorizedAt: authorizedAt.toISOString(),
    t1Ms,
    t2Ms: timing.startMs !== undefined && timing.endMs !== undefined ? round(timing.endMs - timing.startMs) : undefined,
    scheme: selected?.scheme,
    amount: selected?.amount,
    maxTimeoutSeconds: selected?.maxTimeoutSeconds,
    expectedDeadline: selected?.maxTimeoutSeconds
      ? new Date(authorizedAt.getTime() + selected.maxTimeoutSeconds * 1000).toISOString()
      : undefined,
    paymentRequired,
    paymentPayload,
    buyer: account.address,
    network: cfg.network,
  };

  const file = path.join(pendingDir(cfg), `${requestId}.json`);
  writeFileSync(file, JSON.stringify(pending, null, 2));

  console.log(`authorized ${pending.scheme ?? "?"} for ${pending.amount ?? "?"} atomic units on ${url}`);
  console.log(`  request id:        ${requestId}`);
  console.log(`  T1 (402):          ${t1Ms} ms`);
  console.log(`  T2 (signature):    ${pending.t2Ms ?? "-"} ms`);
  console.log(`  maxTimeoutSeconds: ${pending.maxTimeoutSeconds ?? "-"}`);
  console.log(`  expected deadline: ${pending.expectedDeadline ?? "-"}`);
  console.log(`  stored:            ${file}`);
  console.log(`\nSettle later with:\n  pnpm settle --id ${requestId} --test D3 --after 1h`);
  return requestId;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

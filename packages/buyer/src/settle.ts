/**
 * Suite D, step 2: present a stored authorization to the seller, which verifies and settles it.
 *
 *   pnpm settle --id <requestId> --test D1                # settle now
 *   pnpm settle --id <requestId> --test D3 --after 1h     # wait until authorizedAt + 1h, then settle
 *   pnpm settle --id <requestId> --test D6 --keep         # keep the file so it can be presented again
 *   pnpm settle --all --test D5                           # settle every pending authorization now
 */
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { PaymentPayload } from "@x402/core/types";
import { REQUEST_ID_HEADER, parseServerTiming, round, type BuyerRecord } from "@x402-bench/shared";
import type { PendingAuthorization } from "./authorize.ts";
import { bool, isMain, parseArgs, parseDurationSeconds, sleep, str } from "./cli.ts";
import { createContext, decodeReceipt, httpClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { appendRecord, pendingDir, settledDir } from "./recorder.ts";
import { decode402Reason } from "./client.ts";
import { loadOrCreateAccount } from "./wallet.ts";

async function settleOne(file: string, test: string, afterSeconds: number, keep: boolean): Promise<void> {
  const cfg = loadConfig();
  const pending = JSON.parse(readFileSync(file, "utf8")) as PendingAuthorization;
  const { account } = loadOrCreateAccount(cfg);
  if (account.address.toLowerCase() !== pending.buyer.toLowerCase()) {
    throw new Error(`Authorization ${pending.requestId} was signed by ${pending.buyer}, but .env holds ${account.address}.`);
  }
  const ctx = createContext(cfg, account);
  const client = httpClient(ctx);

  const authorizedAt = new Date(pending.authorizedAt).getTime();
  if (afterSeconds > 0) {
    const targetMs = authorizedAt + afterSeconds * 1000;
    if (targetMs > Date.now()) {
      console.log(`waiting until ${new Date(targetMs).toISOString()} …`);
      // Poll against an absolute target instead of one long sleep. A single timer of this length
      // is suspended while the machine sleeps, so a laptop shut overnight fired the 6 h settle
      // roughly 9.5 h late and would have pushed the 40 h settle past the 48 h Permit2 deadline,
      // losing the test outright. Waking up and re-comparing the clock costs nothing and cannot
      // drift.
      while (Date.now() < targetMs) {
        await sleep(Math.min(30_000, targetMs - Date.now()));
      }
    }
  }
  const heldSeconds = Math.round((Date.now() - authorizedAt) / 1000);
  if (afterSeconds > 0 && heldSeconds > afterSeconds * 1.05) {
    // Say so loudly rather than filing it as the requested hold: what makes a Suite D record
    // meaningful is the elapsed time actually achieved, not the one that was asked for.
    console.log(`note: held ${heldSeconds} s, not the requested ${afterSeconds} s — reporting the real elapsed time.`);
  }

  const headers = new Headers(client.encodePaymentSignatureHeader(pending.paymentPayload as PaymentPayload));
  headers.set(REQUEST_ID_HEADER, pending.requestId);

  const startedAt = new Date();
  const t0 = performance.now();
  let status: number | undefined;
  let error: string | undefined;
  let serverTimingHeader: string | null = null;
  let paymentResponse: string | null = null;
  try {
    const res = await fetch(pending.url, { headers });
    status = res.status;
    serverTimingHeader = res.headers.get("server-timing");
    paymentResponse = res.headers.get("payment-response");
    const text = await res.text();
    // A refused presentation carries the seller's reason in PAYMENT-REQUIRED; the body is usually `{}`.
    const reason = res.status === 402 ? decode402Reason(res.headers.get("payment-required")) : undefined;
    if (res.status !== 200) error = reason ?? `HTTP ${res.status}: ${text.slice(0, 300)}`;
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const paidRoundTripMs = round(performance.now() - t0);
  const serverTiming = parseServerTiming(serverTimingHeader);
  const serverKnown = (serverTiming.verify ?? 0) + (serverTiming.settle ?? 0) + (serverTiming.handler ?? 0);
  const holdSeconds = Math.round((startedAt.getTime() - authorizedAt) / 1000);

  const record: BuyerRecord = {
    kind: "buyer",
    v: 1,
    requestId: pending.requestId,
    suite: "D",
    test,
    startedAt: startedAt.toISOString(),
    url: pending.url,
    path: new URL(pending.url).pathname,
    buyer: pending.buyer,
    network: pending.network,
    scheme: pending.scheme,
    amount: pending.amount,
    maxTimeoutSeconds: pending.maxTimeoutSeconds,
    t1Ms: pending.t1Ms,
    t2Ms: pending.t2Ms,
    paidRoundTripMs,
    t3Ms: serverTiming.verify,
    t4Ms: serverTiming.settle,
    handlerMs: serverTiming.handler,
    t5Ms: serverTimingHeader ? round(paidRoundTripMs - serverKnown) : undefined,
    totalMs: round(pending.t1Ms + (pending.t2Ms ?? 0) + paidRoundTripMs),
    firstStatus: 402,
    finalStatus: status,
    receipt: decodeReceipt(paymentResponse),
    holdSeconds,
    authorizedAt: pending.authorizedAt,
    error,
    versions: ctx.versions,
  };
  const out = appendRecord(cfg, record);

  console.log(`settle ${pending.requestId} (${test}) after ${holdSeconds} s hold`);
  console.log(`  status:   ${status ?? "-"}   T3=${serverTiming.verify ?? "-"} ms  T4=${serverTiming.settle ?? "-"} ms  round trip=${paidRoundTripMs} ms`);
  if (record.receipt) {
    console.log(`  receipt:  success=${record.receipt.success} tx=${record.receipt.transaction ?? "-"} amount=${record.receipt.amount ?? "-"} ${record.receipt.errorReason ?? ""}`);
  }
  if (error) console.log(`  error:    ${error}`);
  console.log(`  recorded: ${out}`);

  if (!keep) {
    renameSync(file, path.join(settledDir(cfg), path.basename(file)));
  } else {
    console.log("  kept pending file (use it again for D6: second settlement on one authorization)");
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const test = str(args, "test", "D1");
  const afterSeconds = parseDurationSeconds(str(args, "after"), 0);
  const keep = bool(args, "keep");
  const cfg = loadConfig();
  const dir = pendingDir(cfg);

  if (bool(args, "all")) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      console.log(`no pending authorizations in ${dir}`);
      return;
    }
    for (const f of files) await settleOne(path.join(dir, f), test, afterSeconds, keep);
    return;
  }

  const id = str(args, "id");
  if (!id) throw new Error("Pass --id <requestId> (from pnpm authorize) or --all.");
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) throw new Error(`No pending authorization at ${file}`);
  await settleOne(file, test, afterSeconds, keep);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

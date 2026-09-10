/**
 * Run one (or --n) paid requests and print the five phases.
 *
 *   pnpm buyer --route /free --suite A --test A1 --n 20
 *   pnpm buyer --route /paid/exact --suite A --test A3 --n 20
 *   pnpm buyer --route /paid/exact --suite A --test A2 --n 100 --no-pay   # 402 only, free
 *   pnpm buyer --route /paid/exact --suite E --test E2 --fault settle-block
 *   pnpm buyer --route /paid/exact-id --suite E --test E4 --payment-id pay_bench_0000000001 --n 2
 */
import { isFault, type Suite } from "@x402-bench/shared";
import { bool, fmt, isMain, num, parseArgs, str } from "./cli.ts";
import { createContext, paidRequest } from "./client.ts";
import { loadConfig } from "./config.ts";
import { appendRecord } from "./recorder.ts";
import { loadOrCreateAccount } from "./wallet.ts";

async function main(): Promise<void> {
  const args = parseArgs();
  const route = str(args, "route", "/paid/exact");
  const suite = str(args, "suite", "smoke") as Suite;
  const test = str(args, "test", route.replace(/^\//, "").replace(/\//g, "-"));
  const label = str(args, "label");
  const n = Math.max(1, Math.floor(num(args, "n", 1)));
  const faultArg = str(args, "fault");
  const fault = isFault(faultArg) ? faultArg : undefined;
  if (faultArg && !fault) throw new Error(`Unknown fault "${faultArg}". Use verify-block, settle-block, or handler-500.`);
  const paymentId = str(args, "payment-id");
  // A2: stop at the 402 instead of paying. Free, so it can run at any n.
  const noPay = bool(args, "no-pay");

  const cfg = loadConfig();
  const { account, created } = loadOrCreateAccount(cfg);
  if (created) console.log(`Generated a buyer key in .env. Fund ${account.address} before paid runs.\n`);
  const ctx = createContext(cfg, account);

  console.log(`seller=${cfg.sellerUrl} route=${route} suite=${suite} test=${test} n=${n}${fault ? ` fault=${fault}` : ""}${noPay ? " no-pay" : ""}`);
  console.log("   #  first final     T1     T2   paid     T3     T4     T5  total  result");

  let file = "";
  for (let i = 1; i <= n; i++) {
    const rec = await paidRequest(ctx, { route, suite, test, label, fault, paymentId, noPay });
    file = appendRecord(cfg, rec);
    const result = rec.error
      ? rec.error.slice(0, 60)
      : rec.receipt?.transaction
        ? `tx ${rec.receipt.transaction.slice(0, 12)}… amount=${rec.receipt.amount ?? rec.amount ?? "?"}`
        : rec.receipt?.errorReason ?? "";
    console.log(
      `${String(i).padStart(4)}  ${String(rec.firstStatus ?? "-").padStart(5)} ${String(rec.finalStatus ?? "-").padStart(5)} ` +
        `${fmt(rec.t1Ms)} ${fmt(rec.t2Ms)} ${fmt(rec.paidRoundTripMs)} ${fmt(rec.t3Ms)} ${fmt(rec.t4Ms)} ${fmt(rec.t5Ms)} ${fmt(rec.totalMs)}  ${result}`,
    );
  }
  console.log(`\nrecords appended to ${file}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

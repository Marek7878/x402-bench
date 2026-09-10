/**
 * Suite B load runner.
 *
 *   pnpm load --route /paid/exact --ramp 1,5,10,25,50,100 --seconds 20      # B1-B3
 *   pnpm load --route /paid/exact --hold 30m --concurrency 10               # B4
 *
 * Each level runs `concurrency` workers that issue paid requests back to back for
 * `seconds`. The summary shows achieved rps, error count, and the first error seen.
 */
import { round, type BuyerRecord, type Suite } from "@x402-bench/shared";
import { fmt, isMain, num, parseArgs, parseDurationSeconds, str } from "./cli.ts";
import { createContext, paidRequest, type BuyerContext } from "./client.ts";
import { loadConfig } from "./config.ts";
import { appendRecord } from "./recorder.ts";
import { loadOrCreateAccount } from "./wallet.ts";

interface LevelSummary {
  concurrency: number;
  seconds: number;
  requests: number;
  ok: number;
  errors: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  firstError?: string;
  statuses: Record<string, number>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function runLevel(
  ctx: BuyerContext,
  route: string,
  suite: Suite,
  test: string,
  concurrency: number,
  seconds: number,
  onRecord: (r: BuyerRecord) => void,
  onTick?: (elapsedS: number, done: number, errors: number) => void,
  /** Stop the level after this many requests. Guards the USDC budget on long holds. */
  maxRequests = Number.POSITIVE_INFINITY,
): Promise<LevelSummary> {
  const records: BuyerRecord[] = [];
  const deadline = performance.now() + seconds * 1000;
  const start = performance.now();
  let errors = 0;
  let firstError: string | undefined;
  let lastTick = 0;
  let started = 0;

  const worker = async (): Promise<void> => {
    while (performance.now() < deadline && started < maxRequests) {
      started += 1;
      const rec = await paidRequest(ctx, { route, suite, test, label: `c${concurrency}` });
      records.push(rec);
      onRecord(rec);
      const failed = rec.error !== undefined || (rec.finalStatus ?? 0) >= 400;
      if (failed) {
        errors++;
        firstError ??= `${new Date().toISOString()} status=${rec.finalStatus ?? "-"} ${rec.error ?? rec.receipt?.errorReason ?? ""}`.trim();
      }
      const elapsed = Math.floor((performance.now() - start) / 1000);
      if (onTick && elapsed >= lastTick + 60) {
        lastTick = elapsed;
        onTick(elapsed, records.length, errors);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedS = (performance.now() - start) / 1000;
  const totals = records.map((r) => r.totalMs).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const r of records) {
    const key = String(r.finalStatus ?? "err");
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  return {
    concurrency,
    seconds: round(elapsedS),
    requests: records.length,
    ok: records.length - errors,
    errors,
    rps: round(records.length / elapsedS),
    p50: percentile(totals, 50),
    p95: percentile(totals, 95),
    p99: percentile(totals, 99),
    firstError,
    statuses,
  };
}

function printSummary(s: LevelSummary): void {
  console.log(
    `  c=${String(s.concurrency).padStart(3)}  ${String(s.requests).padStart(5)} req in ${String(s.seconds).padStart(6)} s ` +
      `→ ${String(s.rps).padStart(6)} rps  ok=${s.ok} err=${s.errors}  p50=${fmt(s.p50)} p95=${fmt(s.p95)} p99=${fmt(s.p99)} ms  ` +
      `statuses=${JSON.stringify(s.statuses)}`,
  );
  if (s.firstError) console.log(`         first error: ${s.firstError}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const route = str(args, "route", "/paid/exact");
  const suite = str(args, "suite", "B") as Suite;
  const cfg = loadConfig();
  const { account } = loadOrCreateAccount(cfg);
  const ctx = createContext(cfg, account);
  const onRecord = (r: BuyerRecord): void => {
    appendRecord(cfg, r);
  };

  // Budget guard: every paid request spends EXACT_PRICE. A 30-minute hold at 10 rps is
  // 18,000 payments, so cap the run rather than discover the wallet is empty halfway.
  const maxRequests = num(args, "max-requests", Number.POSITIVE_INFINITY);

  const hold = str(args, "hold");
  if (hold) {
    const holdSeconds = parseDurationSeconds(hold);
    const concurrency = Math.max(1, Math.floor(num(args, "concurrency", 10)));
    const test = str(args, "test", "B4");
    const cap = Number.isFinite(maxRequests) ? `, at most ${maxRequests} requests` : "";
    console.log(`hold: ${route} at concurrency ${concurrency} for ${holdSeconds} s (${test})${cap}`);
    const summary = await runLevel(
      ctx,
      route,
      suite,
      test,
      concurrency,
      holdSeconds,
      onRecord,
      (elapsed, done, errors) => console.log(`  t+${elapsed}s  ${done} requests, ${errors} errors`),
      maxRequests,
    );
    printSummary(summary);
    return;
  }

  const ramp = str(args, "ramp", "1,5,10,25,50,100")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const seconds = num(args, "seconds", 20);
  const test = str(args, "test", "B1");
  // --repeat runs the whole ramp more than once, to tell a real limit from a one-off blip.
  const repeat = Math.max(1, Math.floor(num(args, "repeat", 1)));
  console.log(`ramp: ${route} levels=${ramp.join(",")} ${seconds} s each (${test})${repeat > 1 ? `, ${repeat} passes` : ""}`);
  const summaries: LevelSummary[] = [];
  for (let pass = 1; pass <= repeat; pass++) {
    if (repeat > 1) console.log(`  pass ${pass}/${repeat}`);
    for (const concurrency of ramp) {
      const s = await runLevel(ctx, route, suite, test, concurrency, seconds, onRecord, undefined, maxRequests);
      printSummary(s);
      summaries.push(s);
    }
  }
  const best = summaries.filter((s) => s.errors === 0).sort((a, b) => b.rps - a.rps)[0];
  const firstFailing = summaries.find((s) => s.errors > 0);
  console.log("");
  console.log(`max error-free rate: ${best ? `${best.rps} rps at concurrency ${best.concurrency}` : "none"}`);
  if (firstFailing) console.log(`errors first appeared at concurrency ${firstFailing.concurrency}: ${firstFailing.firstError ?? ""}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

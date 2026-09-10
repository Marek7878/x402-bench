/**
 * Summarise results/*.jsonl into a markdown report.
 *
 *   pnpm report                      # reads results/, writes results/report-<date>.md
 *   pnpm report --dir results --out results/report.md
 *
 * Reads buyer records (buyer-*.jsonl) and, if present, seller records saved with
 * `wrangler tail --format json > results/seller-tail.jsonl`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuyerRecord, SellerRecord } from "../packages/shared/src/index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

function percentile(values: number[], p: number): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function f(v: number | undefined): string {
  return v === undefined ? "–" : v.toFixed(0);
}

function loadRecords(dir: string): { buyer: BuyerRecord[]; seller: SellerRecord[] } {
  const buyer: BuyerRecord[] = [];
  const seller: SellerRecord[] = [];
  if (!existsSync(dir)) return { buyer, seller };
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const obj of jsonValues(readFileSync(path.join(dir, file), "utf8"))) {
      collect(obj, buyer, seller);
    }
  }
  return { buyer, seller };
}

/**
 * Yield every top-level JSON value in a file. Handles JSONL, one record per line, and
 * `wrangler tail --format json`, which pretty-prints each event across ~20 lines. Parsing
 * line by line silently dropped every seller record, leaving the seller section empty.
 */
function* jsonValues(text: string): Generator<unknown> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        try {
          yield JSON.parse(text.slice(start, i + 1));
        } catch {
          // A truncated or interleaved event. Skip it rather than lose the rest of the file.
        }
        start = -1;
      }
    }
  }
}

/** Accept plain records and `wrangler tail --format json` events that wrap console.log messages. */
function collect(obj: unknown, buyer: BuyerRecord[], seller: SellerRecord[]): void {
  if (!obj || typeof obj !== "object") return;
  const rec = obj as { kind?: string; logs?: Array<{ message?: unknown[] }> };
  if (rec.kind === "buyer") buyer.push(obj as BuyerRecord);
  else if (rec.kind === "seller") seller.push(obj as SellerRecord);
  else if (Array.isArray(rec.logs)) {
    const before = seller.length;
    for (const log of rec.logs) {
      for (const m of log.message ?? []) {
        if (typeof m === "string") {
          try {
            collect(JSON.parse(m), buyer, seller);
          } catch {
            // not JSON
          }
        } else collect(m, buyer, seller);
      }
    }
    // A tail event wraps one invocation and is the only place CPU time appears — a Worker cannot
    // measure its own CPU. Carry it onto the seller records inside, which is where H2 reads it.
    const ev = obj as { cpuTime?: number; wallTime?: number };
    if (typeof ev.cpuTime === "number") {
      for (let i = before; i < seller.length; i++) {
        const s = seller[i] as SellerRecord & { cpuTimeMs?: number; wallTimeMs?: number };
        s.cpuTimeMs = ev.cpuTime;
        s.wallTimeMs = ev.wallTime;
      }
    }
  }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** A2 measures the 402 itself, so for A2 a 402 is the success. Every other test wants a 2xx. */
function isOk(r: BuyerRecord): boolean {
  if (r.error !== undefined) return false;
  if (r.test === "A2") return r.finalStatus === 402;
  return (r.finalStatus ?? 0) < 400;
}

/**
 * Which seller answered. Local `wrangler dev` and the deployed Worker differ by roughly the
 * network round trip, so blending them understates the A1 baseline and overstates added latency.
 * Every latency figure is reported per host for that reason.
 */
function hostOf(r: BuyerRecord): string {
  try {
    return new URL(r.url).host;
  } catch {
    return "unknown";
  }
}

const isLocal = (host: string): boolean => host.startsWith("localhost") || host.startsWith("127.0.0.1");

function latencyTable(records: BuyerRecord[]): string[] {
  const lines = [
    "| suite | test | seller | n | ok | p50 total | p95 total | p99 total | p50 T1 | p50 T2 | p50 T3 verify | p50 T4 settle | p50 T5 | p95 T3 | p95 T4 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [key, group] of groupBy(records, (r) => `${r.suite}|${r.test}|${hostOf(r)}`)) {
    const [suite, test, host] = key.split("|");
    const ok = group.filter(isOk);
    const pick = (sel: (r: BuyerRecord) => number | undefined) => ok.map(sel).filter((v): v is number => v !== undefined);
    lines.push(
      `| ${suite} | ${test} | ${isLocal(host ?? "") ? "local" : "deployed"} | ${group.length} | ${ok.length} | ${f(percentile(pick((r) => r.totalMs), 50))} | ${f(
        percentile(pick((r) => r.totalMs), 95),
      )} | ${f(percentile(pick((r) => r.totalMs), 99))} | ${f(percentile(pick((r) => r.t1Ms), 50))} | ${f(
        percentile(pick((r) => r.t2Ms), 50),
      )} | ${f(percentile(pick((r) => r.t3Ms), 50))} | ${f(percentile(pick((r) => r.t4Ms), 50))} | ${f(
        percentile(pick((r) => r.t5Ms), 50),
      )} | ${f(percentile(pick((r) => r.t3Ms), 95))} | ${f(percentile(pick((r) => r.t4Ms), 95))} |`,
    );
  }
  return lines;
}

/**
 * The facilitator a test ran against, taken from the test-name suffix: `A3-cdp` and `B6-cdp` are
 * CDP; a bare `A3` or `B1` is whatever FACILITATOR_PROVIDER was at the time, which is the public
 * facilitator for every run before CDP was wired. The suffix must follow a digit so that
 * `B-smoke` and `B-serial` — early smoke runs, not facilitator variants — fall through to the
 * default instead of inventing a facilitator named "smoke".
 *
 * Results have to be grouped by facilitator: the two differ by more than a second per request and
 * by an order of magnitude in throughput, so mixing them invents numbers that describe neither.
 */
function variantOf(test: string | undefined): string {
  const m = /^[A-Z][0-9]+-(.+)$/.exec(test ?? "");
  return m ? (m[1] as string) : "public";
}

const VARIANT_LABEL: Record<string, string> = {
  public: "public facilitator",
  cdp: "CDP facilitator",
  "cdp-deployed": "CDP facilitator, deployed Worker",
};

function addedLatency(records: BuyerRecord[]): string[] {
  const a = records.filter((r) => r.suite === "A" && isOk(r));
  // Every Suite A record, successes included and failures too. The percentiles below are computed
  // over successful requests only — a failed payment has no meaningful latency — which means a
  // latency verdict on its own hides how often the payment simply did not happen. For a machine
  // that dispenses a snack, a 402 the customer cannot explain is worse than a slow success, so the
  // success rate is reported next to the verdict rather than left for the reader to find.
  const allA = records.filter((r) => r.suite === "A");
  const hosts = [...new Set(a.map(hostOf))].sort((x, y) => Number(isLocal(x)) - Number(isLocal(y)));
  const variants = [...new Set(a.map((r) => variantOf(r.test)))].sort();
  const out: string[] = [];
  for (const host of hosts) {
    for (const variant of variants) {
      const inGroup = (n: number) => (r: BuyerRecord) =>
        r.test?.startsWith(`A${n}`) && variantOf(r.test) === variant && hostOf(r) === host;
      const a1 = a.filter(inGroup(1)).map((r) => r.totalMs);
      const a3 = a.filter(inGroup(3)).map((r) => r.totalMs);
      if (a1.length === 0 || a3.length === 0) continue;
      const rows = [50, 95, 99].map((p) => {
        const base = percentile(a1, p);
        const paid = percentile(a3, p);
        const added = base !== undefined && paid !== undefined ? paid - base : undefined;
        return `| p${p} | ${f(base)} | ${f(paid)} | ${f(added)} |`;
      });
      const p95Added = (percentile(a3, 95) ?? 0) - (percentile(a1, 95) ?? 0);
      const attempted = allA.filter(
        (r) => r.test?.startsWith("A3") && variantOf(r.test) === variant && hostOf(r) === host,
      );
      const delivered = attempted.filter((r) => r.finalStatus === 200).length;
      const rate = attempted.length > 0 ? (delivered / attempted.length) * 100 : 0;
      out.push(
        `### ${isLocal(host) ? "Local `wrangler dev`" : "Deployed Worker"} — \`${host}\`, ${
          VARIANT_LABEL[variant] ?? variant
        }`,
        "",
        "| percentile | A1 baseline ms | A3 paid ms | added ms |",
        "|---|---|---|---|",
        ...rows,
        "",
        `**Go/no-go (added latency p95 < 2000 ms): ${p95Added < 2000 ? "PASS" : "FAIL"}** ` +
          `(${p95Added.toFixed(0)} ms, A1 n=${a1.length}, A3 n=${a3.length})`,
        "",
        `**Paid requests delivered: ${delivered}/${attempted.length} (${rate.toFixed(1)} %).** ` +
          (rate === 100
            ? "Every payment succeeded, so the latency above describes the whole population."
            : `The ${attempted.length - delivered} that failed returned 402 with an empty body and are excluded from the ` +
              "percentiles, so read the latency verdict as conditional on the payment working at all. These were " +
              "sequential single requests — concurrency 1 — so this is a floor on the failure rate, not a load effect."),
        "",
      );
    }
  }
  if (out.length === 0) return ["_Needs A1 (free) and A3 (paid) records from the same seller to compute added latency._"];

  // The same-host comparison is the only one that isolates the facilitator. Reading the deployed
  // public figure against the local CDP figure confounds two variables at once, so compute the
  // local-vs-local delta explicitly rather than leaving the reader to subtract across tables.
  const localAdded = (variant: string): number | undefined => {
    const pick = (n: number) =>
      a.filter((r) => r.test?.startsWith(`A${n}`) && variantOf(r.test) === variant && isLocal(hostOf(r))).map((r) => r.totalMs);
    const base = percentile(pick(1), 95);
    const paid = percentile(pick(3), 95);
    return base !== undefined && paid !== undefined ? paid - base : undefined;
  };
  const pub = localAdded("public");
  const cdp = localAdded("cdp");
  const deployedPub = (() => {
    const pick = (n: number) =>
      a.filter((r) => r.test?.startsWith(`A${n}`) && variantOf(r.test) === "public" && !isLocal(hostOf(r))).map((r) => r.totalMs);
    const base = percentile(pick(1), 95);
    const paid = percentile(pick(3), 95);
    return base !== undefined && paid !== undefined ? paid - base : undefined;
  })();
  if (pub !== undefined && cdp !== undefined) {
    out.push(
      "### What the facilitator alone costs",
      "",
      "| comparison | added p95 ms | what differs |",
      "|---|---|---|",
      `| local public \u2192 local CDP | **+${(cdp - pub).toFixed(0)}** | the facilitator, and nothing else |`,
      ...(deployedPub !== undefined
        ? [`| local public \u2192 deployed public | +${(deployedPub - pub).toFixed(0)} | the host, and nothing else |`]
        : []),
      "",
      `Same machine, same buyer, same route: switching facilitator adds **${(cdp - pub).toFixed(0)} ms** at p95. ` +
        (deployedPub !== undefined
          ? `Moving from local dev to the deployed Worker adds only ${(deployedPub - pub).toFixed(0)} ms, so the host is ` +
            `close to free by comparison and CDP on the deployed Worker would land near ` +
            `**${(cdp + (deployedPub - pub)).toFixed(0)} ms** \u2014 still over the 2000 ms threshold. The FAIL does not depend ` +
            "on where the seller runs."
          : ""),
      "",
    );
  }
  return out;
}

/**
 * Suite B. The load runner's own rps counts every request including the ones whose payment
 * failed, which flatters the result badly: 61 rps at concurrency 100 was 95 % failures. The
 * number the go/no-go criterion needs is goodput — payments that actually settled, per second.
 */
function suiteB(records: BuyerRecord[]): string[] {
  const b = records.filter((r) => r.suite === "B" && r.label?.startsWith("c"));
  if (b.length === 0) return ["_No Suite B records yet._"];
  const conc = (r: BuyerRecord): number => Number(String(r.label ?? "").replace(/^c/, "")) || 0;
  const lines = [
    "| test | seller | concurrency | n | settled | failed | success % | window s | req/s | settled/s | p50 ms | p95 ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  // Best goodput is tracked per facilitator, not globally. The two services differ by more than
  // an order of magnitude, so a single headline number would report whichever one happened to be
  // faster and silently attribute it to x402 rather than to the service that produced it.
  const best = new Map<string, { goodput: number; at: number }>();
  for (const [key, group] of groupBy(b, (r) => `${r.test}|${hostOf(r)}|${String(conc(r)).padStart(4, "0")}`)) {
    const [test, host] = key.split("|");
    const c = conc(group[0] as BuyerRecord);
    const settled = group.filter((r) => r.receipt?.success === true && Boolean(r.receipt.transaction)).length;
    const starts = group.map((r) => new Date(r.startedAt).getTime());
    const ends = group.map((r, i) => (starts[i] ?? 0) + (r.totalMs ?? 0));
    const windowS = (Math.max(...ends) - Math.min(...starts)) / 1000;
    const totals = group.map((r) => r.totalMs).filter((v): v is number => v !== undefined);
    const goodput = windowS > 0 ? settled / windowS : 0;
    const variant = variantOf(test);
    if (goodput > (best.get(variant)?.goodput ?? 0)) best.set(variant, { goodput, at: c });
    lines.push(
      `| ${test} | ${isLocal(host ?? "") ? "local" : "deployed"} | ${c} | ${group.length} | ${settled} | ${
        group.length - settled
      } | ${((settled / group.length) * 100).toFixed(1)} | ${windowS.toFixed(1)} | ${(group.length / windowS).toFixed(2)} | ${goodput.toFixed(
        2,
      )} | ${f(percentile(totals, 50))} | ${f(percentile(totals, 95))} |`,
    );
  }
  const verdicts = [...best.entries()].sort().flatMap(([variant, v]) => [
    `**${VARIANT_LABEL[variant] ?? variant} — go/no-go (sustained rate > 10 rps): ${
      v.goodput > 10 ? "PASS" : "FAIL"
    }** — peak ${v.goodput.toFixed(2)} settled payments/s at concurrency ${v.at}.`,
    "",
  ]);
  return [
    ...lines,
    "",
    "Goodput is settled payments per second. Raw request throughput runs far higher, but the extra" +
      " requests returned 402 with no content and moved no money, so they are not served traffic" +
      " and counting them would turn a 95 % failure rate into an apparent pass.",
    "",
    ...verdicts,
    "Criterion B is a property of the facilitator, not of x402. Read the two rows above together:" +
      " the protocol sustains the required rate, and the public facilitator does not.",
    "",
    "**B4 hold on CDP, deployed Worker (`B4-cdp-deployed`, 8 Sep 14:29–14:52 UTC, launched manually).**",
    "Concurrency 20 against the CDP preview, capped at 18,000 requests. For the first **21.4 minutes** it ran at",
    "**9.91 requests/s with 12,692 of 12,692 settled and zero errors**, p50 2001 ms, p95 2244 ms, p99 3373 ms — no",
    "warm-up, no decay. The row above shows 12,712 requests because the run then hit the wall we built, not one",
    "in x402: at 14:50:54 UTC the buyer wallet's testnet USDC ran out (the hold alone spent 12.69 USDC), and every",
    "later request was refused at verify with `invalid_payload: contract call failed` — 5,288 such records are",
    "quarantined as a funding artifact (`results/quarantine/README.md`), since they measure our wallet, not the",
    "service. **The 18 failures that stay in the row are the interesting ones.** They are the requests in flight",
    "at the instant the balance crossed zero: verify passed, the handler ran, and the settlement transaction was",
    "mined and **reverted** (`settle_exact_failed_onchain`, tx hashes recorded). The buyer received a 402 and no",
    "content, so nothing was delivered unpaid — criterion E still holds — but it shows that verify is a",
    "point-in-time balance check and twenty concurrent settlements can race past it. A seller that delivered on",
    "verify alone would have given away 18 items in 300 ms. Design change 1 (gate on settlement) covers it.",
    "The hold ended 8.6 minutes short of the planned 30 because the request cap and the wallet ran out together;",
    "the 21-minute flat window is what we have and it is reported as such.",
  ];
}

/**
 * Suite H2. A Worker cannot measure its own CPU time — its clock only advances across I/O — so
 * this comes from the `cpuTime` on each `wrangler tail` event, attached in collect().
 */
function suiteH2(seller: SellerRecord[]): string[] {
  type WithCpu = SellerRecord & { cpuTimeMs?: number; wallTimeMs?: number };
  const withCpu = (seller as WithCpu[]).filter((s) => typeof s.cpuTimeMs === "number");
  if (withCpu.length === 0) {
    return ["_No CPU times. Capture `wrangler tail --format json` during a run to populate H2._"];
  }
  const kind = (s: WithCpu): string =>
    s.path === "/free" ? "free baseline" : s.hasPaymentHeader ? "paid (verify + settle)" : "unpaid → 402";
  const lines = [
    "| request kind | n | p50 CPU ms | p95 CPU ms | max CPU ms | p50 wall ms |",
    "|---|---|---|---|---|---|",
  ];
  let max = 0;
  for (const [k, group] of groupBy(withCpu, kind)) {
    const cpu = group.map((s) => s.cpuTimeMs).filter((v): v is number => v !== undefined);
    const wall = group.map((s) => s.wallTimeMs).filter((v): v is number => v !== undefined);
    max = Math.max(max, ...cpu);
    lines.push(
      `| ${k} | ${group.length} | ${f(percentile(cpu, 50))} | ${f(percentile(cpu, 95))} | ${f(Math.max(...cpu))} | ${f(
        percentile(wall, 50),
      )} |`,
    );
  }
  return [
    ...lines,
    "",
    `Worst CPU seen: **${max} ms**. The Workers **Paid** limit is 30,000 ms per invocation, so CPU is` +
      " not a constraint: the Worker spends its time waiting on the facilitator, not computing." +
      ` Worth noting for anyone tempted by the Free plan, whose limit is 10 ms — ${max} ms would breach it.`,
  ];
}

function suiteD(records: BuyerRecord[]): string[] {
  const d = records.filter((r) => r.suite === "D").sort((a, b) => (a.holdSeconds ?? 0) - (b.holdSeconds ?? 0));
  if (d.length === 0) return ["_No Suite D records yet._"];
  const lines = [
    "| test | seller | hold (s) | maxTimeoutSeconds | authorized max | settled amount | status | settle ok | tx | error |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of d) {
    lines.push(
      `| ${r.test} | ${isLocal(hostOf(r)) ? "local" : "deployed"} | ${r.holdSeconds ?? "–"} | ${r.maxTimeoutSeconds ?? "–"} | ${r.amount ?? "–"} | ${r.receipt?.amount ?? "–"} | ${
        r.finalStatus ?? "–"
      } | ${r.receipt?.success ?? "–"} | ${r.receipt?.transaction ? r.receipt.transaction.slice(0, 14) + "…" : "–"} | ${
        (r.error ?? r.receipt?.errorReason ?? "").slice(0, 80)
      } |`,
    );
  }
  const longestOk = Math.max(0, ...d.filter((r) => r.receipt?.success).map((r) => r.holdSeconds ?? 0));
  lines.push(
    "",
    `Longest successful authorization-to-settlement hold: **${longestOk} s** (${(longestOk / 3600).toFixed(1)} h). Go/no-go needs \u2265 86400 s.`,
    "",
    "**`upto` on CDP fails on a deployed Worker, 15 times out of 18, with `No matching payment requirements`.**",
    "The same route, wallet and client settle every time on the public facilitator, and `exact` on the same CDP",
    "preview delivered 1,420 of 1,420 the same day. The cause is visible in the 402s themselves: ten unpaid requests",
    "to the CDP preview's `/paid/upto` returned **five different `extra.facilitatorAddress` values** (CDP's",
    "`/supported` hands each Worker isolate a different wallet from its pool, and the isolate bakes it into its",
    "requirements), while the public facilitator's 402 always carries its one address. The buyer signs a Permit2",
    "authorization for the address in the 402 it received; the retry lands on a different isolate whose",
    "requirements name a different address, and `@x402/core`'s `paymentRequirementsMatchAccepted` compares `extra`",
    "field by field (`upto` declares no `dynamicExtraFields`), so the payment is refused before verify — free, no",
    "gas, but no sale. It succeeded only when the retry happened to hit the isolate that issued the 402. On a",
    "single-isolate local seller this cannot happen, which is why the 7 Sep CDP runs never saw it. **Two",
    "consequences.** The memo's `upto`-on-CDP recommendation is conditional on a fix none of our configuration",
    "provides today: either the seller pins one `facilitatorAddress` across isolates (a shared cache of",
    "`/supported`, which also forces every settlement through one CDP wallet, with unknown effect on throughput), or",
    "the SDK/CDP treat the address as dynamic. Until one is tested, `exact` is the only scheme with 100 % delivery",
    "on CDP. Also seen once: `amount_too_low` from CDP's settle for a zero-amount `upto` settlement, which the public",
    "facilitator accepts (D2) — so the \"free release\" pattern may not be portable either.",
    "",
    "**Reading this table.** Rows without a hold are immediate settlements testing amount semantics,",
    "not the window: D1 settles the full authorized maximum, and the two D2 rows settle 40 % and 0.",
    "A zero settlement returns `success: true` with an empty transaction and touches no chain, so",
    "reconciliation has to read `amount` and `transaction` rather than the success flag alone.",
    "",
    "`D-postdeploy-smoke` rows are not window tests. They verify the Worker still serves `/paid/upto`",
    "after a redeploy, which matters because the deployed Worker holds authorizations that must stay",
    "settleable for 48 h. One of the four failed inside the facilitator's own `eth_sendRawTransaction`",
    "and the next three succeeded, which is the public facilitator's known flakiness rather than a",
    "regression \u2014 that is exactly why the smoke test repeats.",
    "",
    "**There is no 1 h failure.** An earlier version of this report showed a failed 3600 s row here and",
    "called it unattributable. It has since been traced and quarantined: it shared both its",
    "`requestId` and its `authorizedAt` with the D3 row that settled 73 s after authorization, so it",
    "was one authorization settled once and then presented a second time an hour later. `upto` is",
    "Permit2 and permits a single settlement per nonce, so verify refused it \u2014 correctly, and for free.",
    "That belongs to D6, not to the window test, and it is excluded with the reason written up in",
    "`results/quarantine/README.md`. Every 1 h hold in this table succeeded.",
    "",
    "The 15.9 h hold was a 6 h target that fired late because the machine slept; it was settled",
    "immediately on discovery rather than discarded, and the elapsed time reported is the real one.",
    "",
    "**Criterion D: the 24 h authorization settled after 87,114 s (24.2 h) — PASS.** Signed 7 Sep 15:38 UTC",
    "against the deployed seller (public facilitator), `maxTimeoutSeconds` 172,800, presented 8 Sep 15:50 UTC,",
    "settled 10,000 atomic units in one transaction. Presented again three minutes later (D6 on the same nonce)",
    "it was refused at verify with `permit2_simulation_failed` — the one-settlement-per-nonce rule holds at 24 h",
    "as it did at 73 s. **What the first attempt taught us.** The settler fired on time at 15:38 UTC and got a",
    "bare 402. Two re-presentations failed the same way, and the live Worker's tail gave the reason:",
    "`permit2_insufficient_balance`. The Suite B hold that afternoon had spent the wallet's testnet USDC down to",
    "0.000998, so the failure was ours, not the protocol's: a fresh `upto` control failed identically. Those four",
    "records are quarantined as a funding artifact rather than counted as a criterion result; the wallet was",
    "refilled from the CDP faucet (5 USDC) and the same authorization settled eleven minutes later. Two",
    "operational lessons for the vending machine: a held authorization is only as good as the buyer's balance at",
    "settle time, so the machine must check balance (or settle) before it dispenses; and the buyer harness now",
    "records the seller's 402 reason (`PAYMENT-REQUIRED` header) so an empty body is never the last word again.",
    "",
    "**The 40 h authorization settled too — after 145,780 s (40.5 h), tx `0x8298c858…`, 10,000 units in one",
    "transaction, T3 236 ms, T4 738 ms.** Signed 7 Sep 15:38 UTC alongside the 24 h one (same `maxTimeoutSeconds`",
    "172,800, so its Permit2 deadline was 9 Sep 15:38 UTC). The target was 40 h (9 Sep 07:38 UTC); the settler ran",
    "on a cloud VM that the provider hibernated after four idle hours, so the poll fired on wake at 08:08 UTC and",
    "the elapsed time reported is the real one, half an hour past the target. It makes the result stronger, not",
    "weaker: 40.5 h is the longest hold in the bench and still 7.5 h inside the 48 h window. Together with the 24 h",
    "row it shows the window is set by the seller's `maxTimeoutSeconds` and honoured by the facilitator and the",
    "Permit2 proxy for at least 40 h; nothing in the chain shortened it.",
    "",
    "**D5 closes the window from the other side: presented at 49 h (176,400 s, one hour past the 48 h deadline) the",
    "authorization was refused at verify with `permit2_deadline_expired` — T3 190 ms, settle never attempted, no",
    "transaction, no gas, 402 to the buyer.** So the window is exactly what the seller's `maxTimeoutSeconds` says:",
    "honoured at 24.2 h and 40.5 h, refused at 49 h, and the refusal is cheap and unambiguous (the reason names the",
    "deadline rather than a generic failure). For the reservation design this means an expired reservation cannot be",
    "charged by accident, and the machine can distinguish \"expired\" from \"insufficient balance\"",
    "(`permit2_insufficient_balance`, seen on 8 Sep) from the same header. **Criterion D: PASS, bounded on both sides.**",
  );
  return lines;
}

/**
 * Suite F. A compatibility matrix, with the rows we actually exercised marked as measured and the
 * rest named rather than quietly dropped — a matrix that silently omits what was not tested reads
 * as "incompatible" to anyone skimming it.
 */
function suiteF(records: BuyerRecord[]): string[] {
  const f = records.filter((r) => r.suite === "F");
  const rows: string[] = [
    "| test | client | transport | result | evidence |",
    "|---|---|---|---|---|",
  ];

  const LABELS: Record<string, { client: string; transport: string }> = {
    F1: { client: "`@x402/fetch`", transport: "HTTP headers" },
    "F2-F3": { client: "Agents SDK `withX402` / `withX402Client`", transport: "MCP `_meta` (JSON-RPC)" },
    F6: { client: "`mppx` (Machine Payments Protocol)", transport: "HTTP headers, `--protocol x402`" },
  };

  for (const [test, group] of groupBy(f, (r) => r.test)) {
    const ok = group.filter((r) => r.finalStatus === 200).length;
    const tx = group.find((r) => r.receipt?.transaction)?.receipt?.transaction;
    const meta = LABELS[test] ?? { client: test, transport: "–" };
    rows.push(
      `| ${test} | ${meta.client} | ${meta.transport} | ${ok > 0 ? "**works**" : "fails"} | ${ok}/${group.length} paid` +
        `${tx ? `, tx \`${tx.slice(0, 12)}…\`` : ""} |`,
    );
  }

  if (f.length === 0) rows.push("| – | – | – | _no records_ | – |");

  return [
    ...rows,
    "",
    "**F2 and F3 are one integration, not two.** `agents/x402` exports both halves: `withX402(server)`",
    "adds the `paidTool` method and `withX402Client(client)` pays for what it exposes. Neither can be",
    "exercised without the other, so the plan's two rows collapse into one.",
    "",
    "**F4 (Claude Code hook, OpenCode plugin) is not a client.** Both are user-authored files that wrap",
    "`@x402/fetch` and adapt it to a coding agent's tool surface — there is no package to install. Its",
    "payment path is therefore F1's, already measured, and nothing in the protocol path is new. What is",
    "new is operational: the wallet key lives in the agent's environment as `X402_PRIVATE_KEY` and the",
    "hook pays on a 402 automatically, so the spending policy is the whole security control. Not run",
    "here, because installing an auto-paying hook is a change to the operator's own machine.",
    "",
    "**F5 (Coinbase CDP tooling) is facilitator-side only.** `@coinbase/x402` exports",
    "`createFacilitatorConfig` / `createCdpAuthHeaders` and no client or wallet helper, so there is no",
    "CDP *client* to test against the endpoint. The CDP integration that does exist is verified",
    "thoroughly elsewhere in this report: it authenticated, advertised 26 kinds, and settled every",
    "payment in the Suite B re-run. Paying *from* a CDP-managed wallet would mean using",
    "`@coinbase/cdp-sdk` server wallets as the signer, which is a different integration and untested.",
    "",
    "**F6 confirms the backward-compatibility claim.** The MPP CLI paid the seller with no change to",
    "the seller at all, and translated our 402 into MPP's own vocabulary — `intent: charge`,",
    "`method: evm`, `realm` — which is the documented mapping of MPP's charge intent onto x402",
    "`exact`, observed rather than taken on trust.",
    "",
    "**Setup effort, as measured.** `@x402/fetch` is a one-line fetch wrapper. The MCP integration",
    "cost the most: MCP carries payment in JSON-RPC `_meta` rather than HTTP headers, so it needs a",
    "real MCP server and cannot reuse an HTTP route, and a per-session transport is mandatory — a",
    "fresh transport per request loses the `initialize` handshake and the tool call is refused before",
    "payment is ever attempted. `mppx` needed no code, only a key in the environment.",
    "",
    "**A dependency conflict worth knowing about.** `agents` declares `zod ^4` while `@x402/core`",
    "declares `zod ^3`. pnpm's isolated layout gives each its own copy and everything works; a flat",
    "`node_modules` (npm, yarn) would hoist one, and any Zod schema crossing that boundary meets a",
    "different Zod instance. The MCP tool here uses an empty parameter schema, so this bench does not",
    "prove the schema path is safe under a flat install.",
  ];
}

function suiteE(records: BuyerRecord[]): string[] {
  const e = records.filter((r) => r.suite === "E");
  if (e.length === 0) return ["_No Suite E records yet._"];
  const lines = [
    "| test | case | fault | n | final status | client error | money moved | tx |",
    "|---|---|---|---|---|---|---|---|",
  ];
  // One row per distinct outcome, not per test: a test like E3 or E4 deliberately produces a
  // success and a rejection, and collapsing them to the last record hides half the result.
  const moneyMoved = (r: BuyerRecord): boolean => r.receipt?.success === true && Boolean(r.receipt.transaction);
  for (const [, group] of groupBy(e, (r) => `${r.test}|${r.label ?? ""}|${r.fault ?? ""}`)) {
    const outcomes = groupBy(group, (r) => `${r.finalStatus ?? "-"}|${moneyMoved(r)}|${reasonOf(r)}`);
    for (const [, same] of outcomes) {
      const r = same[same.length - 1]!;
      lines.push(
        `| ${r.test} | ${r.label ?? "–"} | ${r.fault ?? "–"} | ${same.length} | ${r.finalStatus ?? "–"} | ${reasonOf(r).slice(0, 70) || "–"} | ${
          moneyMoved(r) ? "**yes**" : "no"
        } | ${r.receipt?.transaction ? r.receipt.transaction.slice(0, 14) + "…" : "–"} |`,
      );
    }
  }
  return [
    ...lines,
    "",
    'A tx hash beside "money moved: no" is not a contradiction: the facilitator broadcast a',
    "transaction that was mined and then reverted, so it consumed gas but emitted no Transfer. The",
    "E3 replay is the case that does this — verified on chain as status 0x0 with zero logs, in the",
    "same block as the legitimate settlement it replayed.",
    "",
    "Every rejection in this table failed closed: no case delivered content without moving money,",
    "and no case moved money without delivering content.",
    "",
    "**Re-run against CDP on 8 Sep (`*-cdp` rows, local dev with faults, CDP facilitator): all nine cases fail closed",
    "again, and two behave differently from the public facilitator.** The `exact` **replay** (E3) is refused at",
    "**verify** — `invalid_payload: contract call failed: execution reverted`, 466 ms, nothing broadcast — where the",
    "public facilitator passed verify, broadcast it, and burned 40,883 gas on a reverted transaction. The **empty",
    "wallet** (E5) is refused the same way. So CDP simulates the transfer at verify and the public facilitator does",
    "not; design change 1 (gate on settlement, not verify) stands regardless, because it must hold on every",
    "facilitator, but the gas-burning replay is a public-facilitator property. Settle-block (E2) timed out at our",
    "10 s facilitator timeout → 502, no settlement, buyer not charged; handler 500 (E8) → settlement cancelled;",
    "duplicate payment id (E4) → `duplicate_payment_id`; wrong network (E6) refused before verify; corrupt",
    "signature (E7) → `invalid_exact_evm_payload_signature`.",
  ];
}

/** The most specific reason a request failed: facilitator reason first, then the raw error. */
function reasonOf(r: BuyerRecord): string {
  if (r.receipt?.errorReason) return r.receipt.errorReason;
  if (!r.error) return r.finalStatus === 200 ? "delivered" : "";
  // Strip the "HTTP 402: {...}" wrapper the buyer adds when the body carries nothing useful.
  const stripped = r.error.replace(/^HTTP \d+:\s*/, "").trim();
  return stripped === "{}" ? `HTTP ${r.finalStatus}` : stripped.replace(/\s+/g, " ");
}

/**
 * Why settlements failed, grouped by cause.
 *
 * Criterion B fails on the public facilitator because settlement serialises behind one wallet's
 * nonce, and this is the table that shows it rather than asserting it.
 *
 * The cause has to be read off the `Details:` line, not the first line. Every one of these errors
 * opens with the same generic `invalid_exact_evm_transaction_failed: Missing or invalid
 * parameters.`, which is viem's wrapper and says nothing; the RPC's own message — `replacement
 * transaction underpriced`, `over rate limit`, `nonce too low` — appears further down. Grouping on
 * the first line labels 79 % of failures with a sentence that describes none of them.
 */
function settleFailureCauses(seller: SellerRecord[]): string[] {
  const failed = seller.filter((s) => s.settleOk === false);
  if (failed.length === 0) return [];
  const counts = new Map<string, number>();
  for (const s of failed) {
    const raw = s.settleError ?? "";
    const details = /^\s*Details:\s*(.+)$/m.exec(raw)?.[1];
    const cause = (details ?? raw.split("\n")[0] ?? "(no message)")
      .replace(/^SettleError:\s*/, "")
      .replace(/0x[0-9a-fA-F]{6,}/g, "0x…")
      // Nonce numbers are unique per occurrence and would split one cause into hundreds of rows.
      .replace(/\b\d{5,}\b/g, "N")
      .replace(/https?:\/\/\S+/g, "<url>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const pct = (n: number) => `${((n / failed.length) * 100).toFixed(1)} %`;
  const lines = [
    "## Settlement failures by cause",
    "",
    `${failed.length} settlement failures, by the RPC's own message rather than the SDK's generic wrapper.`,
    "",
    "| cause | n | share of failures |",
    "|---|---|---|",
    ...rows.map(([cause, n]) => `| ${cause || "(empty)"} | ${n} | ${pct(n)} |`),
    "",
  ];
  const underpriced = rows.find(([cause]) => /underpriced/.test(cause));
  if (underpriced) {
    lines.push(
      `\`replacement transaction underpriced\` is ${pct(underpriced[1])} of all settlement failures, and it is a nonce ` +
        "collision: two settlements racing for the same slot in one wallet's transaction sequence. It is not a signature, " +
        "balance or authorization problem — the payments were valid and the facilitator simply could not broadcast them " +
        "fast enough one after another. This single row is criterion B's failure on the public facilitator, and it is a " +
        "property of settling every payment in the world from one address.",
      "",
    );
  }
  // The signature row is worth its own paragraph because it looks like a client bug and is not one.
  // Everything asserted here is recomputed from the records so it cannot go stale.
  const sigFails = failed.filter((s) => /invalid_exact_evm_signature/.test(s.settleError ?? ""));
  if (sigFails.length > 0) {
    const verified = sigFails.filter((s) => s.verifyOk === true).length;
    // A `Details:` line only appears when the facilitator actually dialled the RPC, so its absence
    // means the rejection was local — the payment was never broadcast and never touched the chain.
    const noRpc = sigFails.filter((s) => !/^\s*Details:/m.test(s.settleError ?? "")).length;
    const windows = [...new Set(sigFails.map((s) => s.maxTimeoutSeconds).filter((v): v is number => v !== undefined))];
    lines.push(
      `**\`invalid_exact_evm_signature\` is not a client bug, and it is the one row here we cannot explain.** ` +
        `${verified} of these ${sigFails.length} payments passed the *same* facilitator's \`/verify\` moments earlier, ` +
        `and ${noRpc} of them carry no RPC \`Details:\` line, meaning the facilitator rejected them locally without ever ` +
        "broadcasting. So the facilitator contradicted its own verify. Expiry is ruled out: the authorization window was " +
        `${windows.join("/")} s and no failing settlement in this table took longer than ` +
        `${Math.max(...failed.map((s) => s.totalMs ?? 0)).toFixed(0)} ms. ` +
        "Nonce reuse is ruled out too — that fails on chain, with an RPC round trip, and appears separately in this table. " +
        "These rejections are also *faster* than successful settlements, which is what a local bail-out looks like. Only " +
        "the facilitator's own logs can close this out.",
      "",
      "Operationally the lesson is the actionable part: **do not read `invalid_exact_evm_signature` at settle as a signing " +
        "bug.** The label points at the client, and the client is the one component these records exonerate — the same " +
        "signature had just been accepted. A reconciliation process that trusts the label will send an engineer to the " +
        "wrong codebase.",
      "",
    );
  }

  const rateLimited = rows.find(([cause]) => /rate limit/.test(cause));
  if (rateLimited) {
    lines.push(
      `A second, separate ceiling sits behind it: ${rateLimited[1]} failures (${pct(rateLimited[1])}) are \`over rate ` +
        "limit\` from the public Base Sepolia RPC the facilitator dials. Even a facilitator that fixed its nonce " +
        "serialisation would still meet that limit, so the two are independent and both are the vendor's to solve.",
      "",
    );
  }
  return lines;
}


interface GasRow {
  test: string;
  tx: string;
  status: string;
  gasUsed: number;
  totalFeeEth: number;
  l1FeeEth: number;
  gasPayer: string;
  transfers: { from: string; to: string; usdc: string }[];
}

/**
 * C1/C2 on Base mainnet: the buyer records give the timing, results/mainnet-gas.json (written by
 * `pnpm gas`, read back from the chain) gives gas, fee and who paid it. Rendered per batch — the
 * plan asks for three times of day — and never blended with the testnet figures above.
 */
function suiteC1Mainnet(records: BuyerRecord[]): string[] {
  const m = records.filter((r) => r.network === "eip155:8453" && r.suite === "C" && (r.test ?? "").startsWith("C1"));
  const a1 = records.filter((r) => r.network === "eip155:8453" && r.test === "A1-mainnet");
  const out: string[] = ["### C1/C2 — Base mainnet settlements through CDP (real USDC)", ""];
  if (m.length === 0) {
    out.push("_No mainnet C1 records yet. Needs the mainnet Worker (`wrangler deploy --env mainnet`) and a funded buyer._");
    return out;
  }
  const gasPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../results/mainnet-gas.json");
  const gasFile = existsSync(gasPath)
    ? (JSON.parse(readFileSync(gasPath, "utf8")) as { ethUsd: number | null; fetchedAt: string; rows: GasRow[] })
    : undefined;
  const gasByTx = new Map((gasFile?.rows ?? []).map((g) => [g.tx, g]));
  const ethUsd = gasFile?.ethUsd ?? null;
  const usd = (eth: number): string => (ethUsd ? `$${(eth * ethUsd).toFixed(4)}` : "–");
  out.push(
    "| batch (UTC) | n | delivered | total p50 ms | total p95 ms | verify p50 | settle p50 | settle p95 | gas/settle p50 | fee/settle p50 | fee/settle USD |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  const allTotals: number[] = [];
  for (const [test, g] of groupBy(m, (r) => r.test ?? "?")) {
    const ok = g.filter((r) => r.finalStatus === 200 && r.receipt?.success);
    const totals = ok.map((r) => r.totalMs).filter((v): v is number => v !== undefined);
    allTotals.push(...totals);
    const t3 = ok.map((r) => r.t3Ms).filter((v): v is number => v !== undefined);
    const t4 = ok.map((r) => r.t4Ms).filter((v): v is number => v !== undefined);
    const gas = ok.map((r) => gasByTx.get(r.receipt?.transaction ?? "")).filter((v): v is GasRow => Boolean(v));
    const gasUsed = gas.map((x) => x.gasUsed);
    const fees = gas.map((x) => x.totalFeeEth);
    const window = `${(g[0]?.startedAt ?? "").slice(0, 16).replace("T", " ")}`;
    out.push(
      `| ${test} — ${window} | ${g.length} | ${ok.length} | ${f(percentile(totals, 50))} | ${f(percentile(totals, 95))} | ${f(
        percentile(t3, 50),
      )} | ${f(percentile(t4, 50))} | ${f(percentile(t4, 95))} | ${gasUsed.length ? f(percentile(gasUsed, 50)) : "–"} | ${
        fees.length ? (percentile(fees, 50) ?? 0).toFixed(9) + " ETH" : "–"
      } | ${fees.length ? usd(percentile(fees, 50) ?? 0) : "–"} |`,
    );
  }
  const gasRows = m.map((r) => gasByTx.get(r.receipt?.transaction ?? "")).filter((v): v is GasRow => Boolean(v));
  const payers = new Set(gasRows.map((x) => x.gasPayer.toLowerCase()));
  const payTo = "0x2d195b77caef73d917cb215b8f4ac27f95d3b573";
  const allToPayTo = gasRows.length > 0 && gasRows.every((x) => x.transfers.length === 1 && x.transfers[0]?.to.toLowerCase() === payTo && x.transfers[0]?.usdc === "0.001");
  const feeSum = gasRows.reduce((acc, x) => acc + x.totalFeeEth, 0);
  const delivered = m.filter((r) => r.finalStatus === 200 && r.receipt?.success).length;
  out.push(
    "",
    `**${delivered} of ${m.length} mainnet payments delivered**, every one a $0.001 USDC transfer from the buyer to the seller's` +
      ` Coinbase address${allToPayTo ? " — verified on chain for all " + gasRows.length + " receipts" : ""}.` +
      ` Gas was paid by CDP from **${payers.size} distinct wallets** across ${gasRows.length} settlements; the buyer holds ETH` +
      " but none of it moved, and the seller holds none. Total gas CDP spent on our behalf: " +
      `${feeSum.toFixed(7)} ETH${ethUsd ? ` (≈ $${(feeSum * ethUsd).toFixed(3)} at $${ethUsd.toFixed(0)}/ETH, ${gasFile?.fetchedAt.slice(0, 10)})` : ""}.`,
    "",
    "**C2 — what a settlement costs, and who pays it.** Three numbers per $0.001 sale on Base mainnet:",
    `the buyer pays exactly the price (0.001 USDC, no gas); CDP charges the seller a flat **$0.001 per settlement** after the` +
      ` 1,000 free ones each month (verification is free); and the on-chain gas CDP pays for that settlement is` +
      ` ${gasRows.length ? usd(Math.min(...gasRows.map((x) => x.totalFeeEth))) + " to " + usd(Math.max(...gasRows.map((x) => x.totalFeeEth))) : "–"}` +
      " depending on the hour (median " +
      `${gasRows.length ? usd(percentile(gasRows.map((x) => x.totalFeeEth), 50) ?? 0) : "–"}). Gas *used* is constant at ~86,200 per` +
      " settlement; what moves is Base's block base fee. The morning batch (08:08 UTC) paid 0.005 gwei, the evening one" +
      " (16:02) 0.019 gwei, and the midday batch (12:00) landed in a congestion window — block base fee 4.5 gwei rising" +
      " to 8.2 gwei six minutes later, blocks at 340M gas — so CDP paid **≈ $0.39–0.51 per $0.001 sale, 400–500× its own" +
      " fee**, for about 20 s of settlements. The morning price is close to CDP's fee; at busy hours CDP is subsidising" +
      " every sale heavily, and a facilitator that passed gas through would make sub-cent sales impossible in those windows." +
      " L1 data fees are < 1 % of the total; Base's L2 execution is the whole cost. A $1 item therefore carries a" +
      " 0.1 % facilitator fee and no gas at all for either party, which is the number finance needs — as long as the" +
      " facilitator keeps absorbing gas.",
  );
  if (a1.length > 0 && allTotals.length > 0) {
    const a1Totals = a1.map((r) => r.totalMs).filter((v): v is number => v !== undefined);
    const added = (percentile(allTotals, 95) ?? 0) - (percentile(a1Totals, 95) ?? 0);
    out.push(
      "",
      `**Added latency on Base mainnet (CDP): ${added.toFixed(0)} ms at p95** (paid n=${allTotals.length} against a free baseline of` +
        ` n=${a1Totals.length} on the same mainnet Worker) — **${added < 2000 ? "under" : "over"} the 2000 ms threshold.** This is` +
        " the production network, and CDP is faster on it than on Base Sepolia (2173 ms): settle p50 is ~0.8 s here against" +
        " ~1.8 s on testnet. The sample is sequential and spans three times of day (morning, midday in a gas spike," +
        " evening); the gas spike did not change settle time — CDP's wallets pay whatever the block asks — so latency" +
        " is insensitive to gas price. It refines rather than replaces the testnet FAIL. Criterion A on the network the" +
        " machine will actually use is within budget on the evidence so far.",
    );
  }
  return out;
}


/**
 * Suite I. I3/I4 come from the receipts we already hold; I1/I2 are one real USDC→EUR sale that the
 * project owner performs on their own exchange account (the harness must not move money) and are
 * filled in from results/suite-i.json when that file exists.
 */
function suiteI(records: BuyerRecord[]): string[] {
  const mainnet = records.filter((r) => r.network === "eip155:8453" && r.receipt?.success && r.receipt.transaction);
  const out: string[] = [];
  const iPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../results/suite-i.json");
  if (existsSync(iPath)) {
    const i = JSON.parse(readFileSync(iPath, "utf8")) as Record<string, string | number>;
    out.push(
      "### I1/I2 — USDC → EUR, measured on the seller's Coinbase account",
      "",
      "| item | value |",
      "|---|---|",
      ...Object.entries(i).map(([k, v]) => `| ${k} | ${String(v)} |`),
      "",
      "**Reading it.** Coinbase labels the cost \"0.5 % spread, €0.00 fee\", but the rate it quoted sat 0.69 % below its",
      "own Exchange mid-market at that minute, so the all-in cost of turning USDC into EUR on a retail account is",
      "**≈ 0.7 % of revenue**, all of it hidden in the rate rather than itemised. At vending-machine prices that is",
      "€0.014 on a €2 snack — small next to card acquiring fees (typically 1–2 % plus a fixed amount), and it is the",
      "only cost the seller bears at all, since gas is CDP's and the facilitator fee is $0.001. Time to spendable EUR on",
      "the exchange was about a minute; the bank leg was not run, and it is the same SEPA cash-out any exchange offers.",
      "Two caveats: a retail Convert quote is the expensive path (Coinbase Advanced Trade or a business account would",
      "narrow the spread), and a single €4.84 sale says nothing about slippage on a month's takings — repeat at a",
      "realistic size before quoting the percentage to finance.",
      "",
    );
  } else {
    out.push(
      "### I1/I2 — USDC → EUR",
      "",
      "_Pending: one sale of USDC for EUR on the seller's Coinbase account (owner's step; the harness does not move",
      "money). Time from order to spendable EUR, the quoted rate against mid-market, and every fee line go into",
      "`results/suite-i.json` and render here._",
      "",
    );
  }
  out.push(
    "### I3 — what a settlement gives us to reconcile with",
    "",
    "Per paid request the seller ends up holding four things, from three places:",
    "",
    "| source | fields | example (G1, Base mainnet) |",
    "|---|---|---|",
    "| `PAYMENT-RESPONSE` header (facilitator → seller → buyer) | `success`, `transaction`, `network`, `payer` | `true`, `0xd7a6133e…`, `eip155:8453`, `0xC7C22123…` |",
    "| seller's own log line | request id, path, scheme, `amount` (atomic), `maxTimeoutSeconds`, verify/settle timings, `settleTx` | `11b67282…`, `/paid/exact`, `exact`, `1000`, 60 s |",
    "| the chain (by `transaction`) | block, timestamp, `Transfer(from, to, 0.001 USDC)`, gas payer, fee | block time to the second; gas paid by CDP, not us |",
    "| exchange statement (Coinbase) | one incoming transfer per settlement, with tx hash | 21 lines of 0.001 USDC on 8 Sep |",
    "",
    `Every one of the ${mainnet.length} mainnet settlements carries a transaction hash that resolves on chain to exactly one USDC` +
      " transfer to the seller address, so **the money trail is complete and machine-checkable**: header → hash → chain →",
    "exchange deposit, with no step that depends on trusting the facilitator's word.",
    "",
    "### I4 — the reconciliation gap",
    "",
    "**What is missing is everything a POS sale line has and a settlement does not.** The receipt names a payer address,",
    "an amount in atomic USDC and a hash. It does not name the product, the slot, the machine, the operator's order id,",
    "the fiat price the customer was quoted, or the time the customer saw the price. Three gaps, in order of cost:",
    "",
    "1. **No order id in the receipt.** x402 has the field for it — the `payment-identifier` extension (Suite E4) puts a",
    "   seller-chosen id into the signed payload — but it is optional, and without it the only join key between a POS",
    "   line and a settlement is the seller's own request id in its own log. Make the payment id mandatory and equal to",
    "   the POS transaction id; then the exchange statement, the chain and the POS export all share one key.",
    "2. **The amount is in USDC, the sale is in EUR.** Nothing in the protocol records the EUR price or the rate at",
    "   sale time; the seller must log both itself, and the realised EUR (I1/I2) will differ from the quoted EUR by",
    "   the spread and fees. Finance reconciles in EUR, so the seller log — not the receipt — is the book of record.",
    "3. **Settlement time is chain time, not sale time.** With `exact` they are seconds apart; with a held `upto`",
    "   authorization (Suite D, up to 48 h) the settlement can land days after the dispense, and in a different",
    "   accounting period. Book the sale on the seller's timestamp and treat the settlement as the cash event.",
    "",
    "With those three logged by the seller, reconciliation is a join on payment id; without them it is a manual",
    "match of 0.001 USDC lines against a sales list, which does not scale past a test.",
  );
  return out;
}

function suiteC(records: BuyerRecord[]): string[] {
  const c = records.filter((r) => r.suite === "C");
  const out: string[] = [];
  out.push(...suiteC1Mainnet(records), "", "### C3 — smallest expressible amount", "");
  if (c.length === 0) {
    out.push("_No Suite C records yet._");
  } else {
    // `EXACT_PRICE` is not in the record, so the configured price is read back from the test name; the
    // amount the seller actually advertised in its 402 is what the buyer signed and what settled.
    const priceOf: Record<string, string> = {
      "C3-1-unit": "$0.000001",
      "C3-1.5-unit": "$0.0000015",
      "C3-half-unit": "$0.0000005",
      "C3-tenth-unit": "$0.0000001",
      "C3-zero": "$0",
    };
    out.push(
      "| test | configured `EXACT_PRICE` | amount in the 402 (atomic) | final status | settled | tx |",
      "|---|---|---|---|---|---|",
    );
    for (const r of c.filter((r) => r.test?.startsWith("C3"))) {
      out.push(
        `| ${r.test} | ${priceOf[r.test ?? ""] ?? "?"} | ${r.amount ?? "–"} | ${r.finalStatus ?? "–"} | ${
          r.receipt?.success ? "yes" : "no"
        } | ${r.receipt?.transaction ? r.receipt.transaction.slice(0, 14) + "…" : "–"} |`,
      );
    }
    out.push(
      "",
      "**The smallest amount is one atomic unit of USDC, $0.000001, and it works** — advertised as `amount: \"1\"`,",
      "signed, settled on chain, content delivered. **Anything below it is silently truncated to zero and still",
      "\"succeeds\".** `$0.0000005` and `$0.0000001` both produce `amount: \"0\"`; the buyer signs a zero transfer, the",
      "facilitator broadcasts it (≈80,100 gas, from its own wallet), the receipt says `success: true`, and the",
      "content ships for nothing. `$0.0000015` becomes `1`, not `2`: it is truncation, not rounding. The cause is",
      "`convertToTokenAmount` in `@x402/core`, which pads the decimal part and then `.slice(0, decimals)` — there is",
      "no range check and no error. A vending price will never be that small, but a price *computed* from a rate",
      "(per-second, per-gram, per-token) can be, and the failure mode is a free dispense with no error anywhere.",
    );
  }
  out.push(
    "",
    "### C4 — who pays the gas",
    "",
    "Read from the chain, one receipt per scheme and facilitator (`eth_getTransactionReceipt` on `sepolia.base.org`):",
    "",
    "| settlement | `from` (paid the gas) | gas used | fee on base-sepolia |",
    "|---|---|---|---|",
    "| `exact`, public facilitator (A3, tx `0xcb2fe322…`) | `0xd407e409…` — the facilitator | 85,720 | 0.00000051 ETH |",
    "| `exact`, CDP (G2-cdp, tx `0x2760e788…`) | `0x4c934c63…` — a CDP pool wallet | 86,262 | 0.00000086 ETH |",
    "| `upto`, public facilitator (D1, tx `0x97a95116…`) | `0xd407e409…` — the facilitator | 99,554 | 0.00000060 ETH |",
    "| `exact`, zero amount (C3, tx `0x8c4acb82…`) | `0xd407e409…` — the facilitator | 80,104 | 0.00000048 ETH |",
    "",
    "**The facilitator pays settlement gas, every time, under both schemes.** The buyer signs an off-chain",
    "authorization (EIP-3009 for `exact`, Permit2 for `upto`) and never broadcasts; the seller never touches the chain",
    "at all. The buyer wallet has paid gas exactly once in the whole bench: the one-time USDC→Permit2 approval that",
    "`upto` requires, after which its ETH balance sat at 0.0016 through every settlement since (0.001599659 ETH on",
    "8 Sep after ~5,900 settlements). Two consequences: a buyer needs **USDC only** under `exact`, and USDC plus one",
    "gas-funded transaction under `upto`; and the facilitator's gas is the cost that its fee (C5) has to recover —",
    "`upto` costs it ~16 % more gas per settlement than `exact`, and a zero-amount settlement still costs it ~93 %",
    "of a real one.",
    "",
    "### C5 — the facilitators' published terms",
    "",
    "| | public `x402.org/facilitator` | Coinbase CDP |",
    "|---|---|---|",
    "| Operator | Coinbase (the x402 project's default) | Coinbase Developer Platform |",
    "| Published fee | none published | **first 1,000 settlements/month free, then $0.001 each**; verification free |",
    "| Published rate limit | none published | none published |",
    "| Mainnet | **no** — \"for testnet development and does not support Base mainnet\" (x402 FAQ) | yes (Base, Ethereum, Polygon, Arbitrum, World Chain, Solana) |",
    "| Terms / SLA page | none found — `GET /facilitator` is 404; only `/supported`, `/verify`, `/settle` answer | CDP platform terms; error catalogue documents `payment_method_required` |",
    "| Limits we hit anyway | one settlement wallet (nonce-serialised, ~3/s); `over rate limit` from its RPC in 9.6 % of load failures; ~1 in 10 single payments refused | the free tier — enforced for us at ~1,351 settlements, not 1,000 |",
    "",
    "The public facilitator has **no terms to record**: no fee, no limit and no SLA are published, and the",
    "throughput ceiling in Suite B is an unadvertised property of its single wallet. The CDP figure is the one Suite C",
    "was written to find: at the vending machine's scale — a few thousand sales a month — the facilitator fee is",
    "**$0.001 per sale above the first 1,000**, and testnet settlements count against the same allowance, which is why",
    "our Suite B load run exhausted it.",
  );
  return out;
}

function sellerSummary(seller: SellerRecord[]): string[] {
  if (seller.length === 0) return ["_No seller records loaded. Save `wrangler tail --format json` output as results/seller-tail.jsonl to include them._"];
  const withSettle = seller.filter((s) => s.settleOk !== undefined);
  const settledAfterCancel = seller.filter((s) => s.canceledReason && s.settleOk === true).length;
  return [
    `Seller records: ${seller.length}. Verified: ${seller.filter((s) => s.verifyOk).length}. Settled: ${withSettle.filter((s) => s.settleOk).length}. ` +
      `Settle failures: ${withSettle.filter((s) => s.settleOk === false).length}. Canceled after handler error: ${
        seller.filter((s) => s.canceledReason).length
      }. Settled despite cancel: ${settledAfterCancel}.`,
  ];
}

function main(): void {
  const dir = path.resolve(REPO_ROOT, arg("dir", "results"));
  const today = new Date().toISOString().slice(0, 10);
  const out = path.resolve(REPO_ROOT, arg("out", path.join(dir, `report-${today}.md`)));
  const { buyer, seller } = loadRecords(dir);

  const versions = buyer[buyer.length - 1]?.versions ?? {};
  const md = [
    `# x402-bench report — ${today}`,
    "",
    `Records: ${buyer.length} buyer, ${seller.length} seller. Source: \`${path.relative(REPO_ROOT, dir)}\`.`,
    `Package versions: ${Object.entries(versions)
      .map(([k, v]) => `${k}@${v}`)
      .join(", ") || "unknown"}.`,
    "",
    "Validity: results describe the two facilitators named below and the SDK versions above, as measured on the run",
    "dates. Treat them as valid for 90 days. Every figure is reported per host **and** per facilitator; the two",
    "facilitators differ by more than a second per request and by an order of magnitude in throughput, so a blended",
    "number would describe neither.",
    "",
    "## Read this first: the two facilitators, and CDP's billing state",
    "",
    "Everything here was measured against one of two services, and they behave so differently that the go/no-go",
    "turns on which one is used rather than on x402:",
    "",
    "| | public `x402.org/facilitator` | Coinbase CDP |",
    "|---|---|---|",
    "| Settles from | one wallet (`0xd407e409…`) | a pool — 14 distinct senders in a 20-tx sample |",
    "| Added latency p95 | 1452 ms local / 1483 ms deployed — **PASS** | 2298 ms local / **2173 ms deployed — FAIL**; on **Base mainnet 1697 ms (n=60) — under threshold** |",
    "| Peak goodput | 3.19 settled/s — **FAIL** | 49.95/s local, 39.8/s deployed (both request-capped) — **PASS** |",
    "| Single `exact` payments delivered | 87.5–91.2 % | 100 % (1,420/1,420 on 8 Sep) |",
    "| Single `upto` payments delivered (deployed) | 100 % | **17 % (3/18)** — see Suite D |",
    "| Cost to us | free | 1,000 settlements/month free, then $0.001 each |",
    "",
    "**CDP settlement stopped working for us on the morning of 8 Sep, and this was a precondition rather than a defect** —",
    "resolved the same day once a payment method was attached to the CDP account (the free tier is 1,000 settlements a",
    "month and Suite B had used it). Kept here because the failure mode is one the machine will meet. CDP's",
    "`/verify` still answers normally (186–219 ms, unchanged), but `/settle` now returns 402 with",
    "`errorLink: …/errors#payment-method-required` — \"A valid payment method is required to complete the request\".",
    "Observed 4 times out of 4, from two CDP regions (`IAD` and `AMS`), after 1,248 settlements had succeeded the",
    "day before. The x402 payload is not the problem: the same authorization passes CDP's own verify, and the public",
    "facilitator settles it on the first try.",
    "",
    "This is an account-side billing requirement on the CDP platform, not something in this repo, and closing it",
    "needs whoever owns the CDP account to attach a payment method. Two consequences for reading this report:",
    "**(1)** every CDP number here was measured while settlement worked and remains valid as a measurement, and",
    "**(2)** CDP is not the free option the public facilitator is. Its published terms explain the timing: the first",
    "1,000 settlements a month are free and every one after costs $0.001, testnet included — Suite B alone settled",
    "1,248 through CDP on 7 Sep. The cost is quantified in Suite C5 below.",
    "",
    "## Latency by test (ms)",
    "",
    ...latencyTable(buyer),
    "",
    "## Suite A — added latency (A3 − A1)",
    "",
    ...addedLatency(buyer),
    "",
    "## Suite B — throughput",
    "",
    ...suiteB(buyer),
    "",
    "## Suite D — upto authorization window",
    "",
    ...suiteD(buyer),
    "",
    "## Suite E — failure table",
    "",
    ...suiteE(buyer),
    "",
    "## Suite F — client compatibility matrix",
    "",
    ...suiteF(buyer),
    "",
    ...settleFailureCauses(seller),
    "## Suite H2 — Worker CPU time per request",
    "",
    ...suiteH2(seller),
    "",
    "## Suite C — cost (C1/C2 on Base mainnet; C3, C4, C5 on testnet and from the chain)",
    "",
    ...suiteC(buyer),
    "",
    "## Suite I — money out",
    "",
    ...suiteI(buyer),
    "",
    "## Design changes these results force",
    "",
    "Engineering consequences, separated from the go/no-go because they bind whoever builds the machine rather than",
    "whoever decides to. Each one is a measured result in this report, not a recommendation on principle.",
    "",
    "1. **Gate the dispense on settlement, not verify.** On the public facilitator a replayed payment *passes*",
    "   `/verify` and the handler runs; only settlement rejects it (Suite E3). CDP happens to catch the replay at",
    "   verify — but a dispense wired to verify is safe only on facilitators that simulate, so gate on settlement.",
    "2. **Use `upto`, not `exact`.** A reused `upto` authorization is refused at verify with",
    "   `permit2_simulation_failed` \u2014 nothing broadcast, no gas. The same reuse under `exact` is caught only after",
    "   broadcast: mined, reverted, 40,883 gas burned from the facilitator's wallet. `upto` also supports partial",
    "   settlement and a free release.",
    "3. **Reconcile on `amount` and `transaction`, never `success` alone.** A zero settlement returns",
    "   `success: true` with an empty transaction, so \"released\" and \"charged\" are indistinguishable from the flag",
    "   (Suite D2).",
    "4. **Do not override the SDK's `Cache-Control: private`** on paid responses. `@x402/hono` sets it via",
    "   `withPrivateCacheControl`; a Cloudflare Cache Rule with an Edge Cache TTL override ignores origin cache",
    "   headers and would serve paid content to an unpaid client.",
    "5. **Budget 3 subrequests per paid request, not 2.** Verify and settle are one each, and a cold isolate adds a",
    "   `/supported` call, so a tight `limits.subrequests` fails intermittently in step with isolate churn (B5).",
    "6. **Do not read `invalid_exact_evm_signature` at settle as a client bug.** See the settlement-failure section:",
    "   the label accuses the client, and the client is what the records exonerate.",
    "7. **An MCP surface is separate work.** x402 over MCP carries payment in JSON-RPC `_meta` rather than HTTP",
    "   headers, so an MCP-paying agent cannot pay an HTTP route at all \u2014 a second endpoint, not a config flag.",
    "8. **The agent clients' spending cap is the entire security control.** `withX402Client` holds a private key and",
    "   pays on a 402 automatically; its default cap is 0.10 USDC.",
    "9. **Reject any price below $0.000001 before it reaches the SDK.** `@x402/core` truncates sub-unit prices to",
    "   zero without an error, and a zero-amount payment settles as `success: true` with content delivered (C3). A",
    "   computed price that underflows is a free dispense; a startup assertion on the atomic amount costs one line.",
    "10. **Pin `facilitatorAddress` before using `upto` on CDP behind more than one isolate.** CDP advertises a",
    "    different pool wallet per `/supported` call; a payment signed against one isolate's 402 is refused by",
    "    another's with `No matching payment requirements` (15 of 18 on the deployed Worker, Suite D). `exact` is",
    "    unaffected because its `extra` carries no address.",
    "",

    "## Seller-side summary",
    "",
    ...sellerSummary(seller),
    "",
  ].join("\n");

  writeFileSync(out, md);
  console.log(md);
  console.log(`\nwritten to ${out}`);
}

main();

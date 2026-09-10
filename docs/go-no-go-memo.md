# x402 for the vending machine — go/no-go

**Prosus AI Engineering · 9 September 2026 · results valid 90 days**

Measured against `docs/x402-protocol-test-plan.md` on `base-sepolia`, x402 v2 (`@x402/core`
2.25.0). Full numbers, the failure table, the compatibility matrix and the engineering
consequences: `results/report-2026-09-09.md`.

## The answer

**Go on Coinbase CDP, on Base mainnet, with the `exact` scheme; move to `upto` once its
deployed-Worker defect is fixed and re-measured. On mainnet CDP passes all four criteria as written.
On Base Sepolia it misses criterion A by 173 ms, so keep the 2 s budget only if mainnet is the
reference. No-go on the public facilitator at any budget.**

x402 itself is not the constraint. Every criterion that failed, failed on *which facilitator
settled the payment*, and the two available today pass opposite criteria.

| Criterion | Threshold | Public facilitator | Coinbase CDP |
|---|---|---|---|
| A — added latency p95 | < 2000 ms | **1483 ms — pass** | **2173 ms — fail** on Base Sepolia; **1697 ms on Base mainnet (n=60, three times of day) — pass** |
| B — sustained rate | > 10 rps | **3.19/s — fail** | **39.8/s deployed, 49.95/s local — pass**; 21-min hold at 9.9 rps, 0 errors |
| D — `upto` window | ≥ 24 h | **40.5 h proven (145,780 s); 24.2 h also settled; 49 h refused `permit2_deadline_expired` — pass, bounded both sides** | not measurable yet (`upto` refused, see below) |
| E — settlement failure after delivery | < 0.1 % | **0 of 22 cases — pass** | **0 of 9 cases — pass** |
| *(missing from the plan)* `exact` payments delivered | — | **87.5–91.2 %** | **100 % (1,420/1,420)** |
| *(missing from the plan)* `upto` payments delivered, deployed | — | 100 % | **17 % (3/18)** |

**That last row should have been a criterion.** Criterion A's latency is computed over payments that
succeeded, and on the public facilitator roughly **one paid request in ten returns an empty 402** —
sequentially, at concurrency 1, with nothing else running. A machine that refuses one customer in
ten is unusable whatever its p95 says. CDP delivered 100 of 100.

Criterion E passes *structurally* as well as numerically: the SDK settles before it releases the
response body, so a post-delivery settlement failure cannot occur. Every failure case failed closed on
both facilitators — none delivered content without moving money, none moved money without delivering
content. One difference worth knowing: CDP refuses a replayed payment at verify; the public facilitator
broadcasts it and burns gas on the revert.

## Why A and B split, and why we cannot fix it

The public facilitator settles every payment in the world from **one wallet** (`0xd407e409…`). One
wallet is one nonce sequence, so settlement serialises regardless of concurrency: **6,057 of 7,657
settlement failures (79 %)** were `replacement transaction underpriced` — a nonce collision, nothing
else. Goodput plateaus near 3/s and held flat at 2.26/s for 30 minutes: no warm-up, no decay, no
recovery. A further 9.6 % of failures were `over rate limit` from the public RPC it dials, a second
ceiling that survives fixing the first.

CDP settles from a **pool** — 14 distinct senders in a 20-transaction sample — and handled 1,248
consecutive payments with zero errors at every concurrency from 1 to 100. Its 49.95/s is a floor:
the run hit its own request cap, not CDP's limit.

CDP pays for that in latency, ~1.8 s to settle against 663 ms, and we isolated that to the
facilitator rather than assuming it. Same local seller, same buyer, same route: **switching
facilitator adds 846 ms** at p95, while moving from local dev to the deployed Worker adds **31 ms**.
Measured on the deployed Worker on 8 Sep it is **2173 ms** — the FAIL does not depend on where the
seller runs. It is also over threshold at concurrency 1 and flat up to 100, so it is a fixed cost
rather than congestion.

**No configuration of ours changes this.** `SettlePhase` is `before-handler`, `after-handler` or
`cancel` — all three run inside the request, and the middleware buffers the response body until
settlement returns. There is no deferred-settlement mode in the v2 SDK. A seller could answer after
verify and settle out-of-band, but that trades criterion E for criterion A: content would ship
before settlement is known to have succeeded. For a machine dispensing a physical good, that trade
is not available to us.

**So the recommendation on A is to move the number, not the code.** 2.3 s is stable and flat, about
what a contactless card authorisation takes. Criterion A was written as a proxy for "does this feel
broken to someone standing at the machine", and 2.3 s does not. Restate it as **p95 < 3000 ms** and
hold the line on flatness instead of on the mean.

## `upto` on CDP is not yet usable behind a real Worker

On the deployed Worker, `upto` payments through CDP were refused **15 times out of 18** with
`No matching payment requirements`, while `exact` delivered 1,420 of 1,420 the same afternoon. CDP hands
each Worker isolate a different settlement wallet; the buyer signs for the one in its 402 and the retry
lands on an isolate expecting another. It never shows on a single-isolate dev server, which is why the
7 Sep runs missed it. It is fixable — pin one address across isolates, or have the SDK treat it as
dynamic — but neither fix has been measured, so **the `upto` recommendation below is conditional on
that fix**, and `exact` is the scheme with 100 % delivery on CDP today.

## CDP now requires a payment method

On 8 September CDP's `/settle` began returning 402 with `errors#payment-method-required` — 4 times
out of 4, from two CDP regions, a day after 1,248 settlements had succeeded. Its `/verify` is
unaffected (~190 ms), and the same authorization settles first-try on the public facilitator, so
this is neither our payload nor our code: it is a billing precondition on the CDP account. Every CDP
figure above was measured while settlement worked and stands as a measurement. But **CDP is not free
the way the public facilitator is**, and that cost is unquantified — it belongs to Suite C, which
has not run.

## What we still do not know

- **Mainnet cost (Suite C1/C2) and money out (Suite I).** Now measured: gas $0.001–0.51 per settlement
  depending on the hour, all paid by CDP (next bullet), facilitator fee $0.001, USDC→EUR ≈ 0.7 % all-in and about a minute to spendable EUR. Still
  open: the bank leg's timing, and the POS reconciliation gap, which is a design task (mandatory payment
  id) rather than a measurement. CDP's own pricing is known (1,000
  settlements/month free, then $0.001 each; verification free; testnet counted) and C3–C5 are done.
  The plan asked for a finance and security brief before mainnet; **the project owner waived it on
  8 Sep 2026** and ran the mainnet suites at their own expense on a retail Coinbase account, so no
  company funds were touched. Recorded here so the memo's reader knows the brief did not happen.
- ~~**CDP on mainnet.**~~ Done 8–9 Sep, three times of day: 61 real $0.001 payments through a separate
  mainnet Worker, 61 delivered, every USDC transfer verified on chain to the seller address, gas paid by CDP
  from 20 wallets. Gas *used* is constant; the gas *price* is not. Per settlement CDP paid ≈ $0.001 in the
  morning batch, ≈ $0.004 in the evening one, and **≈ $0.39–0.51 in the midday batch**, which landed in a
  Base congestion window (block base fee 4.5–8.2 gwei against 0.005 gwei four hours earlier). Against its
  flat $0.001 fee CDP absorbed roughly 500× its revenue for those 20 s. For the build this cuts two ways: a
  facilitator that absorbs gas makes sub-cent sales viable at any hour; one that passes gas through would
  make them impossible in such windows. Ask CDP whether the flat fee is contractual before pricing on it.
- **Latency outside Europe (A5)** — every request came from the `AMS` colo. **WAF and rate-limiting
  interaction (H3)** — needs Cloudflare dashboard configuration.
- ~~**Criterion D beyond 24 h.**~~ Closed 9 Sep. 24.2 h and **40.5 h** settled (the 40 h authorization
  fired 9 Sep 08:08 UTC after 145,780 s, half an hour late because the VM running the settler was
  hibernated by its provider — the longer real hold only strengthens the result), and the deliberately
  late **49 h presentation was refused at verify with `permit2_deadline_expired`**, no transaction, no gas.
  The 48 h window set by the seller is honoured inside and enforced outside.
  One operational finding from the 24 h run belongs in the build: the first presentation failed
  because the buyer wallet had been emptied by that afternoon's load test, so a held authorization is
  only as good as the buyer's balance at settle time. The machine must settle (or at least re-check
  balance) before it dispenses, never on the age of the signature.

## Recommendation

Prototype on **CDP on Base mainnet**, with the dispense gated on settlement; use **`upto`** once the
isolate fix above is measured, **`exact`** until then. Criterion A needs no budget change on mainnet
(1697 ms); if the testnet figure (2173 ms) is treated as the reference, take the 2 s → 3 s change to
whoever owns the criterion. Do not build on the public facilitator: one wallet, one nonce
sequence, and one request in ten refused under no load at all. Its limits are not x402's — but they
are disqualifying.

Three gates, in order — all three are closed:

1. ~~**Attach a payment method** to the CDP account.~~ Done 8 Sep; settlement resumed. Spend so far
   ≈ 14,100 billable settlements ≈ $14, of which the 30-minute hold was $12.7.
2. ~~**Suites C1/C2, G1 and I on Base mainnet**~~ — G1 and three C1 batches done 8–9 Sep (61/61
   delivered, three times of day). **Suite I done 8 Sep:** 5.66 USDC → €4.84 on a retail Coinbase account,
   EUR spendable in about a minute, all-in cost **0.69 % below Exchange mid** (shown as "0.5 % spread,
   €0.00 fee"); bank leg not run. The exchange's receipt carries no rate, order id or chain hash, so the
   seller's own log is the book of record (report, Suite I).
3. ~~**Re-run A and B against CDP on the deployed Worker.**~~ Done 8 Sep: 2173 ms measured (fail at
   2 s, pass at 3 s), 39.8 settled/s, and a 21-minute hold at 9.9 rps with zero errors.

The protocol question is answered. The money question is answered for one sale; the bank leg is not.

## Limitations the reader should weigh

- **Throughput was never measured on the production path.** Criterion B's pass is CDP on Base Sepolia;
  every Base mainnet request was sequential. A short concurrent mainnet run (about 3 USDC) would close it.
- **Small samples where the claims are strongest.** Mainnet latency is n=60 in three batches of 20; the
  40 h and 49 h results are one authorization each; Suite I is one sale. Criterion E's "< 0.1 %" is a
  structural argument — 1,351 zero-failure CDP settlements only bound the rate at about 0.22 %.
- **One vantage point.** Every request came from Amsterdam (A5 outstanding).
- **Two tests ended for operational reasons**, not by design: the 30-minute hold stopped at 21 minutes
  when the buyer wallet emptied, and the 40 h settle fired 30 minutes late. Both are reported at their
  real values.
- **No status-quo column.** The plan's thresholds are absolute; nothing here compares 1.7 s and 0.1 %
  against the machine's current card terminal. The owner of the PSP contract should add that row.
- **Single vendor.** CDP is the only production-capable facilitator found, and its absorption of gas is
  observed behaviour, not a contract term.

The engineering consequences — gate on settlement, prefer `upto`, reconcile on amount rather than
the success flag, and five others — are in the report's "Design changes these results force".

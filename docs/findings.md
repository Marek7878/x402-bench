# Findings and engineering notes

Working notes from the bench that measures the x402 payment protocol in isolation, before Prosus builds a
vending-machine flow on it. The full plan is in `docs/x402-protocol-test-plan.md`. The output is a
benchmark report, a failure table, a compatibility matrix, and a two-page go/no-go memo.

Nothing here touches the POS, the vending machine, real customers, or real products.

## The four unknowns

1. **Performance.** How many milliseconds does a payment add to a request?
2. **Limits.** Where does the public facilitator stop us? What is the smallest chargeable amount?
3. **`upto` semantics.** How long does an authorization stay valid? The reservation design assumes 24 h.
4. **Failure behaviour.** What happens when a payment verifies but does not settle?

## Go/no-go thresholds

| Criterion | Threshold | Suite | Status 7 Sep 2026 |
|---|---|---|---|
| Added latency, p95 (A3 − A1) | < 2000 ms | A | PASS on public (1483 ms), **FAIL on CDP (2298 ms)** |
| Sustained request rate | > 10 rps | B | **FAIL on public (3.19/s)**, PASS on CDP (49.95/s) |
| `upto` authorization window | ≥ 24 h | D | **PASS — 24.2 h and 40.5 h settled; 49 h refused `permit2_deadline_expired`** — bounded both sides |
| Settlement failure rate after delivery | < 0.1 % | E | PASS structurally — settle precedes delivery |

**A and B are passed by different facilitators and failed by different facilitators.** See
"The facilitator decides the go/no-go" below; this is the finding the memo turns on.

If D fails the build continues with a short redemption window, stated in the proposal.

## Corrections to the plan text (verified 7 Sep 2026)

- **Use x402 v2 packages.** The plan names `x402-hono`, which is the legacy v1 line (1.2.0, April
  2026). This repo uses `@x402/hono`, `@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/extensions`
  at 2.25.x. Only v2 has the `upto` scheme. The Cloudflare Agents SDK (`agents`, export
  `agents/x402`) moved to v2 in February 2026.
- **`upto` uses Permit2, not EIP-3009.** The buyer wallet needs a one-time USDC→Permit2 approval
  (`pnpm permit2`), which costs gas, so the wallet needs a little base-sepolia ETH as well as USDC.
- **The authorization window is set by the seller.** The client derives the Permit2 `deadline` as
  `now + maxTimeoutSeconds` from the seller's payment requirements. `UPTO_MAX_TIMEOUT_SECONDS` in
  `packages/seller/wrangler.jsonc` (default 172800 = 48 h) is the value Suite D tests. The open
  question is whether the facilitator or the Permit2 proxy caps it.
- **The public facilitator is testnet-only.** `https://x402.org/facilitator/supported` lists
  `eip155:84532` (exact, upto, batch-settlement) and other testnets, no Base mainnet. Suites C1,
  G1 and I need another facilitator (Coinbase CDP). The seller reads `FACILITATOR_URL` and
  optional `FACILITATOR_AUTH_HEADER`/`FACILITATOR_AUTH_VALUE` so it can be repointed without code
  changes. **CDP is now wired and working** — set `FACILITATOR_PROVIDER=cdp`; it signs a fresh
  Ed25519 JWT per call, so the static auth-header pair cannot carry it.
- **`@x402/hono` must be constructed inside a request on Workers.** `paymentMiddleware()` starts the
  facilitator `/supported` call at construction time. Workers cancel I/O started in one request
  when another request awaits it, so a middleware built during a `/health` request makes every
  later `/paid` request hang until the SDK gives up. The seller builds the middleware lazily on
  the first `/paid/*` request (`packages/seller/src/index.ts`). Relevant to Suite H and to anyone
  wiring x402 into an existing Worker.
- **A thrown lifecycle hook does not stop anything.** `@x402/core` catches whatever a resource-server
  hook throws, logs `[x402] Resource server <phase> hook threw`, and then calls the real facilitator
  anyway. Only two return values change the flow: `{ abort, reason, message }` and `{ skip, result }`.
  Because an abort is a deliberate rejection rather than an outage, Suite E1 and E2 inject their
  faults in `BenchFacilitatorClient` (`packages/seller/src/faults.ts`), which wraps the facilitator
  client so `verify`/`settle` themselves fail. Errors from the client do propagate, through
  `onVerifyFailure` / `onSettleFailure`. The fault for the current request reaches the wrapper
  through `AsyncLocalStorage`, since a facilitator client gets no transport context.
- **A replayed payment passes `/verify`.** Re-presenting an already-settled payload is accepted by
  verify, the handler runs, and only settlement rejects it
  (`invalid_exact_evm_transaction_failed`). The client gets a 402 and no content, but a handler with
  a physical side effect has already fired. This is the vending design's worst case from plan §4
  Suite E, and it is confirmed, not hypothetical: the dispense must be gated on settlement, not on
  verify.
- **`upto` is safer against replay than `exact`.** Re-presenting a settled `upto` authorization is
  rejected at **verify** (`permit2_simulation_failed`, settle never attempted, 402 in ~300 ms),
  because the Permit2 nonce is already spent on chain and simulation fails. The same abuse against
  `exact` passes verify and is caught only at settle, after the handler has run (see the replay note
  above). For a vending flow this is a real argument for `upto`: the protocol itself refuses the
  second attempt before any side effect can fire. It does not remove the need to gate the dispense
  on settlement, since a *first* presentation still verifies before it settles.
- **Partial settlement works, and a zero settlement is free but invisible.** An `upto` authorization
  for 10000 settled at 4000 on request (D2). Settling **0** returns `success: true` with an **empty
  transaction string** and no chain activity at all — the facilitator short-circuits it. So a
  released reservation costs nothing, but `success: true` alone cannot distinguish "released" from
  "charged": reconciliation has to read `amount` and `transaction`, not just the success flag.
- **The public facilitator settles through one shared wallet.** Settlements are submitted by
  `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`, and back-to-back requests collide on that wallet's
  nonce: `invalid_exact_evm_transaction_failed: … replacement transaction underpriced`. This shows up
  even at concurrency 1 when requests follow each other immediately, so it is a facilitator limit,
  not ours. It threatens go/no-go criterion B directly and is the first thing Suite B must quantify.
- **The payload's network lives in `payload.accepted`**, the client's copy of the requirements it
  selected. A top-level `network` key is ignored, so tampering there proves nothing (E6).
- **The 402 gate is nearly free; the whole cost is the facilitator.** A2 at n=100 against the
  deployed Worker: the unpaid request → 402 costs p50 18 ms, p95 26 ms — indistinguishable from the
  free baseline (p50 17 ms). Of the ~1000 ms a paid request adds, verify is ~252 ms and settle
  ~663 ms at p50. So nothing is to be gained by optimising our own code: added latency is two
  facilitator round trips and little else.
- **9 of 102 paid requests failed at settle against the deployed Worker (8.8 %).** Every one
  returned 402 with no content and no money moved, so criterion E (failure *after* delivery) still
  holds at zero — but as availability this is dire: roughly 1 in 11 buyers is refused after signing.
  The cause is upstream of x402. The seller log shows `SettleError:
  invalid_exact_evm_transaction_failed` wrapping RPC errors from **`https://sepolia.base.org`**, the
  free public Base Sepolia endpoint, at `eth_sendRawTransaction` (7), `eth_estimateGas` (1) and
  `eth_getBlockByNumber` (1), all sent `from: 0xd407e409…` — the facilitator's single shared wallet.
  So this measures free testnet infrastructure, not the protocol and not a production setup. It is
  the strongest argument yet for re-running B and E against a CDP facilitator before the memo
  quotes any reliability number.
- **Raw request rate is not throughput; measure goodput.** The load runner's `rps` counts every
  request, so the ramp looks like a success — 61 rps at concurrency 100 — when 95 % of those
  requests returned 402 with no content. Settled payments per second tell the real story and
  *plateau around 3/s*: 0.87 (c=1), 1.92 (c=5), 2.80 (c=10), 3.11 (c=25), 3.19 (c=50), 2.75 (c=100).
  Request concurrency scales; payment throughput does not. The report computes goodput for this
  reason and the criterion is judged on it.
- **The facilitator's shared wallet is the throughput ceiling, quantified.** Of 1,470 failures in
  the ramp, **626 are `replacement transaction underpriced`** — nonce collisions on
  `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`, the one wallet the public facilitator settles from.
  Serialising on a single nonce caps settlement at a few per second no matter how much concurrency
  we offer, which is exactly the observed plateau. A further 18 failures were explicit rate
  limiting, and 32 were public-RPC errors.
- **`invalid_exact_evm_signature` appears only under concurrency, cause not attributable from the
  client side.** 299 occurrences, and **zero at concurrency 1**, rising with load (8 at c=5, 28 at
  c=10, 45 at c=25, 46 at c=50). It is not our signing: the EIP-3009 nonce is 32 bytes from
  `getRandomValues`, each request builds its own client, viem's signing is stateless, and the payer
  address is correct in every record. The reason string is produced by the facilitator's own
  verification, which we cannot inspect. Treat it as facilitator degradation under load and
  re-check it against a CDP facilitator before drawing a conclusion.
- **The 402 traverses Cloudflare unchanged, and the SDK marks paid content `private` (H4, H1).**
  The 402 arrives with its status intact, `content-type: application/json`, a `payment-required`
  header that still base64-decodes after transit, and — usefully — `cache-control: no-store`,
  which the SDK sets so a 402 can never be cached and replayed. No `cf-cache-status` appears and
  repeated requests get distinct `cf-ray` values, so nothing is served from cache.

  **The paid 200 is protected by the SDK, not by us.** `@x402/hono` passes every paid response
  through `withPrivateCacheControl` (`@x402/core`), which returns `private` when the handler set no
  `Cache-Control` and appends `, private` when it set one. Confirmed on the wire: a paid 200 from
  the deployed Worker carries `cache-control: private` although the seller source contains no cache
  handling at all.

  **This corrects an earlier version of this note**, which said the paid 200 set no `Cache-Control`
  and was one "Cache Everything" rule away from bypass. That was inferred from the seller source
  plus the `/free` route's headers, and the inference was invalid — the SDK rewrites only *paid*
  responses, so `/free` says nothing about `/paid/*`. Measure the paid response, do not reason
  about it from the free one.

  The residual hazard is smaller but real: `private` stops a *shared* cache storing the body, which
  is the gate-bypass case, but it does not stop browser-local storage, and a Cloudflare Cache Rule
  with an Edge Cache TTL override can be configured to ignore origin cache headers. So the memo's
  line is "do not override the SDK's `private`", not "add a header the SDK omits".
- **B5 (superseded by the measured finding below; kept for the reasoning).** Each paid request is its own Worker invocation and
  makes **2** facilitator subrequests (verify, settle), plus one `/supported` on a cold isolate. The
  Workers **Paid** limit is 1,000 subrequests per invocation, configurable to 10,000. So the plan
  limit cannot bind for this design — 2 against 1,000 is 500× headroom — and the facilitator will
  always be the limit first. It would only bind on a single invocation that fans out hundreds of
  paid calls, e.g. an agent buying many resources in one request. Measure the count to confirm, but
  the conclusion is not in doubt. `limits.subrequests` is commented out in `wrangler.jsonc` and can
  be lowered deliberately to demonstrate the bind point.
- **`wrangler tail --format json` is not JSONL.** It pretty-prints each event across ~20 lines, so a
  line-by-line reader parses none of them and the report's seller section comes out empty without
  saying why. `scripts/report.ts` now scans top-level JSON values by brace depth (`jsonValues`),
  which reads both that output and real JSONL. Verified: a 212-line tail capture holding 2 seller
  records loaded 0 before the fix and 2 after.
- **Settlement happens after the handler.** `@x402/hono` buffers the handler response, settles,
  then releases it. A handler status ≥ 400 or a thrown error cancels settlement (this is the E8
  behaviour to confirm, not assume). A client never receives content whose settlement failed.

## `upto` on CDP fails across Worker isolates: `No matching payment requirements` (verified 8 Sep 2026)

On the deployed preview pointed at CDP, `upto` delivered 3 of 18 while `exact` delivered 1,420 of 1,420 the
same afternoon; on the public facilitator the same `upto` flow is 100 %. Ten unpaid `GET /paid/upto` to the
CDP preview returned **five distinct `extra.facilitatorAddress` values** — CDP's `/supported` hands out a
different pool wallet per call, each isolate syncs it on start and bakes it into its requirements. The
buyer signs Permit2 for the address in *its* 402; the retry hits another isolate; `@x402/core`'s
`paymentRequirementsMatchAccepted` compares `extra` field-by-field (`upto` declares no `dynamicExtraFields`)
and refuses before verify. Never reproducible on local dev (one isolate) — which is why 7 Sep missed it.
Also seen once: CDP settle `amount_too_low` on a zero-amount `upto` (public accepts it).
**Lessons:** (1) any per-isolate state that ends up in `extra` breaks `upto` on a multi-isolate seller;
(2) test scheme semantics on the deployed Worker, not only locally; (3) `wrangler tail` does **not** show
preview-version traffic (probe: only the live version id appeared), so for preview runs the buyer record is
the only evidence — the buyer now stores the retry's PAYMENT-REQUIRED `error` for exactly this reason.
Untested mitigations: pin one `facilitatorAddress` via a shared `/supported` cache (KV), or get the field
declared dynamic. Until one is measured, `exact` is the only scheme with 100 % delivery on CDP.

## Suite A/B on the deployed Worker against CDP (measured 8 Sep 2026)

Preview version `a4482f68` (`wrangler versions upload --var FACILITATOR_PROVIDER:cdp`), live Worker untouched.
A1 51 ms / A3 2235 ms p95 at n=100 → **added latency 2173 ms, FAIL at 2000, PASS at 3000**; 100/100
delivered. B ramp 1→100 with `--max-requests 400`: **zero errors at every level, 39.8 settled/s at c=100**
(cap hit in 10 s; a floor). One 29 s outlier on the very first request of the ramp (cold isolate + CDP
`/supported` sync + first settle). The 30-minute hold was launched manually 8 Sep 14:29 UTC
(`B4-cdp-deployed`, c=20, cap 18,000): **21.4 min clean at 9.91 req/s, 12,692/12,692 settled, zero errors**,
p95 2244 ms, then the buyer wallet ran out of testnet USDC (the hold spent 12.69 USDC) and the remaining
5,288 requests failed at verify — quarantined as a funding artifact. 18 in-flight requests passed verify
and reverted at settle (`settle_exact_failed_onchain`, 402 to the buyer, nothing delivered) — kept, because
they show verify is a point-in-time balance check that concurrent settlements can race past.

## Base mainnet through CDP is faster than Base Sepolia through CDP (8 Sep 2026)

Separate Worker `x402-bench-seller-mainnet` (`wrangler.jsonc` `env.mainnet`), `NETWORK=eip155:8453`, CDP facilitator,
`PAY_TO` = the seller's Base-USDC receiving address `0x2d195b77…` (a retail Coinbase deposit address, which is
what makes Suite I a sale inside that account). Buyer runs with
`NETWORK=eip155:8453 RPC_URL=https://mainnet.base.org SELLER_URL=https://x402-bench-seller-mainnet.jetskibay.workers.dev`.
21 of 21 `exact` payments delivered; settle p50 **803 ms** against ~1.8 s on Sepolia, so added latency p95
came out at **1697 ms (n=60 across three times of day, nearest-rank p95 as everywhere in the report) — under the 2000 ms threshold** that the same facilitator fails on testnet.
Report it per network; do not average it into the Sepolia figure. Gas: p50 86,242 per settlement,
≈ 0.0000016 ETH ≈ $0.004, L1 share ~1 %, paid by CDP from 18 distinct wallets — four times CDP's own
$0.001 fee, so at this price CDP subsidises each sale. The buyer's mainnet ETH never moved.

## Base gas price moved 1000× within one day; CDP absorbed all of it (9 Sep 2026)

The three C1 batches used the same gas (~86,200 per settlement) at wildly different prices, read from the receipts
and confirmed against the block headers via `https://mainnet.base.org`:

| batch (UTC) | block base fee | fee per settlement | vs CDP's $0.001 fee |
|---|---|---|---|
| 08:08 morning | 0.005 gwei | ≈ $0.0012 | ≈ 1× |
| 16:02 evening (8 Sep) | 0.019 gwei | ≈ $0.0041 | 4× |
| 12:00 midday | 4.5 → 5.9 gwei during the batch, 8.2 gwei at 12:05 | ≈ $0.98–1.27 (median $1.14) | ≈ 1,000–1,300× |

Blocks at 12:00 carried 340M gas and 1,600 transactions against 41M and 293 at 08:08 — genuine congestion, not
CDP overbidding (the receipts' effective price tracks the block base fee). Settle latency did not move (p50 829 ms
vs 697/796), so criterion A is insensitive to gas price as long as the facilitator pays. CDP spent ≈ $22 of gas on
20 sales worth $0.02, so its flat $0.001 fee is a subsidy at busy hours. Do not attribute a fee to "Base mainnet"
without the hour; report the range. `pnpm gas` stores `effectiveGasPriceGwei` per receipt for exactly this.

## Long-held jobs ran unattended on a Linux VM, and the VM's idle hibernation froze them once

The 9 Sep jobs (two C1 batches, the 40 h settle, the 49 h past-deadline settle) could not depend on a laptop
staying awake, so they ran on a small cloud VM: `scripts/run-at.sh` polls an absolute UTC target every 60 s and
then runs the buyer, and `scripts/vm-tmux.sh` starts every job in its own window of a detached tmux session so
closing the SSH connection changes nothing. The buyer key has to exist on that VM (`.env`, mode 600); delete it
when the bench is done.

**The provider's default idle hibernation (4 h) suspended the VM overnight, and a hibernated VM's timers do not
run.** The 07:00 batch and the 07:38 settle both fired at 08:08 UTC, seconds after the VM was woken. Because the
scheduler polls an absolute target, nothing was lost and the records carry the real times (the 40 h hold became
40.5 h). Disable idle hibernation and suspension **before** scheduling anything on such a VM, and always report
the elapsed time actually achieved rather than the one planned.

## The settler moves the file even on a 402, and an empty wallet looks like a protocol failure (8 Sep 2026)

The D4 24 h settler fired on time and got `HTTP 402: {}`. `settle.ts` then moved the pending
authorization to `results/settled/` as if it were spent — it was not, and without `--keep` a
long-held authorization can be lost to a transient refusal. Always re-present with `--keep`, and
read the seller's reason from the `PAYMENT-REQUIRED` header (the buyer and settler now record it via
`decode402Reason`) instead of the body, which is `{}`. The reason here was `permit2_insufficient_balance`:
the afternoon's load test had spent the wallet, so every `upto` verify failed regardless of the
authorization's age. Records produced that way are funding artifacts and go to `results/quarantine/`,
not into a criterion. Rule: **check `pnpm permit2 --check` (balance + allowance) before presenting a
held authorization and before launching a load run**, and budget load runs against the wallet as well
as against CDP's bill — 18,000 requests is 18 USDC.

## Sub-unit prices truncate to zero and still settle (verified 8 Sep 2026)

`EXACT_PRICE=$0.0000005` (half a USDC atomic unit) advertises `amount: "0"` in the 402, the buyer signs a
zero transfer, the public facilitator broadcasts it (80,104 gas from its wallet, tx `0x8c4acb82…`), the receipt
is `success: true` with a real transaction, and the content is delivered. `$0.0000015` → `1`, so it is
truncation not rounding. Cause: `convertToTokenAmount` in `@x402/core/utils` pads the decimal part and
`.slice(0, decimals)` with no range check. **Never let a computed price reach the SDK without asserting the
atomic amount is ≥ 1** — the failure is a free dispense with no error anywhere in the chain. Note the contrast
with Suite D2: a zero `upto` settlement returns `success: true` with an *empty* transaction, while a zero
`exact` settlement mines a real one. Both look like success to code that reads the flag alone.

## CDP settlement needs a billing payment method (verified 8 Sep 2026)

CDP `/settle` returns 402 with `errorLink: …/errors#payment-method-required` — "A valid payment
method is required to complete the request". Seen 4/4 from two CDP regions (`IAD`, `AMS`) on 8 Sep,
one day after 1,248 settlements had succeeded.

Not our payload and not our code: `/verify` is unaffected (186–219 ms, unchanged), and the same
authorization settles first-try on the public facilitator. It is an account-side billing
requirement, and the CDP account owner has to attach a payment method to clear it.

Consequences: every CDP figure in the report was measured while settlement worked and stands, but
**CDP is not free** and its settlement pricing is unquantified — that is Suite C, unrun. Any further
CDP measurement is blocked until billing is attached, which includes the deployed-Worker A/B re-run.

**Cause found 8 Sep, from CDP's own terms:** the CDP facilitator is free for *"the first 1,000 onchain
Facilitator transactions each month"*, then **$0.001 per settled payment**; verification is always
free, and testnet settlements are not exempted. Suite B settled 1,248 payments through CDP on 7 Sep,
so the free tier was exhausted by us, and the 402 on 8 Sep is documented behaviour rather than an
outage or a policy change. Consequences: (1) Suite C5 "facilitator terms" now has a number for CDP;
(2) any CDP load test costs money above 1,000 settlements in a calendar month — budget it, and
prefer the public facilitator for anything that only needs volume; (3) the tier resets monthly, so a
CDP re-run in a new month is free again. Do not confuse this with the public facilitator, which is
free and testnet-only.

**§10 status:** the plan's POS-credential rotation is a production-security item, not a test
prerequisite — no suite depends on it. It is tracked outside this repo; the report records it as open.

## The public facilitator refuses ~1 in 10 payments at concurrency 1 (verified 8 Sep 2026)

Not a load effect and not a percentile artefact: **24 of 222 sequential single A3 payments returned
an empty 402** — 8.8 % on the deployed Worker, 12.5 % on local dev. CDP returned 100/100.

This matters because criterion A's latency is computed over *successes*, so a latency PASS says
nothing about how often the payment happens at all. The plan has no reliability criterion; it should
have. The report now prints the delivery rate next to every Suite A verdict for exactly this reason.

## The 846 ms is the facilitator, measured rather than inferred (verified 8 Sep 2026)

Earlier the comparison was deployed-public (1483 ms) against local-CDP (2298 ms), which confounds
facilitator with host. Running both facilitators against the same local seller settles it:

| comparison | added p95 | what differs |
|---|---|---|
| local public → local CDP | **+846 ms** | the facilitator, nothing else |
| local public → deployed public | +31 ms | the host, nothing else |

So the host is nearly free and CDP deployed would land near **2328 ms** — still a FAIL. The
conclusion never depended on where the seller runs. Keep this shape when adding any new facilitator:
measure it against a local seller first, so the delta is attributable.

## The facilitator decides the go/no-go, not x402 (verified 7 Sep 2026)

**Each facilitator passes the criterion the other fails.** This is the central result of the bench.

| | public `x402.org/facilitator` | CDP `api.cdp.coinbase.com` |
|---|---|---|
| Added latency p95 (criterion A, < 2000 ms) | **1483 ms — PASS** | **2298 ms — FAIL** |
| Peak goodput (criterion B, > 10 rps) | **3.19/s — FAIL** | **49.95/s — PASS** |
| Verify (T3) p50 | 252 ms | ~190 ms |
| Settle (T4) p50 | 663 ms | ~1800 ms |
| Errors at concurrency 1 | yes | none |
| Settlement wallets observed | 1 | 14+ |

**Why B differs — one shared settlement wallet.** Sampling 20 settlement transactions from the
CDP ramp returned 14 distinct `from` addresses; CDP runs a pool. The public facilitator settles
everything from `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`, the address named in all 626
`replacement transaction underpriced` failures in the earlier ramp. One wallet means one nonce
sequence, which serialises settlement no matter how much concurrency arrives. The ~3/s ceiling is
that serialisation, so it is a property of a free shared testnet service and **must not be
reported as a limit of x402**.

**Why A differs — CDP trades latency for that concurrency.** CDP's settle is roughly 1.8 s against
the public facilitator's 663 ms, and it is over the 2000 ms threshold *at concurrency 1*, so it is
not a load effect. Its latency is also perfectly flat from c=1 to c=100 (~1.95 s p50, ~2.2 s p95),
which is the signature of a queue that is nowhere near saturated.

**Settlement cannot be moved off the critical path.** `SettlePhase` in `@x402/core` is
`"before-handler" | "after-handler" | "cancel"` — all three run inside the request, and
`@x402/hono` buffers the response body until settle returns. There is no deferred-settlement mode
in the v2 SDK, so settle time is unavoidably added latency. A seller could respond after verify and
settle out-of-band via `ctx.waitUntil`, but that is off-protocol and trades criterion E for
criterion A: content would ship before settlement is known to have succeeded. Do not treat that as
a free fix.

**Consequence for the memo.** Neither facilitator passes both A and B today, and no configuration
of ours changes that — the choice is a vendor property. Either criterion A's 2000 ms budget is
renegotiated (CDP's 2.3 s is stable and predictable, which is the easier argument), or a
facilitator that settles from a wallet pool *and* settles fast is required. Note that criterion A
was written for a vending machine, where a 2.3 s wait at the machine is a UX question rather than
a technical failure; that is a conversation to have rather than a number to defend.

**Criterion E holds structurally, for now.** Because settlement completes before delivery,
post-delivery settlement failure is zero by construction, not by luck — the 9 of 102 A3 failures
returned 402 with no content and moved no money. CDP settled 1,351 payments with zero failures.
Note that 0 failures in 1,351 trials only bounds the true rate at about 0.22 % at 95 % confidence;
claiming < 0.1 % from a zero-failure run needs roughly 3,000 samples. That precision only matters
if settlement is ever deferred past delivery.

## Why settlements failed, and one thing we could not explain (verified 8 Sep 2026)

`pnpm report` now groups settlement failures by cause. Two things about reading them:

**Group on the `Details:` line, not the first line.** Every settle error from this facilitator opens
with the same viem wrapper, `invalid_exact_evm_transaction_failed: Missing or invalid parameters.`,
which describes nothing. The RPC's own message is further down the string. Grouping on the first
line labelled 79 % of failures with a sentence that applied to none of them — the first version of
this table did exactly that.

Across 7,657 settlement failures on the public facilitator:

| cause | n | share |
|---|---|---|
| `replacement transaction underpriced` | 6,057 | 79.1 % |
| `invalid_exact_evm_signature` | 856 | 11.2 % |
| `over rate limit` (public Base Sepolia RPC) | 732 | 9.6 % |
| everything else | 12 | 0.2 % |

The first row is criterion B's failure in one line: a nonce collision on the single settlement
wallet. The third is a **separate** ceiling — the facilitator dials the public
`https://sepolia.base.org` RPC and gets rate limited there — so fixing the nonce serialisation
would not by itself lift throughput.

**The signature row is unexplained, and it is not our client.** All 856 passed the *same*
facilitator's `/verify` moments before, and all 856 carry no `Details:` line, meaning the
facilitator rejected them locally and never broadcast them. It contradicted its own verify. Ruled
out from the records: expiry (the window was 60 s, no failing settlement took longer than 5.8 s)
and nonce reuse (that reverts on chain, needs an RPC round trip, and shows up as
`nonce_already_used` — 2 of those exist, separately). These rejections are also *faster* than
successful settlements, which is the shape of a local bail-out. Only the facilitator's own logs can
close it out.

Do not read `invalid_exact_evm_signature` at settle as a client bug. The label accuses the client
and the data exonerates it.

## B5 — a paid request costs 2 subrequests, 3 on a cold isolate (verified 7 Sep 2026)

Measured by uploading versions with `limits.subrequests` set deliberately low and testing them on
their **version preview URLs**, so production traffic never saw the crippled config.

| `limits.subrequests` | first request in a fresh isolate | later requests |
|---|---|---|
| 1 | fails — `/supported` eats the allowance, verify never runs | fails at settle (verify used the 1) |
| 2 | **fails at settle** | succeed |
| default (1000 on Paid) | succeeds | succeed |

So verify is 1 subrequest, settle is 1, and `SYNC_FACILITATOR_ON_START` adds a `/supported` call on
the first paid request of each isolate. **Steady state is 2; a cold isolate is 3.**

Against the Paid default of 1000 per invocation (raisable to 10,000) that is roughly 500× headroom,
so the limit is not a risk for one payment per request. It becomes one only if a single invocation
ever settles many payments in a batch.

**The cold-isolate extra subrequest is a real trap.** At a limit of exactly 2 the harness failed on
the first request of each new isolate and succeeded on every one after it — an intermittent failure
that correlates with isolate churn rather than with anything in the request, which is close to
undebuggable in production. Anyone tightening `limits.subrequests` must budget for 3, not 2, or
turn `SYNC_FACILITATOR_ON_START` off.

**It fails closed.** Subrequest exhaustion returned 402 with no content and no settlement — the
buyer is not charged and the content does not ship. Criterion E survives this failure mode.

**Subrequest limits cannot be tested locally.** With `limits.subrequests: 1` in `wrangler.jsonc`,
local `wrangler dev` served paid requests perfectly happily. The limit is enforced only on
deployed Workers, so any test of it has to run against a deployment — use
`wrangler versions upload` and its preview URL rather than degrading the live Worker, which is
also serving Suite D's held authorizations.

## Reusing an `upto` authorization is refused at verify, for free (verified 8 Sep 2026)

Presenting an already-settled `upto` authorization a second time returns
`verifyReason: permit2_simulation_failed` from **verify**. Settle is never attempted, nothing is
broadcast, no gas is spent. Permit2 allows one settlement per nonce and the simulation catches it.

Contrast with `exact` (next section): that replay is broadcast, mined, reverted, and costs the
facilitator gas. This is the sharpest single argument for `upto` over `exact`.

Found by accident, which is the part worth remembering: a `D3` record at `holdSeconds: 3600` looked
like a 1 h-window failure with an empty 402 body, and the report called it unattributable because
no local seller log was being captured. The reason was in the `wrangler dev` terminal all along.
The record shared its `requestId` *and* `authorizedAt` with a D3 row that had already settled 73 s
in, so `pnpm settle --keep` had left the pending file behind and the 1 h settler re-presented a
spent authorization. Quarantined as `mislabeled-d3-reused-authorization.jsonl`.

Two lessons: **join Suite D records on `authorizedAt` as well as `requestId`** before believing a
hold duration, and when a local run yields an empty 402, read the dev server's terminal rather than
recording the failure as unexplained.

## Replay of `exact` is rejected on chain, not at verify (verified 7 Sep 2026)

E3 presents one signed `exact` payload twice. The replay is correctly refused — but the refusal
happens in the USDC contract, not in the facilitator:

| | `exact` (EIP-3009) | `upto` (Permit2) |
|---|---|---|
| Where replay is caught | USDC contract's nonce check, **after broadcast** | facilitator verify, `permit2_simulation_failed` |
| Facilitator gas burned | 40,883, transaction reverts | none |
| Money moved | no — status `0x0`, zero logs | no |

The replayed transaction was mined in the same block as the legitimate settlement it copied
(46516086) with status `0x0` and no Transfer event, so there is **no double-charge**. Confirmed by
receipt, not inferred from the 402.

**Two consequences.**

1. `upto` is meaningfully safer than `exact` against replay, and cheaper to refuse. This adds to
   the earlier finding that `upto` also fails closed on a past deadline.
2. Replay spam is an availability attack on the facilitator, not on us. Every replayed `exact`
   payload costs the facilitator a reverting transaction from the **same single wallet** that is
   already the throughput ceiling (see the facilitator comparison above). An attacker replaying
   captured payloads cheaply degrades that wallet's nonce sequence for every other seller using
   the public facilitator. We are not exposed to loss, but we are exposed to the outage — which is
   another argument for not depending on a shared public facilitator in production.

## Suite F notes worth keeping (verified 8 Sep 2026)

**MCP is a different transport, not a different client.** x402 over MCP carries the payment in
JSON-RPC `_meta` (`MCP_PAYMENT_META_KEY`) and turns the 402 into a JSON-RPC error code
(`MCP_PAYMENT_REQUIRED_CODE`), so an MCP-paying agent cannot pay a plain HTTP x402 route and our
seller's routes are unreachable to it. If the vending machine is ever exposed to MCP agents it needs
an MCP surface of its own; `withX402Client` will not pay an HTTP endpoint.

**Per-session MCP transports are mandatory.** Creating a `StreamableHTTPServerTransport` per HTTP
request loses the `initialize` handshake, and the tool call that follows is refused with
`Bad Request: Server not initialized` **before payment is attempted**. Cost an hour; worth knowing
before anyone builds a paid MCP server.

**`agents` needs zod ^4, `@x402/core` needs zod ^3.** pnpm's isolated layout gives each its own copy
and both work. A flat `node_modules` (npm, yarn) hoists one, and a Zod schema crossing that boundary
would meet a different Zod instance. The bench's paid tool uses an empty parameter schema, so this
does **not** prove the schema path is safe under a flat install — check it if the build uses npm.

**The unattended-agent question is in the API, not the docs.** `withX402Client`'s `callTool` takes
a confirmation callback as its *first* argument, and `maxPaymentValue` defaults to 0.10 USDC. An
agent running with no human has to answer that callback itself, so the spending cap is the only real
control. Same shape in F4: the coding-agent hook holds the key in `X402_PRIVATE_KEY` and pays on a
402 automatically.

## Layout

```
packages/seller   Cloudflare Worker: Hono + @x402/hono. Routes /free, /paid/exact, /paid/upto,
                  /paid/exact-id, /paid/fail500, /paid/slow, /health. Emits one JSON log line per
                  request and a Server-Timing header (verify, settle, handler, total).
packages/buyer    Node scripts: wallet, permit2, run-one, authorize, settle, abuse, load.
                  abuse covers the Suite E cases that need a tampered or replayed payment
                  (E3 replay, E5 empty wallet, E6 wrong network, E7 corrupt signature).
packages/shared   Record types, header names, Server-Timing parser.
scripts/report.ts Reads results/*.jsonl, prints p50/p95/p99, added latency, Suite D and E tables.
results/          JSONL output (gitignored). pending/ holds unsent upto authorizations.
```

## Phase timing

| Phase | Where measured | Field |
|---|---|---|
| T1 unpaid request → 402 | buyer | `t1Ms` |
| T2 signature construction | buyer, client hooks | `t2Ms` |
| T3 facilitator verify | seller hooks → Server-Timing `verify` | `t3Ms` |
| T4 facilitator settle | seller hooks → Server-Timing `settle` | `t4Ms` |
| T5 delivery overhead | buyer: paid round trip − (T3 + T4 + handler) | `t5Ms` |

Workers clocks only advance across I/O, so T3/T4 are accurate (they are I/O) but the seller cannot
measure its own CPU time. Use the Workers observability dashboard for H2.

## Conventions

- pnpm workspace, TypeScript strict, ESM. `pnpm typecheck` must pass before a commit.
- **Never commit keys.** The buyer key lives in `.env`, the seller's `PAY_TO` in
  `packages/seller/.dev.vars` locally and `wrangler secret` in production. Both are gitignored.
- Test wallet balance stays under 20 USD. Never reuse the key elsewhere.
- `base-sepolia` (`eip155:84532`) for every functional test. Mainnet only for C1, G1, I, with
  finance informed first.
- Every record carries the date and package versions. Results are valid for 90 days.
- Announce load tests (Suite B) before running them against the public facilitator.
- Fault injection (`x-bench-fault` header) only works when `BENCH_FAULTS_ENABLED=true`, which is set
  in `.dev.vars` for local runs and `"false"` in `wrangler.jsonc` for the deployed Worker. **Suite E
  runs against local `wrangler dev`**; A, B and H run against the deployed Worker.
- Records produced by a harness defect are not results. Move them to `results/quarantine/` (the
  report only reads top-level `*.jsonl`) and say in the report why they were excluded.

## Suite checklist

- [~] A latency — A1/A2/A3 done 7 Sep against the deployed Worker at n=100 each, and **re-run 8 Sep
      against a local seller on both facilitators at n=100** so the facilitator delta is measured
      rather than inferred (+846 ms facilitator, +31 ms host). A4 is the five-phase split, which is
      the T1–T5 columns of the report's latency table rather than a separate run. **The public
      facilitator delivered only 87.5–91.2 % of single sequential payments; CDP delivered 100/100.**
      **Added latency p95 = 1483 ms on the public facilitator, PASS** (threshold 2000).
      **On CDP the same measurement is 2298 ms local and 2173 ms on the deployed Worker (8 Sep), FAIL**
      at n=100 with 100/100 delivered. CDP is over the threshold at concurrency 1, so this is not a load
      effect — its settle step costs ~1.8 s against the public facilitator's 663 ms. A5 (Amsterdam,
      São Paulo, Singapore) is outstanding: every request so far came from the `AMS` colo, so it
      needs buyers run from outside Europe. All figures are per-seller **and per-facilitator** in
      the report — never blend local with deployed, or one facilitator with the other.
- [~] B throughput — **the criterion depends entirely on which facilitator answers.**
      Public facilitator (deployed Worker): peak goodput **3.19 settled payments/s** at concurrency
      50, **FAIL**. Errors start at concurrency 1, so there is no error-free rate at all. B4 held
      concurrency 5 for 30 minutes: 12,729 requests, 4,077 settled, **2.26/s flat for the whole
      window** — no warm-up, no decay, no recovery, so the ceiling is structural.
      CDP facilitator (local dev, `B6-cdp`): **49.95 settled payments/s, zero errors at every
      level** from 1 to 100, latency flat at ~1.95 s throughout. **PASS.** That figure is a floor,
      not CDP's ceiling: the top two levels hit the 400-request cap before their 20 s elapsed.
      **Deployed Worker against CDP (8 Sep, preview `a4482f68`): 39.8 settled/s at c=100, zero errors,
      request-capped — see the finding above.** **B4 hold on CDP done 8 Sep (launched manually): 21.4 min flat
      at 9.91 req/s, zero errors until the wallet emptied** — see "Suite A/B on the deployed Worker".
      **B5 done** — see the subrequest finding below.
- [~] C cost — **C3, C4, C5 done 8 Sep** on `base-sepolia` and from the chain. **C1/C2 on Base mainnet started
      8 Sep 16:02 UTC: 20/20 delivered (`C1-evening`), settle p50 803 ms, gas p50 86,242 ≈ 0.0000016 ETH ≈ $0.004
      paid by CDP; `pnpm gas` reads receipts into `results/mainnet-gas.json`.** **`C1-morning` done 9 Sep 08:08 UTC
      (late — see the VM section): 20/20, settle p50 697 ms, same gas (86,242) but fee ≈ $0.0012 against the evening's
      $0.0041 — gas price, not gas used, is what moves with the hour.** **`C1-midday` done 9 Sep 12:00 UTC: 20/20,
      settle p50 829 ms, but fee ≈ $0.98–1.27 per settlement — a Base gas spike (see the finding below). C1 complete:
      61/61 over three times of day, added latency p95 1697 ms (n=60).** C3: the floor is one atomic unit,
      $0.000001, and it settles; **anything smaller truncates to zero silently and still delivers** (see the
      finding below). C4: the facilitator pays settlement gas under both schemes, every time — the buyer paid
      gas once (Permit2 approval) and its ETH has not moved since. C5: public facilitator publishes no fee, no
      limit, no SLA and no terms page, and is testnet-only per the x402 FAQ; CDP is 1,000 settlements/month
      free then $0.001 each, verification free, testnet counted.
- [x] D `upto` semantics — **done 9 Sep.** D1, D2 (40 % and 0) and D6 done 7 Sep. Five authorizations signed against
      the deployed seller are held for the 1 h / 6 h / 24 h / 40 h settles and the past-deadline D5;
      times, ids and commands are in `docs/suite-d-schedule.md`. D7 comes from the report.
      **D4 24 h: PASS — settled 8 Sep 15:50 UTC after 87,114 s (24.2 h), tx `0xb04f0070…`; D6 on the same
      nonce three minutes later refused `permit2_simulation_failed`.** The first presentation at 15:38 failed
      `permit2_insufficient_balance` because the B4 hold had emptied the wallet — four records quarantined as
      a funding artifact, wallet refilled from the CDP faucet API (5 USDC). **D4 40 h: PASS — settled 9 Sep 08:08 UTC
      after 145,780 s (40.5 h), tx `0x8298c858…`; target was 07:38, the VM was hibernated, real elapsed time is
      reported.** **D5: presented at 49 h (176,400 s), refused at verify `permit2_deadline_expired`, T3 190 ms, no tx, no gas — the 48 h window is enforced.** **D1/D2 on CDP (deployed): 3 of 18 delivered —
      `No matching payment requirements`, see the finding above.**
- [x] **E failure — done 7 Sep, all eight cases, every one fails closed. Re-run on CDP 8 Sep (`*-cdp`):
      all fail closed; CDP refuses the `exact` replay and the empty wallet at verify with
      `invalid_payload: … execution reverted` (it simulates; the public facilitator does not, and burns gas
      on the replay). Settle-block on CDP → our 10 s timeout → 502, no charge.** Run against local
      `wrangler dev` with `BENCH_FAULTS_ENABLED=true`; fault injection must never be enabled on a
      deployed Worker. E1 verify-block → 502, verify never ran. E2 settle-block → 502 after a
      successful verify, no settlement. E3 replay → rejected, but on chain rather than at verify
      (see the replay-gas finding below). E4 duplicate payment id → second presentation 402.
      E5 empty wallet, E6 rewritten network, E7 corrupted signature → all 402 at verify, no gas.
      E8 handler 500 → **settlement cancelled**, buyer signed an authorization and was not charged.
      **No case delivered content without moving money, and none moved money without delivering
      content**, so criterion E is met on the evidence rather than merely on the structure.
- [x] **F clients — done 8 Sep. Every client that exists and can pay, pays.** `pnpm clients --case all`.
      F1 `@x402/fetch` works (the whole bench runs on it). **F2 and F3 are one integration**, not two:
      `agents/x402` exports `withX402(server)` for the `paidTool` method and `withX402Client(client)`
      to pay it — works, over MCP `_meta` rather than HTTP headers, so it needs a real MCP server and
      cannot reuse an HTTP route. **F6 confirms the MPP backward-compatibility claim**: the `mppx` CLI
      paid our seller unchanged, translating our 402 into MPP's `intent: charge` / `method: evm`.
      **F4 is not a client** — the Claude Code hook and OpenCode plugin are user-authored wrappers
      around `@x402/fetch`, no package to install, so the payment path is F1's; not run here because
      installing an auto-paying hook changes the operator's own machine. **F5 is facilitator-side
      only** — `@coinbase/x402` ships no client or wallet helper, and the CDP facilitator itself is
      verified thoroughly elsewhere. Matrix and setup-effort notes are in the report.
- [~] G networks — `pnpm facilitators` prints the live matrix from both `/supported` endpoints.
      CDP advertises 26 kinds including `eip155:84532` (exact, upto, batch-settlement), which is
      what let Suite B be re-run on test USDC with no mainnet exposure and no finance sign-off.
      CDP adds Base mainnet, Polygon, Arbitrum, World Chain and Solana over the public facilitator;
      the public one uniquely carries the algorand/aptos/hedera/stellar/xrpl testnets. **G1 done 8 Sep:
      one `exact` payment on Base mainnet through `x402-bench-seller-mainnet` + CDP, 1665 ms, tx `0xd7a6133e…`,
      0.001 USDC landed at the seller's Coinbase address.** Finance brief waived by the project owner (recorded in memo).
- [~] H Cloudflare — **H2 done** from the tail captures: paid requests use 3 ms CPU at p50, 5 ms at
      p95, 34 ms worst across 2,098 invocations, against the Paid limit of 30,000 ms. CPU is a
      non-issue; the Worker waits on the facilitator (602 ms wall at p50) rather than computing.
      Note the Free plan's 10 ms limit *would* have been breached. **H4 done**: the 402 crosses
      Cloudflare unchanged and carries `no-store`. **H1 done**: the 402 carries `no-store` and the
      paid 200 carries `cache-control: private`, set by the SDK's `withPrivateCacheControl` rather
      than by us — this corrects an earlier note here that claimed paid responses were unprotected.
      H3 (WAF, rate limiting) outstanding; it needs dashboard configuration.
- [x] I money out — **done 8 Sep by the project owner on a retail Coinbase account** (`results/suite-i.json`, rendered
      by the report): 5.66311 USDC → €4.84 at 0.8547, Exchange mid 0.8606 → **0.69 % all-in**, labelled
      "0.5 % spread, €0.00 fee"; EUR available in ≈ 1 min; bank leg not run. I3/I4 from the receipts: the join
      key between POS line and settlement must be a mandatory payment id; amounts are USDC, books are EUR;
      `upto` settlement time ≠ sale time.

## Operational notes

- The testnet seller is live at `https://x402-bench-seller.jetskibay.workers.dev` on a Workers Paid account
  (so the Paid subrequest limit applies — see the B5 note), faults off. The mainnet seller is a separate
  Worker, `x402-bench-seller-mainnet`.
- Buyer wallet `0xC7C221236F48B510be4Db4511D093bdbf32916E1`. On 7 Sep it held 19.938 USDC and 0.0016 ETH on
  Base Sepolia with the USDC→Permit2 allowance set; the ETH paid for that one approval and nothing else in the
  harness costs buyer gas. Each paid request spends 0.001 USDC. **8 Sep: the B4 hold drained it to 0.000998 USDC
  and broke the first D4 24 h presentation; refilled to 5.00 USDC from the CDP faucet API**
  (`POST api.cdp.coinbase.com/platform/v2/evm/faucet`, JWT from `@coinbase/cdp-sdk/auth` with the CDP keys in
  `.dev.vars`; 1 USDC per call, 10 USDC per address per rolling 24 h; no browser or CAPTCHA). **Check the balance
  before any long-held settlement and before any load run.** On Base mainnet the same address held 11.29 USDC
  and 0 ETH on 8 Sep — enough for the `exact` payments of C1/C2/G1, which need no buyer gas.
- CDP facilitator credentials (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`) are needed for every CDP run and for
  Suites C1, G1 and I; they live in `.dev.vars` locally and in Worker secrets when deployed.

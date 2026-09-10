# x402 Protocol Test Plan

**Owner:** AI Engineering, Prosus
**Status:** Draft for team review
**Date:** 7 September 2026

---

## 1. Purpose

This plan measures the x402 protocol in isolation. We do a test of the protocol
on a bench harness. We do not connect it to the vending machine or to the POS.

The plan answers one question: what does x402 do, and what does it not do, before
we build on it.

The result is a benchmark report and a go/no-go decision for the vending build.

### What we must learn

Four groups of unknowns exist. Each group can change the design of the vending
build or stop it.

1. **Performance.** How much latency does a payment add to a request?
2. **Limits.** Where does the public facilitator stop us? What is the smallest
   amount we can charge?
3. **Semantics of the `upto` scheme.** How long does an authorization stay valid?
   The reservation design depends on this number.
4. **Failure behavior.** What happens when a payment verifies but does not settle?

We cannot answer these from the documentation. This is the reason for the test.

---

## 2. Scope

### In scope

- The x402 protocol on Cloudflare Workers.
- The `base-sepolia` test network for all functional tests.
- The `base` main network for a small cost test and an off-ramp test.
- The public facilitator at `https://x402.org/facilitator`.
- The client SDKs: `@x402/fetch`, `x402-hono`, and `agents/x402`.

### Out of scope

- The POS, the vending machine, and the public storefront.
- Cloudflare Monetization Gateway. It is not available. A waitlist is open.
- Real customer money and real products.
- Cloudflare Wallets. Only handle reservation works at this time.

### Non-goals

This test does not measure revenue. It does not measure demand. Network-wide
x402 volume decreased 93% in 2026. We expect no external buyers. Demand is a
separate question for a later test.

---

## 3. The bench harness

Build two small services. Keep both isolated from production.

**The seller.** A Cloudflare Worker with `x402-hono` middleware. It serves a
fixed payload of a known size. It has one route for each scheme under test.

**The buyer.** A script with `@x402/fetch` and a test wallet. It can run one
request or many concurrent requests. It records timing for each step.

**The recorder.** Structured logs for every request. Each log line has a request
ID, a timestamp for each phase, the HTTP status, and the settlement result.

### Instrumentation

Measure these five phases separately. A single end-to-end number hides the cause
of a delay.

| Phase | What it measures |
|---|---|
| T1 | Unpaid request to the 402 response |
| T2 | Client signature construction |
| T3 | The `POST /verify` call to the facilitator |
| T4 | The `POST /settle` call to the facilitator |
| T5 | Resource delivery after settlement |

---

## 4. Test suites

### Suite A — Latency and overhead

**Why:** A payment adds work to every request. We must know the cost in
milliseconds before we put it in a user-facing flow.

Do these tests:

- A1. Measure the baseline. Request the same payload with no payment gate.
- A2. Measure the 402 response time with no payment.
- A3. Measure the full paid request, end to end.
- A4. Break A3 into the five phases in section 3.
- A5. Repeat A3 from three regions. Amsterdam, Sao Paulo, and Singapore.

**Report:** p50, p95, and p99 for each test. Report the added latency as the
difference between A3 and A1.

**Note:** Cloudflare states a target of sub-second settlement for its own
gateway. We must measure what the public facilitator gives us.

### Suite B — Throughput and facilitator limits

**Why:** The public facilitator is a free third-party service. Its rate limits
are not published. If we depend on it, we must know where it stops.

Do these tests:

- B1. Ramp concurrent paid requests: 1, 5, 10, 25, 50, 100.
- B2. Record the request rate at which errors first appear.
- B3. Record the error type and the HTTP status of each failure.
- B4. Hold the maximum stable rate for 30 minutes. Look for degradation.
- B5. Count the Worker subrequests per paid request. Compare with the Workers
  subrequest limit for our plan.

**Report:** The maximum sustained request rate. The failure mode at the limit.

**Note:** B5 matters. Each facilitator call is a subrequest from the Worker.
The plan limit can bind before the facilitator does.

### Suite C — Cost per transaction

**Why:** The economic case depends on the true cost of one payment.

Do these tests:

- C1. Measure the gas cost of 20 settlements on `base` main network.
- C2. Record the cost at three times of day. Gas prices change.
- C3. Find the smallest amount the scheme can express. Test decimal granularity.
- C4. Identify who pays the gas: the buyer, the seller, or the facilitator.
- C5. Read the terms of the public facilitator. Record any fee and any limit.

**Report:** Cost per transaction in USD. The minimum chargeable amount.

### Suite D — Scheme semantics

**Why:** The vending reservation design uses the `upto` scheme. The design
assumes that an authorization survives for 24 hours. We must measure the real
number.

Do these tests:

- D1. Authorize with `upto`. Settle immediately. Confirm the amount.
- D2. Authorize with `upto`. Settle for less than the authorized maximum.
- D3. Authorize with `upto`. Wait 1 hour. Then settle.
- D4. Repeat D3 at 6 hours, 24 hours, and 48 hours.
- D5. Authorize. Do not settle. Record what happens to the authorization.
- D6. Attempt a second settlement on one authorization.
- D7. Compare `exact` and `upto` on latency and cost.

**Report:** The maximum time between authorization and settlement. State whether
partial settlement works.

**Decision gate:** If the authorization window is shorter than our redemption
window, the reservation design must change. This test result drives that
decision.

### Suite E — Failure and resilience

**Why:** The worst case in the vending design is a dispensed snack with an
unsettled payment. We must know how the protocol fails.

Do these tests:

- E1. Block the facilitator at the verify step. Record the client experience.
- E2. Block the facilitator at the settle step, after resource delivery.
- E3. Replay a used payment signature. Confirm that the server rejects it.
- E4. Retry an identical request. Test the payment-identifier extension for
  double-payment protection.
- E5. Pay with an underfunded wallet.
- E6. Pay on the wrong network.
- E7. Send a malformed signature.
- E8. Return a 500 from the origin after a verified payment. Confirm that no
  settlement occurs.

**Report:** A failure table. For each failure, record the client result, the
server result, and whether money moved.

**Note:** E2 is the important one. AWS skips settlement when the origin returns
an error. We must confirm that our own implementation does the same.

### Suite F — Client compatibility

**Why:** A payment endpoint has no value if agents cannot pay it. We must know
which clients work today.

Test each client against the same endpoint:

- F1. `@x402/fetch`.
- F2. Cloudflare Agents SDK with `withX402Client`.
- F3. A `paidTool` MCP endpoint with an MCP client.
- F4. The Claude Code hook and the OpenCode plugin.
- F5. Coinbase CDP tooling.
- F6. An MPP client against the x402 endpoint. MPP is backward compatible with
  x402. Confirm this claim.

**Report:** A compatibility matrix. Record the setup effort for each client.

### Suite G — Network comparison

**Why:** Base is the default. It is not the only option. Supported networks
include Base, Ethereum, Polygon, Optimism, Arbitrum, Avalanche, Solana, Aptos,
Stellar, and Sui.

Do these tests:

- G1. Measure settlement time and cost on Base.
- G2. Repeat on Solana and on Polygon.
- G3. Record which schemes each network supports. The `upto` scheme is EVM only.

**Report:** A table of network, settlement time, cost, and scheme support.

### Suite H — Cloudflare integration

**Why:** Our Worker sits in the request path. Cloudflare features can interfere
with a payment gate.

Do these tests:

- H1. Put a paid route behind the cache. Record whether cached hits bypass the
  Worker and the payment gate.
- H2. Measure Worker CPU time per paid request.
- H3. Test a paid route with an existing WAF rule and with rate limiting.
- H4. Confirm that a 402 response passes through the network unchanged.

**Report:** A list of features that conflict with a payment gate.

### Suite I — Money out

**Why:** Revenue in USDC is not revenue until it reaches a bank account. This
step is where the real cost sits.

Do these tests, with a small amount and with finance informed first:

- I1. Move a small real amount of USDC to EUR. Measure the time.
- I2. Record the spread and every fee.
- I3. Record what receipt data the settlement gives us.
- I4. Assess whether that data is enough for reconciliation with a POS sale line.

**Report:** Time to fiat, total cost as a percentage, and the reconciliation gap.

---

## 5. Go/no-go criteria

The vending build proceeds when all four criteria pass.

| Criterion | Threshold | Suite |
|---|---|---|
| Added latency, p95 | Less than 2000 ms | A |
| Sustained request rate | More than 10 per second | B |
| `upto` authorization window | 24 hours or more | D |
| Settlement failure rate after delivery | Less than 0.1% | E |

If the authorization window fails, we do not stop the build. We change the
design to a short redemption window and we state that limit in the proposal.

---

## 6. Deliverables

1. **The bench harness.** A repository with the seller Worker, the buyer script,
   and the load runner. It is reusable by other Prosus teams.
2. **The benchmark report.** All numbers from suites A to I, with the method for
   each.
3. **The failure table.** Suite E, in a form an engineer can design against.
4. **The compatibility matrix.** Suite F.
5. **A decision memo.** Two pages. The go/no-go result and the design changes
   that the results force.

---

## 7. Plan

| Days | Work | Suites |
|---|---|---|
| 1-2 | Build the bench harness and the instrumentation | — |
| 3-4 | Performance and limits | A, B |
| 5 | Cost and networks | C, G |
| 6-7 | Scheme semantics. D4 needs 48 hours of elapsed time | D |
| 8-9 | Failure and resilience | E |
| 10 | Client compatibility | F |
| 11 | Cloudflare integration | H |
| 12 | Money out, with finance | I |
| 13-14 | Write the report and the decision memo | — |

Start suite D early. Its 48-hour test blocks the schedule if it starts late.

---

## 8. Roles

| Role | Work |
|---|---|
| Engineer 1 | Harness, suites A, B, H |
| Engineer 2 | Suites C, D, E, G |
| Engineer 1 or 2 | Suite F |
| Finance contact | Suite I, and the off-ramp account |
| Security contact | Review of key handling before main network tests |
| Manager | Review of the decision memo |

---

## 9. Risks in the test itself

| Risk | Control |
|---|---|
| A key leaks from the test wallet | Use a wallet with less than 20 USD. Never reuse the key. |
| The main network tests cost more than planned | Cap the wallet balance. Use `base-sepolia` for all functional tests. |
| The public facilitator changes behavior mid-test | Record the date and version of every result. |
| Test traffic looks like abuse to the facilitator | Announce the load test intent. Respect published limits. |
| Results date quickly | The report states a validity period of 90 days. |

---

## 10. Prerequisite

One item is not part of this plan and it must happen first: rotate the POS operator
credential and make sure it does not appear on any public page.

---

## 11. What this plan does not tell us

The plan measures the protocol. It does not measure the market.

After the report, we still do not know whether any external agent wants to buy
from us. That question needs a live endpoint and real traffic. It is the subject
of the vending build, not of this test.

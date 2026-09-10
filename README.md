# x402-bench

A bench harness that measures the [x402](https://x402.org) payment protocol in isolation: a seller
Worker on Cloudflare, a buyer script, per-phase timing, a load runner, fault injection, and a report
generator. Built by Prosus AI Engineering to answer four questions before a vending-machine build:
how much latency a payment adds, where the facilitator limits us, how long an `upto` authorization
stays valid, and what happens when a payment verifies but does not settle.

Run 7–9 September 2026 on x402 v2 (`@x402/core` 2.25.0): 30,812 paid requests across two
facilitators (public `x402.org` and Coinbase CDP) and two networks (Base Sepolia, Base mainnet).

## Results

| Document | What it is |
|---|---|
| [`docs/go-no-go-memo.md`](docs/go-no-go-memo.md) | Two-page decision memo with the four criteria, the recommendation and the limitations |
| [`results/report-2026-09-09.md`](results/report-2026-09-09.md) | Full report: latency by phase, throughput, `upto` window, failure table, compatibility matrix, cost, money out |
| [`docs/x402-bench-complete-report-2026-09-09.pdf`](docs/x402-bench-complete-report-2026-09-09.pdf) | Memo and report as one 19-page PDF |
| [`docs/findings.md`](docs/findings.md) | Engineering notes: every finding with its evidence, corrections to the plan text, and the suite checklist |
| [`docs/x402-protocol-test-plan.md`](docs/x402-protocol-test-plan.md) | The test plan the bench executes |

The headline: **x402 is not the constraint, the facilitator is.** The public facilitator passes the
latency criterion and fails throughput (one settlement wallet); CDP passes throughput and fails
latency on Base Sepolia but passes it on Base mainnet. `upto` honours a 48 h window (settled at 24.2 h
and 40.5 h, refused at 49 h) and is broken on CDP behind a multi-isolate Worker. All eight failure
cases fail closed on both facilitators. Raw records are archived in `results/` so `pnpm report`
reproduces every number.

## Layout

```
packages/seller   Cloudflare Worker: Hono + @x402/hono. Routes /free, /paid/exact, /paid/upto,
                  /paid/exact-id, /paid/fail500, /paid/slow, /health. One JSON log line per request
                  and a Server-Timing header (verify, settle, handler, total). Facilitator is
                  selectable: public or CDP (per-call Ed25519 JWT).
packages/buyer    Node scripts: wallet, permit2, run-one, authorize, settle, abuse, load, suite-f,
                  mainnet-gas.
packages/shared   Record types, header names, Server-Timing parser.
scripts/report.ts Reads results/*.jsonl and writes results/report-<date>.md.
scripts/run-at.sh Runs a buyer batch at an absolute UTC time (polls, so it survives sleep).
scripts/vm-tmux.sh Starts long-held jobs in a detached tmux session on a VM.
results/          Raw buyer records, settled authorizations, quarantine, gas receipts, the report.
```

## Prerequisites

- Node 22+, pnpm 9+
- A Cloudflare account (Workers Paid for the deployed runs; `wrangler dev` works without one)
- A test wallet on Base Sepolia with a few USDC and a little ETH. `pnpm wallet` creates one.

## Setup

```bash
pnpm install
cp .env.example .env
cp packages/seller/.dev.vars.example packages/seller/.dev.vars   # then set PAY_TO
pnpm wallet          # generates BUYER_PRIVATE_KEY in .env, prints the address and faucet links
```

Fund the printed address with Base Sepolia USDC (<https://faucet.circle.com>) and a little Base
Sepolia ETH (<https://portal.cdp.coinbase.com/products/faucet>) for the one-time Permit2 approval,
then:

```bash
pnpm permit2
```

## Seller

```bash
pnpm dev             # wrangler dev on http://localhost:8787
curl -s localhost:8787/health
curl -si localhost:8787/paid/exact | head -20     # 402 with PAYMENT-REQUIRED header
```

Deploy after `npx wrangler login` and `wrangler secret put PAY_TO` in `packages/seller`:

```bash
pnpm deploy
```

To point the deployed seller at CDP without touching the live version, upload a preview:

```bash
cd packages/seller && npx wrangler versions upload --var FACILITATOR_PROVIDER:cdp
```

### Mainnet seller (Suites C1, C2, G1, I)

`env.mainnet` in `packages/seller/wrangler.jsonc` is a separate Worker on `eip155:8453` through CDP.
It needs three secrets; wrangler prompts for the values.

```bash
cd packages/seller
npx wrangler deploy --env mainnet
npx wrangler secret put PAY_TO --env mainnet
npx wrangler secret put CDP_API_KEY_ID --env mainnet
npx wrangler secret put CDP_API_KEY_SECRET --env mainnet
```

Buyer runs against it with `NETWORK=eip155:8453 RPC_URL=https://mainnet.base.org SELLER_URL=<mainnet worker url>`.
`exact` payments need no buyer ETH: the facilitator pays gas. `pnpm gas` reads the settlement receipts
from the chain into `results/mainnet-gas.json`.

## Buyer

```bash
pnpm buyer --route /free --suite A --test A1 --n 20          # baseline
pnpm buyer --route /paid/exact --suite A --test A3 --n 20    # full paid flow
pnpm buyer --route /paid/upto --suite D --test D1            # upto, settle immediately
pnpm buyer --route "/paid/upto?charge=40%" --suite D --test D2   # partial settlement
```

Output columns: first/final HTTP status, then T1 (402), T2 (signature), paid round trip,
T3 (verify), T4 (settle), T5 (delivery overhead), total, and the settlement transaction.

### Suite D: hold an authorization, settle later

```bash
pnpm authorize --route /paid/upto                 # signs, stores results/pending/<id>.json
pnpm settle --id <id> --test D3 --after 1h        # waits until authorizedAt + 1h, then presents it
pnpm settle --id <id> --test D6 --keep            # keep the file to present it a second time
```

The deadline the client signs is `now + UPTO_MAX_TIMEOUT_SECONDS` from the seller config (default
48 h). `--after` polls an absolute target, so a machine that sleeps fires late but does not lose the
test. Check the wallet balance before presenting a long-held authorization: an empty wallet fails at
verify with `permit2_insufficient_balance` whatever the authorization's age.

### Suite E: fault injection

Faults need `BENCH_FAULTS_ENABLED=true`, which is set in `.dev.vars` only, so run Suite E against
local `wrangler dev` with `SELLER_URL=http://localhost:8787`.

```bash
pnpm buyer --route /paid/exact --suite E --test E1 --fault verify-block
pnpm buyer --route /paid/exact --suite E --test E2 --fault settle-block
pnpm buyer --route /paid/exact --suite E --test E8 --fault handler-500
pnpm buyer --route /paid/exact-id --suite E --test E4 --payment-id pay_bench_0000000001 --n 2
pnpm abuse --case all             # E3 replay, E5 empty wallet, E6 wrong network, E7 corrupt signature
```

### Suite B: load

```bash
pnpm load --route /paid/exact --ramp 1,5,10,25,50,100 --seconds 20
pnpm load --route /paid/exact --hold 30m --concurrency 10 --max-requests 2000
```

`--max-requests` caps the spend: every request costs `EXACT_PRICE`, so a 30-minute hold at 10 rps is
18,000 payments (18 USDC at the default price) and, on CDP, 18,000 billable settlements. The report
judges throughput on settled payments per second, not on raw request rate.

### Suite F: clients

```bash
pnpm clients --case all           # @x402/fetch, agents/x402 over MCP, mppx
pnpm facilitators                 # live /supported matrix of both facilitators
```

## Report

```bash
pnpm report          # writes results/report-<date>.md from results/*.jsonl
pnpm gas             # mainnet settlement receipts -> results/mainnet-gas.json
```

Seller-side records from a deployed Worker come from `pnpm tail > results/seller-tail.jsonl` while
tests run. Records produced by a harness defect or a funding artifact are moved to
`results/quarantine/` and explained in `results/README.md`; the report reads only top-level files.

## Rules the bench followed

- Keys live only in `.env` and `.dev.vars`, both gitignored. Never commit a key.
- The test wallet stays under 20 USD.
- Every functional test on `eip155:84532` (Base Sepolia). Mainnet only for cost, one real payment, and
  money out.
- Every figure is reported per host, per facilitator and per network. Nothing is blended.
- Fault injection is never enabled on a deployed Worker.

# results/

Benchmark output. The raw buyer records, settled authorizations, quarantined records and the final report are
archived here so `pnpm report` reproduces every number. Not tracked: `pending/` (unspent authorizations), the
176 MB Suite B seller tail, and run logs.

- `buyer-YYYY-MM-DD.jsonl` — one `BuyerRecord` per request, written by the buyer scripts.
- `seller-tail.jsonl` — optional; save `pnpm tail > results/seller-tail.jsonl` while running tests.
- `pending/<requestId>.json` — signed `upto` authorizations waiting for `pnpm settle` (Suite D).
- `settled/<requestId>.json` — authorizations that have been presented.
- `report-YYYY-MM-DD.md` — output of `pnpm report`.

Record schemas live in `packages/shared/src/index.ts`.

## 8 Sep 2026 — Suite E abuse cases re-run against CDP

`pnpm abuse` has no test-suffix flag, so its four records from the CDP run (local dev on port 8797 with
`FACILITATOR_PROVIDER=cdp`, 8 Sep ~12:30 UTC) were written as `E3`/`E5`/`E6`/`E7` and then relabelled
`E3-cdp`/`E5-cdp`/`E6-cdp`/`E7-cdp` in `buyer-2026-09-08.jsonl`, selected by `url` port 8797 and suite E.
Nothing else in the records was changed. Without the relabel the report would blend the two facilitators
in one Suite E row.

## funding-artifact-d4-2026-09-08.jsonl (4 records)

Three `D4` presentations at 15:38–15:42 UTC on 8 Sep and one `D4-control-fresh` probe, all 402.
The seller's reason (visible in the live Worker tail) was `permit2_insufficient_balance`: the
30-minute Suite B hold (`B4-cdp-deployed`, 14:29–14:52 UTC) had settled 12,694 × 0.001 USDC and
drained the base-sepolia buyer wallet to 0.000998 USDC, so every `upto` verify failed regardless
of the authorization's age. The wallet was refilled from the CDP faucet at 15:49 UTC and the same
24 h authorization (`dd689aa7…`) settled at 15:50 UTC after a 87,114 s hold — that record stays in
`buyer-2026-09-08.jsonl` as the D4 result. Lesson recorded in `docs/findings.md`: check the wallet balance
before presenting a long-held authorization; the settler moves the file even on 402 unless `--keep`.

## funding-artifact-b4-depleted-tail-2026-09-08.jsonl (5,288 records)

The manually launched 30-minute Suite B hold on the CDP preview (`B4-cdp-deployed`, concurrency 20, cap 18,000
requests) ran clean for 21.4 minutes — 12,692 requests, 12,692 settled, 9.91 req/s — and then, at
14:50:54 UTC, the buyer wallet's base-sepolia USDC reached zero (the hold itself spent 12.69 USDC).
Every request after that was refused at verify with `invalid_payload: contract call failed: unable to
call contract: execution reverted`, which is the facilitator correctly reporting an empty wallet. Those
5,288 records measure our funding, not x402 or CDP, so they are excluded from the B4 row. The 18 records
where verify passed and the settlement transaction reverted on chain (`settle_exact_failed_onchain`) are
**kept** in `buyer-2026-09-08.jsonl`: they are the requests in flight when the balance crossed zero and
they are a genuine protocol observation (verify is a point-in-time balance check). Nothing in any record
was modified; the split is by `finalStatus` and `receipt.errorReason` only.

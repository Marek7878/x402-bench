# Suite D settle schedule

Five `upto` authorizations were signed against the deployed seller at **2026-09-07T15:38:26Z**
(17:38 CEST), each for a maximum of 10000 atomic units (0.01 USDC), each with a Permit2
**deadline of 2026-09-09T15:38:26Z** — 48 h, from `UPTO_MAX_TIMEOUT_SECONDS=172800`.

Run each command from the `x402-bench` folder. `--after` waits until `authorizedAt + duration`,
so **running a command late is safe**: if the target time has already passed it settles
immediately. The only hard limit is the 48 h deadline, after which the authorization is dead.

| Test | Hold | Settle at (CEST) | Safe until | Status | Command |
|---|---|---|---|---|---|
| D3 | 1 h | 7 Sep 18:38 | 9 Sep 17:38 | **done, settled 10000** | `pnpm settle --id 296d5de0-def0-4c56-b87a-e20e5d1c70ba --test D3 --after 1h` |
| D4 | 6 h → **15.9 h** | 8 Sep 09:13 | 9 Sep 17:38 | **done, settled 10000** | `pnpm settle --id 10d98836-5f30-4217-8979-a2d48b337692 --test D4 --after 0` |
| D4 | **24 h** | 8 Sep 17:38 | 9 Sep 17:38 | **done, settled 10000 after 87,114 s (24.2 h)** | `pnpm settle --id dd689aa7-6171-42ca-a986-a9966f7d0db9 --test D4 --after 24h` |
| D4 | 40 h | 9 Sep 09:38 | 9 Sep 17:38 | **done, settled 10000 after 145,780 s (40.5 h; fired late, VM hibernated)** | `pnpm settle --id 67599167-5080-463b-8cab-eaeb18818e87 --test D4 --after 40h` |
| D5 | 49 h | 9 Sep 18:38 | no limit | **done, refused at verify `permit2_deadline_expired`** | `pnpm settle --id cf4f4640-f56a-4bb5-9dc2-f09a08d19268 --test D5 --after 49h` |

## The 6 h slot became a 15.9 h result — and why

`--after` used to compute the wait once and hand it to a single `setTimeout`. macOS suspends
timers while the machine sleeps, so a laptop closed overnight fired the 6 h settle **about 9.5 h
late**, and the same lag would have pushed the 40 h settle past the 48 h Permit2 deadline and lost
that test outright.

`settle.ts` now polls against an absolute target, re-checking the clock at most every 30 s, so
waking from sleep fires it promptly and the lag cannot accumulate. It also prints a note and
records the **real** elapsed hold whenever that exceeds the requested one, because what makes a
Suite D record meaningful is the time actually achieved.

The overdue authorization was settled immediately rather than discarded: it had been held
**57,283 s (15.9 h)** and settled in full, which is a useful point between the 1 h and 24 h marks.
The 24 h and 40 h settlers were relaunched with the fixed logic and correct absolute targets.

**D4 at 24 h is the go/no-go test** (criterion: `upto` window ≥ 24 h). It has a full 24 hours of
slack, so it is the one least likely to be missed.

**D5 at 49 h is past the deadline on purpose.** It records what happens to an authorization that
is never settled in time. A rejection there is the expected, wanted result: it proves the window
is genuinely bounded.

40 h rather than 47 h for the long hold: it still shows the window far exceeds the 24 h the
reservation design needs, but leaves an 8-hour window to run it in rather than one.

## Already done, no action needed

| Test | Result |
|---|---|
| D1 settle immediately | 200, full 10000 settled, tx `0xe926a3d1…` |
| D2 settle 40 % of max | 200, 4000 settled, tx `0x2b01c277…` — partial settlement works |
| D2 settle 0 | 200, `success:true`, **empty transaction**, amount 0, no chain activity |
| D6 second settlement | first 200 with tx; second **402 rejected at verify**, `permit2_simulation_failed`, settle never attempted |

D7 (compare `exact` and `upto` on latency and cost) is computed from the A3 and D1 records by
`pnpm report`; it needs no separate run.

## If a background settler was started

Detached settlers may be running for the holds above, logging to `results/settle-<test>-<hold>.log` (gitignored).
They are a convenience, not the source of truth. Check a log; if it is empty or the process is gone,
just run the command from the table. Settling twice is harmless but records a spurious 402 — check
`results/settled/` for the id before re-running.

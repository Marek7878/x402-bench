# Quarantined records

Records excluded from the report because they do not measure what their label says.
Kept rather than deleted so the exclusion is auditable.

## mislabeled-g2-cdp.jsonl — 1 record, 7 Sep 2026

One paid request tagged `suite=G test=G2-cdp`, intended to exercise the CDP
facilitator on local `wrangler dev`. It went to the deployed Worker instead:
`run-one.ts` takes the seller address from the `SELLER_URL` environment variable,
and the `--base` flag I passed is not a flag it reads, so the override was
silently ignored. The deployed Worker runs `FACILITATOR_PROVIDER=public`, so the
request was settled by the public facilitator.

Excluded because G2 exists to compare the two facilitators. A public-facilitator
measurement filed under the CDP label would corrupt that comparison in the one
direction that matters, and its settle time (1080 ms) sits between the two
services' real distributions, so it would not look wrong.

Cost 0.001 USDC on base-sepolia. Real settlement, tx 0x7e95db7dbf…, no chain
state needs unwinding.

## false-negative-f6.jsonl — 1 record, 8 Sep 2026

An F6 record marked failed when the payment had in fact succeeded. The `mppx` CLI was invoked with
both `--include` and `--silent`; `--silent` suppresses the response headers that `--include` would
print, so the run's success check — which looked for the HTTP status line in stdout — found
nothing. The delivered body was sitting in the record's `error` field the whole time.

Excluded because a false negative in a compatibility matrix is worse than a gap: it would have
reported MPP as incompatible with x402 when the opposite was demonstrated, and that is the exact
claim F6 exists to test. The check now judges on the delivered body rather than the status line.

The payment was real, so the wallet arithmetic still counts it.

## harness-defect-f2f3.jsonl — 1 record, 8 Sep 2026

An F2-F3 record that failed with `Bad Request: Server not initialized`. The MCP server under test
created a fresh `StreamableHTTPServerTransport` per HTTP request, so the `initialize` handshake was
bound to a transport that no longer existed when the tool call arrived. MCP refused the call before
any payment was attempted.

Excluded because it measures my transport wiring, not the Agents SDK's x402 support. Keeping it
would put a failure row in the compatibility matrix for an integration that works: the same test
pays successfully once transports are kept per session, which is what the code now does.

No money moved, so the wallet arithmetic is unaffected.

## `mislabeled-d3-reused-authorization.jsonl` — one record

A `D3` record with `holdSeconds: 3600` and a 402. It is not a 1 h-window failure. It shares its
`requestId` *and* its `authorizedAt` with a `D3` record that succeeded 73 s after authorization
(tx `0xddfae87e80cf…`, full 10000): one authorization, settled once, then presented a second time
an hour later. `upto` is Permit2 and allows a single settlement per nonce, so the second
presentation was refused — correctly.

Excluded because the label is wrong, not because the behaviour is. Left in the D3 rows it implied
a 50 % failure rate at the 1 h mark, when the authoritative 1 h result is the deployed row
(`0xdc032ea68e34…`, PASS). What it actually demonstrates belongs to D6, and the mechanism is now
recorded in `docs/findings.md`: the refusal is `permit2_simulation_failed`, returned by **verify**, so the
duplicate never reaches the chain and costs no gas.

Cause was the harness: `pnpm settle --keep` leaves the pending file in place so it can be
presented again for D6, and the scheduled 1 h settler then picked up that same file.

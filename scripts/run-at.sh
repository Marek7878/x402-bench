#!/usr/bin/env bash
# Wait until an absolute UTC time, then run one mainnet C1 batch. Polls the wall clock every
# minute (a plain `sleep N` fires late after the machine sleeps).
#   scripts/run-at.sh 2026-09-09T07:00:00Z C1-morning [n]
set -euo pipefail
TARGET="$1"; TEST="$2"; N="${3:-20}"
T=$(python3 -c "import datetime,sys; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')).timestamp()))" "$TARGET")
cd "$(dirname "$0")/.."
echo "$(date -u +%FT%TZ) waiting for $TARGET to run $TEST n=$N"
while [ "$(date +%s)" -lt "$T" ]; do sleep 60; done
echo "$(date -u +%FT%TZ) firing $TEST"
NETWORK=eip155:8453 RPC_URL=https://mainnet.base.org \
SELLER_URL=https://x402-bench-seller-mainnet.jetskibay.workers.dev \
pnpm buyer --route /paid/exact --suite C --test "$TEST" --n "$N"

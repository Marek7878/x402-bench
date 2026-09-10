#!/usr/bin/env bash
# Run the four 9 Sep jobs inside a detached tmux session "x402" (one window each) so they keep
# running after every SSH/exec connection is closed. Idempotent: stops any earlier copies first.
# Patterns are anchored so pkill never matches the shell running this script.
set -uo pipefail
cd "$(dirname "$0")/.."
for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && export PATH="$d:$PATH"; done
pkill -f "^bash scripts/run-at.sh" 2>/dev/null
pkill -f "^node .*settle.ts" 2>/dev/null
pkill -f "^node .*pnpm --filter @x402-bench/buyer settle" 2>/dev/null
sleep 2
tmux kill-session -t x402 2>/dev/null
RUN="cd $PWD && export PATH=$PATH &&"
tmux new-session -d -s x402 -n c1-morning "$RUN scripts/run-at.sh 2026-09-09T07:00:00Z C1-morning 2>&1 | tee results/c1-morning.log; echo DONE; sleep infinity"
tmux new-window  -t x402 -n c1-midday  "$RUN scripts/run-at.sh 2026-09-09T12:00:00Z C1-midday 2>&1 | tee results/c1-midday.log; echo DONE; sleep infinity"
tmux new-window  -t x402 -n d4-40h     "$RUN pnpm --filter @x402-bench/buyer settle -- --id 67599167-5080-463b-8cab-eaeb18818e87 --test D4 --after 40h 2>&1 | tee results/d4-40h.log; echo DONE; sleep infinity"
tmux new-window  -t x402 -n d5-49h     "$RUN pnpm --filter @x402-bench/buyer settle -- --id cf4f4640-f56a-4bb5-9dc2-f09a08d19268 --test D5 --after 49h 2>&1 | tee results/d5-49h.log; echo DONE; sleep infinity"
sleep 8
tmux list-windows -t x402
echo
ps -eo pid,etime,args | grep -E "^ *[0-9]+ +[0-9:]+ +(bash scripts/run-at.sh|node .*settle.ts)" | cut -c1-120
echo
tail -n 2 results/c1-morning.log results/c1-midday.log results/d4-40h.log results/d5-49h.log

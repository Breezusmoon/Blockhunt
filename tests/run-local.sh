#!/usr/bin/env bash
# Runs every BlockHunt test against a throwaway local chain.
#   FOUNDRY=<dir with forge/anvil/cast>  SOLC=<solc 0.8.24 binary, optional>  PW_DIR=<dir with puppeteer-core + @sparticuz/chromium>
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
FOUNDRY=${FOUNDRY:-$(dirname "$(command -v forge)")}
SOLC_ARGS=()
[ -n "${SOLC:-}" ] && SOLC_ARGS=(--use "$SOLC" --offline)
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

cleanup() { kill ${ANVIL_PID:-} ${WRANGLER_PID:-} ${HTTP_PID:-} 2>/dev/null || true; pkill -x workerd 2>/dev/null || true; }
trap cleanup EXIT

[ -d contracts/lib/forge-std ] || git clone -q --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std contracts/lib/forge-std
echo "▶ Contract tests"
(cd contracts && "$FOUNDRY/forge" test "${SOLC_ARGS[@]}" --fuzz-runs 2000 | tail -3)

echo "▶ Puzzle engine tests"
node --test tests/puzzle.test.js 2>&1 | grep -E "^# (pass|fail)"

echo "▶ Local chain + score server"
"$FOUNDRY/anvil" --silent --port 8545 & ANVIL_PID=$!
sleep 2
SIGNER_KEY=0x$(openssl rand -hex 32)
SIGNER_ADDR=$("$FOUNDRY/cast" wallet address --private-key "$SIGNER_KEY")
CONTRACT=$(cd contracts && "$FOUNDRY/forge" create src/BlockHuntV3.sol:BlockHuntV3 "${SOLC_ARGS[@]}" --broadcast \
  --rpc-url http://127.0.0.1:8545 --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --constructor-args 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 "$SIGNER_ADDR" | awk '/Deployed to/{print $3}')
echo "  contract $CONTRACT"
rm -rf worker/.wrangler
printf "SIGNER_KEY=%s\n" "$SIGNER_KEY" > worker/.dev.vars
(cd worker && npx wrangler dev --port 8787 --var CONTRACT_ADDRESS:"$CONTRACT" --var RPC_URL:http://127.0.0.1:8545 \
  --var CHAIN_ID:31337 --var ALLOWED_ORIGINS:http://localhost,http://127.0.0.1:8090 >/tmp/bh-wrangler.log 2>&1) & WRANGLER_PID=$!
for _ in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:8787/health >/dev/null && break; sleep 1; done

echo "▶ Score server end-to-end"
(cd worker && RPC=http://127.0.0.1:8545 WORKER=http://127.0.0.1:8787 CONTRACT=$CONTRACT node test/e2e.mjs)

echo "▶ Browser tests"
# fresh chain state for the browser game
kill $WRANGLER_PID; pkill -x workerd || true; kill $ANVIL_PID; sleep 1
"$FOUNDRY/anvil" --silent --port 8545 & ANVIL_PID=$!
sleep 2
CONTRACT=$(cd contracts && "$FOUNDRY/forge" create src/BlockHuntV3.sol:BlockHuntV3 "${SOLC_ARGS[@]}" --broadcast \
  --rpc-url http://127.0.0.1:8545 --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --constructor-args 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 "$SIGNER_ADDR" | awk '/Deployed to/{print $3}')
rm -rf worker/.wrangler
(cd worker && npx wrangler dev --port 8787 --var CONTRACT_ADDRESS:"$CONTRACT" --var RPC_URL:http://127.0.0.1:8545 \
  --var CHAIN_ID:31337 --var ALLOWED_ORIGINS:http://127.0.0.1:8090 >/tmp/bh-wrangler.log 2>&1) & WRANGLER_PID=$!
for _ in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:8787/health >/dev/null && break; sleep 1; done
python3 -m http.server 8090 --bind 127.0.0.1 >/dev/null 2>&1 & HTTP_PID=$!
sleep 1
SITE=http://127.0.0.1:8090/index.html RPC=http://127.0.0.1:8545 WORKER=http://127.0.0.1:8787 CONTRACT=$CONTRACT node tests/browser.test.mjs
rm -f worker/.dev.vars
echo "✅ ALL TESTS PASSED"

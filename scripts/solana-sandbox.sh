#!/usr/bin/env bash
# Solana half of the sandbox: a local validator running the MAINNET Squads Smart Account Program and its
# ProgramConfig, cloned at boot (the Solana analogue of anvil with Circle's production bytecode). Also builds
# the pinned @sqds/smart-account SDK the playground's Solana view imports.
#
#   bun run solana:sandbox        → RPC http://127.0.0.1:8899, ledger in .sandbox/solana-ledger
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/packages/weighted-treasury/scripts/build-squads-sdk.sh"
mkdir -p "$ROOT/.sandbox"
exec solana-test-validator --reset --quiet \
  --ledger "$ROOT/.sandbox/solana-ledger" \
  --rpc-port "${SOLANA_RPC_PORT:-8899}" \
  --url "${SOLANA_CLONE_URL:-https://api.mainnet-beta.solana.com}" \
  --clone-upgradeable-program SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG \
  --clone GmY9kVi3FhrCUn2MJkzzpE6C5618YoHuGsgqHU78cKus

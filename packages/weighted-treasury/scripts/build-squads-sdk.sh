#!/usr/bin/env bash
# Builds @sqds/smart-account from source at a pinned commit into .squads-sdk/ (gitignored).
# Not vendored: the SDK's package.json says MIT, but the only LICENSE file in that repo is
# AGPL-3.0, so nothing from it is committed here. Only the devnet proof uses it.
set -euo pipefail
PIN="${SQUADS_SMART_ACCOUNT_COMMIT:-80bf1f7ad28fd1176c364879776982730b8e9c80}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/.squads-sdk"
if [ -f "$DIR/sdk/smart-account/lib/index.js" ] && [ "$(git -C "$DIR" rev-parse HEAD)" = "$PIN" ]; then
  echo "squads sdk already built at $PIN"; exit 0
fi
rm -rf "$DIR"
git clone -q https://github.com/Squads-Protocol/smart-account-program "$DIR"
git -C "$DIR" checkout -q "$PIN"
cd "$DIR/sdk/smart-account"
bun install --silent
bun run build:js >/dev/null
echo "squads sdk built at $PIN → $DIR/sdk/smart-account/lib"

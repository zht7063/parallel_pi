#!/usr/bin/env bash
# Build and exercise a native candidate; uses only temporary test projects/providers.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ]; then
  echo 'This acceptance script requires a macOS desktop login session.' >&2
  exit 1
fi
node --input-type=module -e 'import fs from "node:fs"; const required = JSON.parse(fs.readFileSync("package.json")).engines.node; if (process.versions.node !== required) throw new Error(`Use Node ${required}; found ${process.versions.node}`)'
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
source_root="$PWD"
source_commit=$(git rev-parse HEAD)
git diff --quiet HEAD || { echo 'Commit or stash tracked source changes before candidate validation.' >&2; exit 1; }
mkdir -p "$HOME/parallel-pi-candidates"
candidate_root=$(mktemp -d "$HOME/parallel-pi-candidates/macos.XXXXXX")
exec > >(tee "$candidate_root/validation.log") 2>&1
printf 'Candidate and log directory: %s\n' "$candidate_root"
sw_vers
node --version
python3 --version
git --version
# Build a committed snapshot outside synced folders; no existing checkout or
# credentials are copied into the candidate. Keep this checkout for diagnostics.
git clone --no-hardlinks --no-checkout "$source_root" "$candidate_root/source"
git -C "$candidate_root/source" checkout --detach "$source_commit"
cd "$candidate_root/source"
python3 probes/darwin-supervision.py
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:probes
npm run build
# Isolate platform failures before the expensive full suite. Keep all test cases,
# but serialize files while diagnosing launchd startup under concurrent load.
node --import ./tests/environment.mjs --test tests/platform.test.ts
npm run check:architecture
npm run typecheck
node --import ./tests/environment.mjs --test --test-concurrency=1 tests/*.test.ts tests/*.test.mjs
npm run format:check
node scripts/build-npm.mjs "$candidate_root/package"
npm pack "$candidate_root/package" --ignore-scripts --pack-destination "$candidate_root"
archive="$candidate_root/parallel-pi-$(node -p 'require("./package.json").version').tgz"
npm install --global --prefix "$candidate_root/install" --cache "$candidate_root/cache" --offline --ignore-scripts --no-audit --no-fund "$archive"
"$candidate_root/install/bin/parallel-pi" doctor
export PARALLEL_PI_PLATFORM_MODULE
PARALLEL_PI_PLATFORM_MODULE=$(node --input-type=module -e 'import {pathToFileURL} from "node:url"; console.log(pathToFileURL(process.argv[1]).href)' "$candidate_root/install/lib/node_modules/parallel-pi/packages/infra-platform/src/index.js")
node --import ./tests/environment.mjs --test tests/platform.test.ts
shasum -a 256 "$archive" > "$candidate_root/SHA256SUMS"
printf '\nNative candidate checks passed. Browser/manual application acceptance remains.\nPackage: %s\nLog: %s/validation.log\n' "$archive" "$candidate_root"
printf 'Run: "%s/install/bin/parallel-pi" serve --data-dir "%s/data" --agent-dir "%s/agent"\n' "$candidate_root" "$candidate_root" "$candidate_root"

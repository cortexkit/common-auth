#!/usr/bin/env bash
# CI-only: Bun 1.3.14/1.4.2 matrix repeats, macOS/Windows placement and hub jobs,
# and Windows private-files ACL, writer, vault, timing and process probes.
# The Windows-named workflow's Ubuntu npm-host leg IS included below.
# Release's GitHub CI wait (verify-release-ci.mjs with GITHUB_TOKEN,
# GITHUB_REPOSITORY, GITHUB_API_URL, TARGET_SHA) and npm publish --access public
# --provenance stay CI-only. Its RELEASE_REF version check runs when supplied.
#
# Linux CI inventory (.github/workflows):
# ci.yml/check: install --frozen-lockfile, build, typecheck, check:claustrum-floor,
# check:opentui-0511, lint, test + JUnit, check-sources (docs/sources.md).
# ci.yml/opencode2-placement: frozen install, COMMON_AUTH_OPENCODE2_E2E=1 test
# + JUnit, check-sources (test/opencode2/e2e/sources.md), normally Bun 1.3.14.
# windows-private-files.yml/setup-npm-host: frozen install, build, npm install
# --global opencode-ai, local-registration.test.ts, node --version, npm-host.mjs.
# release.yaml: verify-ci, RELEASE_REF check, frozen install, publish (build hook).
# Node 24 / Bun 1.4.4 replace the actions' tool setup; other Bun versions stay CI.
# Shared install/build/typecheck keep CI order. Lint moves into fast; the two
# compatibility runs precede the suite in launch order but run independently.
# Usage: scripts/gate.sh --fast on the Mac. Full via the AFT bash tool:
# bash({command: "scripts/gate.sh", runon: "linux,16c,net"}).
set -euo pipefail
cd "$(dirname "$0")/.."

step=arguments
work=
pids=()
names=()
finish() {
  local result=$?
  trap - EXIT INT TERM
  if [[ -n "$work" ]]; then
    if (( result != 0 && ${#pids[@]} != 0 )); then
      kill "${pids[@]}" 2>/dev/null || true
      wait "${pids[@]}" 2>/dev/null || true
    fi
    rm -rf "$work"
  fi
  if (( result == 0 )); then
    printf 'GATE_OK %s\n' "$commit"
  else
    printf 'GATE_FAILED %s\n' "$step"
  fi
}
trap finish EXIT
trap 'exit 130' INT TERM
fast=false
case "${1:-}" in
  --fast) fast=true ;;
  '') ;;
  *) echo 'Usage: scripts/gate.sh [--fast]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]]
step=commit
commit=$(git rev-parse HEAD)

run() {
  step=$1
  shift
  printf '\n== %s ==\n' "$step"
  if "$@"; then
    printf 'PART %s pass=1 fail=0 (command checks)\n' "$step"
  else
    printf 'PART %s pass=0 fail=1 (command checks)\n' "$step"
    return 1
  fi
}
toolchain() {
  local required_bun=1.4.4 current_bun tools
  current_bun=$(bun --version 2>/dev/null) || current_bun=unavailable
  if $fast && [[ "$current_bun" != "$required_bun" ]]; then
    echo 'Use Bun 1.4.4, the newest CI matrix entry.' >&2; return 1
  fi
  if ! $fast; then
    [[ $(uname -s) == Linux && $(node --version) == v24.* ]] || {
      echo 'Full gate requires Linux and Node 24; use AFT linux,16c,net.' >&2; return 1;
    }
    if [[ "$current_bun" != "$required_bun" ]]; then
      tools="$PWD/target/scratch/gate-tools"
      printf 'Bun on PATH is %s; fetching Bun %s into %s.\n' "$current_bun" "$required_bun" "$tools"
      if ! npm install --prefix "$tools" "bun@$required_bun" --no-audit --no-fund; then
        printf 'Cannot obtain required Bun %s: npm install failed in %s (see diagnostics above).\n' "$required_bun" "$tools" >&2
        return 1
      fi
      export PATH="$tools/node_modules/.bin:$PATH"
      hash -r
    fi
  fi
  current_bun=$(bun --version) || {
    printf 'Cannot run required Bun %s.\n' "$required_bun" >&2; return 1;
  }
  [[ "$current_bun" == "$required_bun" ]] || {
    printf 'Required Bun %s, but selected Bun reports %s.\n' "$required_bun" "$current_bun" >&2; return 1;
  }
  printf 'Using Bun %s (%s)\n' "$current_bun" "$(command -v bun)"
  node --version
}
private_tracking() {
  local ignored
  ignored=$(git ls-files -ci --exclude-standard -- .cortexkit) || return
  [[ -z "$ignored" ]] || { printf '%s\n' "$ignored"; return 1; }
}
release_version() {
  node --input-type=module -e 'import { readFileSync } from "node:fs"; const { version } = JSON.parse(readFileSync("package.json", "utf8")); if (process.env.RELEASE_REF !== `refs/tags/v${version}`) { console.error("Tag does not match package.json version"); process.exit(1); }'
}

run toolchain toolchain
if [[ ${RELEASE_REF+x} ]]; then run release-version release_version; fi
run frozen-lockfile bun install --frozen-lockfile
run build bun run build
run typecheck bun run typecheck
run format bun run format:check
run lint bun run lint
run private-tracking private_tracking
run dist-imports bun test test/fs/private-files-external.test.ts \
  test/setup/bundle.test.ts test/redaction/subpath.test.ts \
  test/rpc/client-subpath.test.ts test/tui-build/linking.test.ts
# The remaining Pi slot tests exercise real lock renewal and take a minute.
run pi-slot-imports bun test test/pi-slot/slot.test.ts --test-name-pattern 'published import graph'
if $fast; then exit 0; fi
unset COMMON_AUTH_OPENCODE2_E2E

# The compatibility helpers copy the checkout into OS temp directories. Keep
# job logs and the npm global prefix outside that checkout to avoid recursion.
step=job-temp
work=$(mktemp -d "${TMPDIR:-/tmp}/common-auth-gate.XXXXXX")
export npm_config_prefix="$work/npm"
export PATH="$npm_config_prefix/bin:$PATH"
suite() {
  bun test --reporter=junit --reporter-outfile=test-results.xml &&
    bun scripts/check-sources.mjs docs/sources.md test-results.xml
}
placement() {
  COMMON_AUTH_OPENCODE2_E2E=1 bun test --reporter=junit --reporter-outfile=opencode2-placement-results.xml test/opencode2/e2e/placement.e2e.test.ts &&
    bun scripts/check-sources.mjs test/opencode2/e2e/sources.md opencode2-placement-results.xml
}
npm_host() {
  npm install --global opencode-ai &&
    bun test test/setup/local-registration.test.ts &&
    node --version && node test/setup/npm-host.mjs
}
start() {
  local name=$1
  shift
  (trap - EXIT; "$@") >"$work/$name.log" 2>&1 &
  pids+=("$!")
  names+=("$name")
}
start claustrum-floor bun run check:claustrum-floor
start opentui-0511 bun run check:opentui-0511
start quota-sidebar-floor bun run check:quota-sidebar-floor
start opencode2-placement placement
failed=
collect() {
  local i name result
  for ((i=0; i<${#pids[@]}; i++)); do
    name=${names[i]}
    step=$name
    result=0
    wait "${pids[i]}" || result=$?
    printf '\n== %s ==\n' "$name"
    # Successful suites produce thousands of lines. Keep the terminal summary
    # small; a failing part includes its final diagnostics before the counts.
    if (( result != 0 )); then tail -n 80 "$work/$name.log"; fi
    # Bun prints one summary per test run; the Node smoke prints setup checks.
    awk -v name="$name" -v result="$result" '
      /^[[:space:]]*[0-9]+ pass$/ { passed += $1 }
      /^[[:space:]]*[0-9]+ fail$/ { failed += $1 }
      /[0-9]+ setup checks passed$/ { passed += $(NF-3) }
      END { printf "PART %s tests_pass=%d tests_fail=%d checks_pass=%d checks_fail=%d exit=%d\n", name, passed, failed, result == 0, result != 0, result }
    ' "$work/$name.log"
    if (( result != 0 )) && [[ -z "$failed" ]]; then failed=$name; fi
  done
  pids=()
  names=()
}
collect
# The main suite asserts short shutdown deadlines. Run it without competing
# compatibility builds or real CLI processes, rather than relaxing those tests.
start suite suite
collect
# Setup refuses to edit profiles while hosts are running. Do not overlap its
# process-fence smoke with the placement test's real OpenCode CLI processes.
start npm-host npm_host
collect
if [[ -n "$failed" ]]; then step=$failed; exit 1; fi

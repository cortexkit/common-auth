#!/bin/sh
# load-probe normally filters one test. This control compares full-suite order
# under the same load, deliberately ignoring that script's file/name arguments.
exec "${BUN_PROBE_RUNTIME:?set BUN_PROBE_RUNTIME}" test \
  --reporter=junit --reporter-outfile="${HOOK_JUNIT_OUT:-test-results.xml}"

#!/bin/sh
set -eu
cd "$(dirname "$0")"
headers=${1:?Usage: sh research/kernel-lock/build.sh /path/to/node/include}
cc=${CC:-clang}
"$cc" --version
case "$(uname -s)" in
  Darwin) shared="-bundle -undefined dynamic_lookup" ;;
  *) shared="-shared -fPIC" ;;
esac
# shellcheck disable=SC2086
"$cc" -std=c11 -D_GNU_SOURCE -Wall -Wextra -Werror -DNAPI_VERSION=8 -I"$headers" $shared addon.c -o lock.node
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
"$cc" -D_GNU_SOURCE -Wall -Wextra -Werror primitives.c -o "$scratch/primitives"
"$cc" -D_GNU_SOURCE -Wall -Wextra -Werror fork.c -o "$scratch/fork"
mkdir -p results
"$scratch/primitives" "$scratch/primitive-sidecar" > results/primitives.jsonl
"$scratch/fork" "$scratch/fork-sidecar" > results/fork.json
printf 'Built N-API v8 addon; measured four primitives and one fork inheritance scenario.\n'

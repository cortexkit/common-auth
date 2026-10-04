#!/bin/sh
set -eu
cd "$(dirname "$0")"
headers=${1:?Usage: sh research/kernel-lock/build.sh /path/to/node/include}
clang --version
clang -std=c11 -Wall -Wextra -Werror -DNAPI_VERSION=8 -I"$headers" -bundle -undefined dynamic_lookup addon.c -o lock.node
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
clang -Wall -Wextra -Werror primitives.c -o "$scratch/primitives"
clang -Wall -Wextra -Werror fork.c -o "$scratch/fork"
mkdir -p results
"$scratch/primitives" "$scratch/primitive-sidecar" > results/primitives.jsonl
"$scratch/fork" "$scratch/fork-sidecar" > results/fork.json
printf 'Built N-API v8 addon; measured four primitives and one fork inheritance scenario.\n'

#!/usr/bin/env bash
#
# Sample --setup-script for create-katalystwp.
#
# It runs INSIDE the workspace container as the `node` user (the same place
# `npm run bash` drops you), with the working directory at /home/node and
# WordPress at /home/node/wp. Here it checks out Breakdance next to ./wp and
# runs Breakdance's own installer against that WordPress.
#
# Try it:
#   npm create katalystwp@latest my-breakdance -- \
#     --port=8090 \
#     --setup-script=./examples/breakdance-setup.sh \
#     --defines=./examples/breakdance-defines.json \
#     --activate=oxygen-elements,breakdance-elements,breakdance-main
#
# `soflyy/breakdance` is private, so `gh` must be authenticated in the workspace
# — either run `gh auth login` once inside (`npm run bash`; it persists in
# workspace/), or export GH_TOKEN on your host before setup (it's forwarded in).
set -euo pipefail

cd /home/node

# Idempotent: `npm run setup` may run this again, so don't re-clone over an
# existing checkout.
if [ ! -d /home/node/breakdance ]; then
  gh repo clone soflyy/breakdance
fi

cd /home/node/breakdance && ./scripts/setup.sh --wp-root=/home/node/wp

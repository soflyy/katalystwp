#!/usr/bin/env bash
#
# Sample --dev-script for create-katalystwp.
#
# It runs in the long-lived `dev` container (as `node`, with the same /home/node
# mount as the workspace), kept alive by dev-supervisor for as long as the stack
# is up. Here it runs Breakdance's watch task against the checkout the setup
# script cloned at /home/node/breakdance.
#
# Pairs with breakdance-setup.sh:
#   npm create katalystwp@latest my-breakdance -- \
#     --port=8090 \
#     --setup-script=./examples/breakdance-setup.sh \
#     --dev-script=./examples/breakdance-dev.sh \
#     --defines=./examples/breakdance-defines.json \
#     --activate=oxygen-elements,breakdance-elements,breakdance-main
#
# dev-supervisor restarts this if it exits, so if the checkout isn't there yet
# (setup still running) it simply retries until /home/node/breakdance exists.
set -euo pipefail

cd /home/node/breakdance && npm run dev:codespace

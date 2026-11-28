#!/usr/bin/env bash
# Export a checkout for the home server: the files git tracks, as they are in the working tree now, and the installed
# dependencies. An allow-list: what git ignores (a .env, worlds, token files, local config) and git's own metadata never
# arrive, and a link that points out of the checkout is left behind, never followed. start.sh runs this as root, where
# a followed link to a root-only file would be served; test/server/home-units-test.ts runs it over a scratch checkout.
#   deploy/home/export.sh <checkout> <destination>     (the destination is replaced)
set -euo pipefail
SRC="$(cd "$1" && pwd)"; DST="$2"
[ -n "$DST" ] && [ "$DST" != / ] || { echo "export: no destination" >&2; exit 1; }
# git as the checkout's owner: as another user it refuses the repository
owner=(); [ "$(id -u)" = 0 ] && owner=(sudo -u "$(stat -c %U "$SRC")")
chown=(); [ "$(id -u)" = 0 ] && chown=(--chown=root:root)
rm -rf "$DST.new"; mkdir -p "$DST.new"
"${owner[@]}" git -C "$SRC" ls-files -z | rsync -a --safe-links --ignore-missing-args "${chown[@]}" --chmod=a+rX,go-w --from0 --files-from=- "$SRC/" "$DST.new/"
# installed dependencies are ignored by git and needed at run time; each must be a real directory in the checkout
for deps in node_modules client/node_modules mcpl/node_modules; do
  [ -d "$SRC/$deps" ] && [ ! -L "$SRC/$deps" ] || { echo "export: $SRC/$deps is not an installed directory (a link is not followed): bun install && bun test/gate/run.ts --siblings" >&2; rm -rf "$DST.new"; exit 1; }
  rsync -a --safe-links "${chown[@]}" --chmod=a+rX,go-w "$SRC/$deps/" "$DST.new/$deps/"
done
rm -rf "$DST.old"; [ ! -e "$DST" ] || mv "$DST" "$DST.old"
mv "$DST.new" "$DST"; rm -rf "$DST.old"

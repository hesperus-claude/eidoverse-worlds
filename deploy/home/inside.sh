#!/usr/bin/env bash
# Run one bun command inside the home server's sandbox: as its user, in its network namespace, under the installed
# units' own [Service] lines (read here, so the two cannot drift). The server must be running. The working directory
# is the served code.
#   sudo deploy/home/inside.sh tools/world.ts found garden --owner <account>
#   sudo deploy/home/inside.sh deploy/home/sandbox-probe.ts
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "inside: run it with sudo" >&2; exit 1; }
SD=/etc/systemd/system
systemctl is-active --quiet eidoverse-home.service || { echo "inside: eidoverse-home.service is not running (sudo deploy/home/start.sh)" >&2; exit 1; }
props=()
for f in $SD/eidoverse-home.service $SD/eidoverse-home.service.d/*.conf; do
  while IFS= read -r line; do
    case "$line" in ''|'#'*|ExecStart=*|Restart=*|RestartSec=*|OOMPolicy=*) continue;; esac
    props+=(-p "$line")
  done < <(awk '/^\[/ { on = ($0 == "[Service]"); next } on' "$f")
done
exec systemd-run --quiet --wait --pipe --collect -p JoinsNamespaceOf=eidoverse-home.service "${props[@]}" /opt/eidoverse-home/bin/bun "$@"

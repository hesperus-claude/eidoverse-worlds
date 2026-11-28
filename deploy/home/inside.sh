#!/usr/bin/env bash
# Run one bun command inside the home server's sandbox: as its user, in its network namespace, under the [Service]
# lines of the installed unit and its drop-ins (read here, not kept as a second copy). The server must be running and
# its units loaded as they are on disk; the working directory is the served code. It is a twin of the server's
# sandbox, in a unit of its own, not the server's process.
#   sudo deploy/home/inside.sh tools/world.ts found garden --owner <account>
#   sudo deploy/home/inside.sh deploy/home/sandbox-probe.ts
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "inside: run it with sudo" >&2; exit 1; }
SD=/etc/systemd/system
systemctl is-active --quiet eidoverse-home.service || { echo "inside: eidoverse-home.service is not running (sudo deploy/home/start.sh)" >&2; exit 1; }
props=()
for f in $SD/eidoverse-home.service $SD/eidoverse-home.service.d/*.conf; do
  while IFS= read -r line; do
    case "$line" in ''|'#'*|ExecStart=*|Type=*|Restart=*|RestartSec=*|OOMPolicy=*) continue;; esac
    props+=(-p "$line")
  done < <(awk '/^\[/ { on = ($0 == "[Service]"); next } on' "$f")
done
# refuse to run a command "inside" without the sandbox: the drop-in missing, or the units changed since they were loaded
case " ${props[*]} " in *" PrivateNetwork=yes "*) ;; *) echo "inside: the installed units carry no PrivateNetwork=yes (sudo deploy/home/start.sh)" >&2; exit 1;; esac
case " ${props[*]} " in *" TemporaryFileSystem=/:ro "*) ;; *) echo "inside: the installed units carry no TemporaryFileSystem=/:ro (sudo deploy/home/start.sh)" >&2; exit 1;; esac
[ "$(systemctl show -p NeedDaemonReload --value eidoverse-home.service)" = no ] || { echo "inside: the units on disk differ from the loaded ones (sudo deploy/home/start.sh)" >&2; exit 1; }
exec systemd-run --quiet --wait --pipe --collect -p JoinsNamespaceOf=eidoverse-home.service "${props[@]}" /opt/eidoverse-home/bin/bun "$@"

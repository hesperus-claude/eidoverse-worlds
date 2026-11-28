#!/usr/bin/env bash
# The home server: install or update it, and start or restart it. Safe to run again, and the way back up after a reboot.
#   sudo deploy/home/start.sh
# It serves an export of THIS checkout as it is now, from /opt/eidoverse-home, in a sandbox with no network; the only
# way in is 127.0.0.1:8940 (the page) and 127.0.0.1:8941 (the agent door) on this machine. It makes nothing public: a
# tunnel or TLS proxy pointed at those two is a separate step of yours (docs/operator/RUNNING-A-SERVER.md, "On your own
# machine"). Settings: EIDOVERSE_DIR (the library, default ../eidoverse-video beside the checkout), BUN (the bun to
# install, default the one on PATH or the invoking user's own), STATE_SIZE (the default state disk, 1G).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; KIT="$ROOT/deploy/home"
OPT=/opt/eidoverse-home; ETC=/etc/eidoverse-home; STATE=/var/lib/eidoverse-home; U=eidoverse-home; SD=/etc/systemd/system
die() { echo "start: $*" >&2; exit 1; }

# 0. what this needs, checked before anything changes
[ "$(id -u)" = 0 ] || die "run it with sudo"
[ -d /run/systemd/system ] || die "this machine does not run systemd (under WSL: systemd=true in /etc/wsl.conf)"
# an older systemd skips a sandbox line it doesn't know with only a log warning
[ "$(systemctl --version | awk 'NR==1 { print $2 }')" -ge 248 ] || die "systemd 248 or later is needed (this is $(systemctl --version | head -1))"
[ -x /usr/lib/systemd/systemd-socket-proxyd ] || die "no /usr/lib/systemd/systemd-socket-proxyd (Debian and Ubuntu ship it in the systemd package)"
[ -d /usr/lib/x86_64-linux-gnu ] && [ -e /usr/lib64/ld-linux-x86-64.so.2 ] || die "sandbox.conf binds glibc where Debian and Ubuntu keep it on x86_64; this machine differs, so its two glibc lines need editing first"
command -v rsync >/dev/null && command -v git >/dev/null || die "rsync and git are needed"
home_of() { getent passwd "$1" | cut -d: -f6; }
# sudo's PATH leaves out the places bun installs itself for one user
BUN="${BUN:-$(PATH="$PATH:$(home_of "${SUDO_USER:-root}")/.bun/bin:$(home_of "${SUDO_USER:-root}")/.local/bin" command -v bun || true)}"
[ -n "$BUN" ] || die "no bun found: pass BUN=/path/to/bun"
[ -x "$BUN" ] || die "BUN=$BUN is not an executable"
LIB="$(realpath -e "${EIDOVERSE_DIR:-$ROOT/../eidoverse-video}" 2>/dev/null)" || die "no library at ${EIDOVERSE_DIR:-$ROOT/../eidoverse-video}: pass EIDOVERSE_DIR=<the eidoverse-video checkout>"
[ -d "$LIB/eidoverse/assets" ] || die "$LIB is not the asset library (no eidoverse/assets in it)"
# the path is written into a unit file, where these characters are syntax
case "$LIB" in *[!A-Za-z0-9_./+@-]*) die "the library's path ($LIB) has a character a unit file can't carry plainly; move or symlink it";; esac

# 1. the service's own user: no home, no shell, no groups
id -u $U >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin $U

# 2. the code the sandbox sees: root's, read-only, an export of what git tracks plus the installed dependencies
#    (export.sh; it refuses a checkout whose dependencies are missing, before anything is replaced)
install -d -m 755 $OPT $OPT/bin
"$KIT/export.sh" "$ROOT" $OPT/app
install -m 755 -o root -g root "$BUN" $OPT/bin/bun
# the label /version shows: there is no git inside
SHA="$(sudo -u "${SUDO_USER:-root}" git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "BUILD_SHA=$SHA" > $OPT/build.env; chmod 644 $OPT/build.env

# 3. settings and secrets, outside the sandbox's view. The join token is generated here and never printed.
install -d -m 700 -o root -g root $ETC
if [ ! -f $ETC/home.env ]; then
  ( umask 077; T="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28)"
    cat > $ETC/home.env <<ENV
# The home server's settings (docs/operator/RUNNING-A-SERVER.md). Root's, 0600; systemd reads it for both services.
# Do not set a path or a port the units set. After an edit: sudo deploy/home/start.sh
# The key a join needs (the page loads without it). The door joins with WORLD_TOKEN: keep the two equal.
JOIN_TOKEN=$T
WORLD_TOKEN=$T
# Once a tunnel or TLS proxy fronts 127.0.0.1:8940: its public address, and the header it OVERWRITES with the client's
# address (every connection reaches the server from loopback, so the server believes whichever header is named here):
#HN_NATIVE_ORIGIN=https://<the public host>
#PROXY_ADDRESS_HEADER=x-forwarded-for
# The operator by account, in place of claiming the setup link the first boot prints:
#SERVER_OPERATORS=
# aid1 sign-in: the issuer's PUBLIC key. Unset: no sign-in, and an agent needs a row in agents/agent-tokens.json.
#HN_ISSUER_KEY=ed25519:...
ENV
  )
  echo "start: wrote $ETC/home.env with a new JOIN_TOKEN (read it with: sudo grep JOIN_TOKEN $ETC/home.env)"
fi
chown root:root $ETC/home.env; chmod 600 $ETC/home.env
# agents' tokens: root's, readable by the service's group; their directory is bound into the sandbox read-only, so an
# edit that replaces the file is still seen inside (shape: mcpl/tokens.example.json)
install -d -m 750 -o root -g $U $ETC/agents
[ -f $ETC/agents/agent-tokens.json ] || echo '{}' > $ETC/agents/agent-tokens.json
chown root:$U $ETC/agents/agent-tokens.json; chmod 640 $ETC/agents/agent-tokens.json

# 4. the state disk: its own filesystem, so "fill the disk" stops at its size and not at this machine's. A filesystem
#    you mounted here yourself is used as it is; otherwise a tmpfs, which a reboot empties (RUNNING-A-SERVER, "State").
mkdir -p $STATE
if ! mountpoint -q $STATE; then
  mount -t tmpfs -o "size=${STATE_SIZE:-1G},nr_inodes=200k,nosuid,nodev,noexec,mode=700" eidoverse-home-state $STATE
  echo "start: state is a ${STATE_SIZE:-1G} tmpfs: worlds survive a restart of the server, NOT a reboot (RUNNING-A-SERVER.md, 'State')"
fi
install -d -o $U -g $U -m 700 $STATE/home $STATE/worlds $STATE/backups $STATE/opt
# everything in it is the service user's, also on a filesystem that outlived a purge (the user's id may be new)
chown -R $U:$U $STATE; chmod 700 $STATE

# 5. the units, and the sandbox as a drop-in of the two services (yours, from `systemctl edit`, are other files)
for u in "$KIT"/*.service "$KIT"/*.socket "$KIT"/*.slice; do install -m 644 "$u" $SD/; done
for s in eidoverse-home eidoverse-home-door; do
  install -d -m 755 $SD/$s.service.d
  sed "s|@LIBRARY@|$LIB|" "$KIT/sandbox.conf" > $SD/$s.service.d/10-sandbox.conf; chmod 644 $SD/$s.service.d/10-sandbox.conf
done
systemctl daemon-reload
systemctl reset-failed 'eidoverse-home*' 2>/dev/null || true   # a crash loop that hit its start limit doesn't block a fixed start
# restart, not start: new code, a changed unit or a changed home.env takes a fresh process (worlds replay from their logs)
systemctl restart eidoverse-home.service eidoverse-home-door.service
systemctl restart eidoverse-home-web-proxy.socket eidoverse-home-door-proxy.socket
sleep 2   # Type=exec has already failed a service that could not start; this catches one that started and fell over
for s in eidoverse-home.service eidoverse-home-door.service eidoverse-home-web-proxy.socket eidoverse-home-door-proxy.socket; do
  systemctl is-active --quiet $s || die "$s is not active: sudo journalctl -u $s -n 40"
done
at() { systemctl show -p Listen --value "$1" | sed 's/ (Stream)//'; }
echo "start: up, code $SHA. page http://$(at eidoverse-home-web-proxy.socket)  door ws://$(at eidoverse-home-door-proxy.socket)  log: sudo journalctl -fu eidoverse-home"
echo "start: on this machine only. Making it public is your own, separate step."

#!/usr/bin/env bash
# Stop the home server: the two ways in, then the servers.
#   sudo deploy/home/stop.sh           stop; everything stays installed and `start.sh` brings it back
#   sudo deploy/home/stop.sh --purge   also remove the units, the code in /opt, the settings and tokens in /etc, the
#                                      user, and the state if it is start.sh's tmpfs (a filesystem you mounted stays)
# It cannot turn off a tunnel or proxy you pointed at this machine: do that too, or whatever next listens on the port is public.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "stop: run it with sudo" >&2; exit 1; }
STATE=/var/lib/eidoverse-home; SD=/etc/systemd/system
WAYS_IN="eidoverse-home-web-proxy.socket eidoverse-home-door-proxy.socket eidoverse-home-web-proxy.service eidoverse-home-door-proxy.service"
ALL="$WAYS_IN eidoverse-home-door.service eidoverse-home.service"
systemctl stop $WAYS_IN 2>/dev/null
systemctl stop eidoverse-home-door.service eidoverse-home.service 2>/dev/null
left=0; for s in $ALL; do st="$(systemctl is-active $s)"; printf 'stop: %-40s %s\n' $s "$st"; [ "$st" = active ] && left=1; done
echo "stop: a tunnel or proxy pointed at this server, if you set one up, is still on. Turn it off as well."
if [ "${1:-}" = "--purge" ]; then
  [ $left = 0 ] || { echo "stop: something is still running; nothing removed" >&2; exit 1; }
  systemctl disable $ALL >/dev/null 2>&1
  for u in $ALL eidoverse_home.slice; do rm -rf "$SD/$u" "$SD/$u.d"; done
  systemctl daemon-reload
  if [ "$(findmnt -n -o SOURCE $STATE 2>/dev/null)" = eidoverse-home-state ]; then umount $STATE && rmdir $STATE
  elif mountpoint -q $STATE; then echo "stop: $STATE is a filesystem you mounted: left mounted, with its worlds"; fi
  rm -rf /opt/eidoverse-home /etc/eidoverse-home
  echo "stop: units, code, settings and tokens removed."
  if id -u eidoverse-home >/dev/null 2>&1 && ! userdel eidoverse-home; then
    echo "stop: the user eidoverse-home is still in use (an inside.sh command running?): end it, then sudo userdel eidoverse-home" >&2; exit 1
  fi
fi
exit $left

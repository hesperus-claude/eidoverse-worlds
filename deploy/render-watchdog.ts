// Keeps the /snap renderer alive AND current (a leaking client keeps its websocket open while answering nothing).
// Restarts it on any of:
//   - crash        — Chrome process gone
//   - hang         — main thread unresponsive to a trivial CDP eval
//   - frozen       — booted but not joined, no frames, or no frame it can capture, for several checks
//   - memory       — RSS over a cap, before it reaches the hang zone
//   - stale code   — the served client changed (a deploy)
//   - old age      — a max uptime, as a backstop against slow leaks
//
// Env: SHOW_URL WORLD KEY (as run-mac-renderer.sh), plus PORT (devtools),
//   CHROME, MEM_CAP_GB, MAX_UPTIME_MIN, CHECK_SEC, STRIKES, BOOT_GRACE_SEC.

import { health as healthAt, tally, type Health } from "./render-health.ts";

const SHOW_URL = process.env.SHOW_URL;
if (!SHOW_URL) { console.error("set SHOW_URL (e.g. https://eidoverse.animalabs.ai)"); process.exit(1); }
const WORLD = process.env.WORLD ?? "commons";
const KEY = process.env.KEY ?? "";
const PORT = Number(process.env.PORT ?? 9223);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = process.env.PROFILE ?? `/tmp/eido-renderer-${WORLD}`;

const MEM_CAP_GB = Number(process.env.MEM_CAP_GB ?? 5.5);   // fresh is ~2.8; hang was ~6.8
const MAX_UPTIME_MIN = Number(process.env.MAX_UPTIME_MIN ?? 180);
const CHECK_SEC = Number(process.env.CHECK_SEC ?? 20);
const STRIKES = Number(process.env.STRIKES ?? 3);           // consecutive bad checks → restart
const BOOT_GRACE_SEC = Number(process.env.BOOT_GRACE_SEC ?? 45);
const VERSION_URL = `${SHOW_URL}/client-version`;

// ROAM=1: starts in WORLD; the server sends it to any snapshot with no renderer serving (server/snapshots.ts)
const ROAM = /^(1|true|yes)$/i.test(process.env.ROAM ?? "");
// lite=0: early kills would trip the boot tripwire (index.html) into a lite client with no renderer; the URL outranks it
const URL = `${SHOW_URL}/?world=${WORLD}&renderer&lite=0&name=mac-gpu-${ROAM ? "roam-" : ""}${WORLD}` + (ROAM ? "&roam" : "") + (KEY ? `&key=${KEY}` : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[watchdog ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sh = async (cmd: string) => (await new Response(Bun.spawn(["bash", "-c", cmd]).stdout).text()).trim();

/** GB, every Chrome process in this profile's tree */
async function rssGB(): Promise<number> {
  const out = await sh(`ps aux | grep 'user-data-dir=${PROFILE}' | grep -v grep | awk '{s+=$6} END{print s+0}'`);
  return (Number(out) || 0) / 1048576;
}

/** null (absent/old server) means "can't tell, don't restart". */
async function clientVersion(): Promise<string | null> {
  try {
    const r = await fetch(VERSION_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return (await r.text()).trim().slice(0, 200);
  } catch { return null; }
}

async function killTree() {
  await sh(`pkill -9 -f 'user-data-dir=${PROFILE}' || true`);
  await sleep(2000);
}

async function launch() {
  await killTree();
  log(`launching renderer → ${WORLD}`);
  Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-extensions", URL],
    { stdout: "ignore", stderr: "ignore" });
}

// never leave an orphan renderer when the watchdog is killed
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { log("shutting down — killing renderer"); await killTree(); process.exit(0); });
}

log(`watching ${SHOW_URL}/?world=${encodeURIComponent(WORLD)}&renderer  (credential redacted; mem cap ${MEM_CAP_GB}GB, max uptime ${MAX_UPTIME_MIN}m, check ${CHECK_SEC}s)`);
for (;;) {
  await launch();
  const started = Date.now();
  await sleep(BOOT_GRACE_SEC * 1000);
  // the baseline binds LATE (first readable version): it can be unreadable at boot, and a null baseline
  // would never pick up a deploy again
  let bornVersion = await clientVersion();
  let strikes = 0, reason = "";

  while (!reason) {
    await sleep(CHECK_SEC * 1000);
    const upMin = (Date.now() - started) / 60000;

    const h = await healthAt(PORT).catch((e) => ({ alive: true, healthy: false, reason: `probe error: ${e?.message ?? e}` } as Health));
    if (!h.alive) { reason = "crashed"; break; }

    const rss = await rssGB();
    if (rss > MEM_CAP_GB) { reason = `memory ${rss.toFixed(1)}GB`; break; }
    if (upMin > MAX_UPTIME_MIN) { reason = `uptime ${upMin.toFixed(0)}m`; break; }

    const nowVersion = await clientVersion();
    if (bornVersion === null && nowVersion !== null) {
      // late baseline: a deploy we could not observe can't be acted on; adopt what we read now
      bornVersion = nowVersion;
      log(`client version readable again — baseline adopted`);
    } else if (bornVersion && nowVersion && nowVersion !== bornVersion) {
      reason = "client updated"; break;
    }

    const was = strikes, t = tally(strikes, h, STRIKES);
    strikes = t.strikes;
    if (t.restart) { reason = `unhealthy (${h.reason})`; break; }
    if (!h.healthy) log(`strike ${strikes}/${STRIKES}: ${h.reason}`);
    else if (was) log(`recovered (${h.reason})`);
  }

  log(`restarting: ${reason}`);
  await killTree();
  await sleep(3000);
}

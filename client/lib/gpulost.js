// gpulost — on GPU context loss, reload into the same world (three can't rebuild in place; the server keeps the pose).
// ?xr=1 is dropped so a VR crash lands on the desktop. No auto-reload on a second loss inside GPU_LOST_WINDOW_MS or a
// third inside GPU_LOST_LONG_MS (a boot-then-crash loop outlasts the short one).

export const GPU_LOST_KEY = 'ew-gpu-lost';           // sessionStorage: ms timestamps of recent losses
export const GPU_RECOVERED_KEY = 'ew-gpu-recovered'; // sessionStorage: the reason, read once by the next boot's notice
export const GPU_LOST_WINDOW_MS = 120000;
export const GPU_LOST_LONG_MS = 15 * 60000;   // …and at most GPU_LOST_LONG_MAX losses in this one
export const GPU_LOST_LONG_MAX = 3;

/** Pure: given recent loss times and now, reload or stop? `why` names the rule that stopped it. */
export function gpuLostAction(now, recent) {
  const kept = (recent ?? []).filter((t) => Number.isFinite(t) && now - t >= 0 && now - t < GPU_LOST_LONG_MS);
  const next = [...kept, now];
  if (kept.some((t) => now - t < GPU_LOST_WINDOW_MS)) return { reload: false, recent: next, why: 'second loss inside 2 min' };
  if (next.length >= GPU_LOST_LONG_MAX) return { reload: false, recent: next, why: `${next.length} losses inside 15 min` };
  return { reload: true, recent: next };
}

/** Same URL minus the XR boot flag. */
export function recoveryUrl(href) {
  const u = new URL(href);
  u.searchParams.delete('xr');
  u.searchParams.delete('why');
  return u.toString();
}

export function installGpuLostRecovery({ canvas, renderer, tee = () => {}, onStop = () => {}, win = globalThis }) {
  let handled = false;
  const store = win.sessionStorage;
  const handle = (why) => {
    if (handled) return;
    handled = true;
    let recent = [];
    try { recent = JSON.parse(store?.getItem(GPU_LOST_KEY) || '[]'); } catch {}
    const act = gpuLostAction(Date.now(), recent);
    try { store?.setItem(GPU_LOST_KEY, JSON.stringify(act.recent)); } catch {}
    tee(`[gpu] LOST (${why}) — ${act.reload ? 'reloading into the live world' : `${act.why}, not reloading again`}`);
    if (!act.reload) { onStop(why, act.why); return; }
    try { store?.setItem(GPU_RECOVERED_KEY, why); } catch {}
    // disarm the lite tripwire (index.html), or this deliberate reload reads as a dead boot and lands in the phone client
    try { win.localStorage?.removeItem(win.__ewTripKey?.(new URLSearchParams(win.location.search)) ?? 'ew-boot-attempt'); } catch {}
    // a beat for the tee's beacon to leave
    win.setTimeout(() => win.location.replace(recoveryUrl(win.location.href)), 400);
  };
  // preventDefault: the spec's "we intend to handle this"; without it no restore event is ever offered
  canvas?.addEventListener('webglcontextlost', (e) => { e.preventDefault?.(); handle('webgl context lost'); });
  // 'destroyed' is ours only when WE called destroy() (three's dispose() goes through this object): Chrome also
  // reports it for a device it tore down itself, and ignoring that renders into a dead device every frame.
  const device = renderer?.backend?.device;
  let destroyedByUs = false;
  if (device?.destroy) { const d0 = device.destroy; device.destroy = function (...a) { destroyedByUs = true; return d0.apply(this, a); }; }
  device?.lost?.then((info) => { if (!(info?.reason === 'destroyed' && destroyedByUs)) handle(`webgpu device lost: ${info?.message || info?.reason || '?'}`); });
  return { handle, get fired() { return handled; } };
}

/** Read once by the boot after a recovery: the reason, or null. */
export function takeGpuRecovered(win = globalThis) {
  // the dying page must not consume it: a boot-time loss can race its late notice init; the flag is for the NEXT page
  if (win.__gpuLost?.fired) return null;
  try { const v = win.sessionStorage?.getItem(GPU_RECOVERED_KEY); if (v) win.sessionStorage.removeItem(GPU_RECOVERED_KEY); return v || null; } catch { return null; }
}

/** Losses this tab recorded inside the long window. */
export function recentGpuLosses(win = globalThis, now = Date.now()) {
  try {
    const recent = JSON.parse(win.sessionStorage?.getItem(GPU_LOST_KEY) || '[]');
    return Array.isArray(recent) ? recent.filter((t) => Number.isFinite(t) && now - t >= 0 && now - t < GPU_LOST_LONG_MS).length : 0;
  } catch { return 0; }
}

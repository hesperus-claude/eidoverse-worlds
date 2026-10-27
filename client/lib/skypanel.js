// skypanel — the ☀ sky section of the world panel.
// everything PREVIEWS; only commit writes: the log replays for every future joiner, so trying things out stays out of it

import { sendOps } from './editwrites.js';
import { bus, report } from './base.js';
import { serverNow } from './serverclock.js';   // a server stamp is read on the authority's clock
import { defsRegistry } from './defs.js';
import { flashHint } from './ui.js';
import { selectRow } from './rows.js';
import { previewSky, skyArgs, skyImpl, WEATHERS, CLOUDS, SKY_WORLDS,
  CLOUD_QUALITY, getCloudChoice, setCloudQuality, cloudCap, skyInXR } from './sky.js';
import { GRASS_QUALITY, getGrassQuality, setGrassQuality,
  getGrassDensity, getGrassShed, getGrassApplied } from './terrain.js';
import { MODEL_QUALITY } from './lod_policy.js';
import { loggedSky, skyPreviewing, skyRendering, skyDegraded, getCloudQuality } from './sky.js';
import { effectiveClock } from '../../shared/forecast.js';
import { stateLines } from './statelines.js';
import { modelQuality, dialModelQuality } from './realize/models.js';

const SLIDERS = [
  ['hours', 'time', 0, 24, 0.1, 12],
  ['rate', 'rate', 0, 48, 0.5, 0],
  ['azimuth', 'azim', 0, 360, 5, 180],   // shown in degrees, stored in radians
  ['ambient', 'ambnt', 0, 2.5, 0.05, 1],   // no sun/fill: they're the renderer rig's knobs, never stored
  ['exposure', 'expos', 0.3, 1.8, 0.05, 1],
  ['fog', 'fog', 0, 3, 0.05, 1],
];
// presets are DATA (defs/sky/_presets.json) that only fill the sliders: the log never stores a preset name

export function paintSky(body) {
  if (body.dataset.init) { body._sync?.(); body._readState?.(); return; }
  body.dataset.init = '1';
  body.innerHTML = '';
  const inputs = {};
  const commit = document.createElement('button');

  // what the log says, and what you're seeing instead (only while those differ)
  const lines = stateLines();
  lines.el.classList.add('sky-state');
  body.appendChild(lines.el);
  let lastLogged = null;
  const readState = () => {
    const L = loggedSky();
    if (!L) { lines.set('no sky logged yet', skyRendering() ? 'loading…' : null); return; }
    const a = L.args;
    if (L !== lastLogged) {
      // someone (maybe you) logged a sky: follow it, unless you're mid-edit
      const first = lastLogged === null;
      lastLogged = L;
      if (!first && !commit.classList.contains('dirty')) body._sync?.();
    }
    const parts = [];
    if (a.system === 'skymesh') parts.push('basic sky');
    // what actually drives the sun: no tz follows Los Angeles, and a tz that doesn't resolve leaves the parked clock
    const ec = effectiveClock({ ...a, ts: L.t0 }, serverNow());
    if (ec.mode === 'real') parts.push(`real clock (${ec.tz})`);
    else {
      const h = ((ec.hour % 24) + 24) % 24;
      parts.push(`${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`
        + `${ec.mode === 'rated' ? ' (running)' : ''}${ec.requestedTz ? ` (tz ${ec.requestedTz} not recognised)` : ''}`);
    }
    if (a.weather) parts.push(a.weather);
    // the detailed sky builds cumulus for a log with no (or an unknown) clouds value (sky.js makeSky), so say that
    const basic = a.system === 'skymesh';
    const clouds = basic ? a.clouds : (CLOUDS.includes(a.clouds) ? a.clouds : 'cumulus');
    if (clouds) parts.push(`clouds ${clouds}`);
    if (a.world && a.world !== 'earth') parts.push(a.world);
    const you = [];
    if (skyRendering()) you.push('loading…');
    if (skyPreviewing()) you.push('previewing (not logged)');
    // unsaved edits, no preview: a log landed on top (applySky ends a preview); said, never re-previewed over a shared sky
    else if (commit.classList.contains('dirty')) you.push("your unsaved edits aren't shown — a new sky was logged");
    if (!basic && getCloudQuality() === 'off' && clouds !== 'clear') you.push('no clouds (your clouds⚙ is off)');
    if (skyDegraded() && a.system !== 'skymesh') you.push("the basic sky (this GPU can't run the full one)");
    lines.set(parts.join(' · '), you.join(' · '));
  };
  bus.on('sky-state', readState);
  bus.on('sky-degraded', readState);
  // a closed panel stays connected (only hidden), so poll only a rendered box; reopening reads at once (top of paintSky)
  setInterval(() => { if (body.getClientRects().length) readState(); }, 30000);
  body._readState = readState;

  const local = {};
  const preview = (patch) => {
    Object.assign(local, patch);
    previewSky({ ...gather() }).catch((e) => report('sky preview', e));
    commit.classList.add('dirty');
  };

  const gather = () => {
    // sliders WIN over `local`: a preset that stashed a slider key would otherwise shadow it for the session
    const a = { ...skyArgs(), ...local };
    for (const [key, , , , , dflt] of SLIDERS) {
      const v = Number(inputs[key].value);
      if (key === 'hours' || key === 'azimuth' || v !== dflt) a[key] = key === 'azimuth' ? v * Math.PI / 180 : v;
    }
    delete a.world; delete a.sun; delete a.fill;   // cut from the sky: the door refuses them
    return a;
  };

  const mkRow = (label, node) => {
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = label;
    row.append(nm, node);
    return row;
  };

  // presets — populated from the def registry, repopulated on a defs push
  const presetWrap = document.createElement('div');
  presetWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; margin-bottom:4px;';
  const fillPresets = () => defsRegistry().then((reg) => {
    presetWrap.innerHTML = '';
    for (const [name, vals] of Object.entries(reg.skyPresets ?? {})) {
      const b = document.createElement('button');
      b.textContent = name;
      b.style.flex = '1 0 auto';
      b.onclick = () => {
        if (vals.hours != null) inputs.hours.value = vals.hours;
        if (vals.clouds) cl.value = vals.clouds;
        inputs.hours.dispatchEvent(new Event('input'));   // previews via the slider path
        preview({ ...vals });
      };
      presetWrap.appendChild(b);
    }
  }).catch((e) => report('sky presets', e));
  fillPresets();
  bus.on('defs-updated', fillPresets);
  body.appendChild(presetWrap);

  // weather — a first-class verb, not a slider
  const { row: wxRow, select: wx } = selectRow('wx', WEATHERS, null,
    (v) => preview({ weather: v, weatherSeconds: 12 }));
  body.appendChild(wxRow);

  const { row: clRow, select: cl } = selectRow('cloud', CLOUDS, 'cumulus',
    (v) => preview({ clouds: v }));
  body.appendChild(clRow);

  const { row: wlRow, select: wl } = selectRow('world', SKY_WORLDS, null,
    (v) => preview({ world: v }));
  body.appendChild(wlRow);

  // cloud budget is YOURS, never a verb: the march's cost is per-fragment, so a big high-refresh display pays more
  const { row: cqRow, select: cq } = selectRow('clouds⚙', CLOUD_QUALITY, getCloudChoice(),
    (v) => { setCloudQuality(v); flashHint(`clouds: ${v} (yours only). The first time a setting is used, your GPU may pause a few seconds to compile it`); });
  cqRow.title = 'local performance setting — not shared with the world';
  body.appendChild(cqRow);
  // in a headset 'high' (the live march) is greyed; when it's YOUR choice a VR-only note says what runs instead
  const cqNote = document.createElement('div');
  cqNote.className = 'cloud-cap-note';
  cqNote.style.cssText = 'font-size:10px;color:var(--dim);padding:0 2px 4px;line-height:1.35';
  cqNote.hidden = true;
  body.appendChild(cqNote);
  let inXR = skyInXR();   // the panel may first paint mid-session
  const syncCap = () => {
    const live = [...cq.options].find((o) => o.value === 'high');
    if (live && live.disabled !== inXR) live.disabled = inXR;
    const cap = cloudCap();
    const text = inXR && cap ? `In VR your clouds run at medium (baked). High clouds march every pixel for each eye, which halves a headset's frame rate; your high setting comes back when you leave VR.` : '';
    if (cqNote.textContent !== text) cqNote.textContent = text;
    if (cqNote.hidden !== !text) cqNote.hidden = !text;
    cq.value = getCloudChoice();
  };
  bus.on('xr:state', (on) => { inXR = !!on; syncCap(); });
  bus.on('cloud-cap', syncCap);
  syncCap();

  // the meadow cap is YOURS (#60), persisted; species/seed/extent stay world state
  // the governor may thin below the cap under load, never above it
  const { row: gqRow, select: gq } = selectRow('grass⚙', GRASS_QUALITY, null, null);
  gq.setAttribute('aria-label', 'grass quality — local only, never shared with the world');
  // visible text, not a tooltip (keyboard, screen readers): select = your cap, ⚙× = governor's dial, ×draws = min()
  const gqState = document.createElement('span');
  // NOT `.v` (the sliders' fixed 34px column): it would wrap and reflow the row
  gqState.style.cssText = 'margin-left:auto; white-space:nowrap; color:var(--accent); font-size:10px;';
  gqState.setAttribute('aria-live', 'polite');
  const gqStateEye = document.createElement('span');
  gqStateEye.setAttribute('aria-hidden', 'true');
  const gqStateEar = document.createElement('span');
  gqStateEar.style.cssText = 'position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0);';
  gqState.append(gqStateEye, gqStateEar);
  gqRow.appendChild(gqState);
  const syncGrassRow = () => {
    gq.value = getGrassQuality();
    const shed = getGrassShed(), eff = getGrassDensity();
    const active = shed < 1 && gq.value !== 'off';
    // the programmatic surface's own report (#74), so the row never claims a density the renderer didn't
    // a false cap outranks governor detail for the row's scarce pixels
    const rep = getGrassApplied();
    const bad = rep.field && rep.status !== 'applied';
    if (bad) {
      const names = rep.strokes.filter((s) => !s.ok).map((s) => s.stroke).join(', ');
      gqStateEye.textContent = `⚠${rep.status}`;
      gqStateEar.textContent = `grass cap ${gq.value} ${rep.status}` +
        (names ? `: stroke ${names} has no working density dial` : '');
      gqRow.title = `your cap asked for ×${eff} but the renderer did not fully apply it` +
        ` (${rep.status}${names ? `: ${names}` : ''}) — affected strokes draw at their built density`;
      return;
    }
    gqStateEye.textContent = active ? `⚙${shed}→${eff}` : '';
    gqStateEar.textContent = active ? `auto governor dial ${shed}, drawing ${eff}` : '';
    gqRow.title = active
      ? `your cap: ${gq.value} — the auto governor's session dial is ×${shed}; the field draws the lower of the two`
      : 'local performance setting — not shared with the world';
  };
  gq.onchange = () => {
    setGrassQuality(gq.value);
    syncGrassRow();
    flashHint(`grass: ${gq.value} (yours only)`);
  };
  syncGrassRow();
  bus.on('grass-budget', syncGrassRow);   // governor sheds repaint immediately
  body.appendChild(gqRow);

  // render scale lives in Settings › Video (videopanel.js)

  // the geometry tier is YOURS (#156), persisted, never a verb: 'auto' reduces far objects, 'full' never, 'eco' sooner
  // nothing near you or any body is reduced
  const { row: mqRow, select: mq } = selectRow('models⚙',
    MODEL_QUALITY.map((v) => [v, v === 'auto' ? 'auto' : v === 'full' ? 'full detail' : 'eco (reduce sooner)']),
    modelQuality.quality,
    // behaviour lives in models.js (dialModelQuality) so the product-door harness gates it; this row only binds
    (v) => flashHint(dialModelQuality(v)));
  mq.setAttribute('aria-label', 'model detail tier — local only, never shared with the world');
  mqRow.title = 'local performance setting — not shared with the world';
  body.appendChild(mqRow);

  // BASIC-sky-only sliders: the real sky's engine owns sun direction and bounce fill (sky.js), so hidden, not greyed (§12.6)
  const BASIC_ONLY = new Set(['azimuth', 'fill']);
  const basicRows = [];
  const syncBasicOnly = () => {
    const dead = skyImpl() === 'eidoverse';
    for (const { row, input } of basicRows) {
      if (input.disabled !== dead) input.disabled = dead;
      const d = dead ? 'none' : '';
      if (row.style.display !== d) row.style.display = d;   // style, not [hidden]: a .row display rule would beat the attribute
    }
  };

  for (const [key, label, min, max, step, dflt] of SLIDERS) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = dflt;
    const val = document.createElement('span');
    val.className = 'v';
    val.textContent = dflt;
    input.oninput = () => {
      val.textContent = input.value;
      previewSky(gather()).catch((e) => report('sky preview', e));
      commit.classList.add('dirty');
    };
    inputs[key] = input;
    const row = mkRow(label, input);
    row.appendChild(val);
    if (BASIC_ONLY.has(key)) basicRows.push({ row, input });
    body.appendChild(row);
  }
  syncBasicOnly();
  // a logged system switch or the first sky changes skyImpl() after the repaint that last synced these rows
  bus.on('sky-ready', syncBasicOnly);
  bus.on('sky-state', syncBasicOnly);

  // `clock: real` = the named tz's wall hour (DST incl., hoursAt; offers in defs/sky/_clocks.json); the slider yields
  // clearing stashes undefined so the verb's JSON drops the keys (a null would linger in the fold)
  const { row: ckRow, select: ck } = selectRow('clock',
    [['', 'authored (slider)']], '', null);
  const fillClocks = () => defsRegistry().then((reg) => {
    const sa = skyArgs(); const want = typeof sa.tz === 'string' ? sa.tz : sa.clock === 'real' ? (sa.tz ?? '') : ck.value;   // a tz present is the wall clock
    ck.textContent = '';
    ck.appendChild(new Option('authored (slider)', ''));
    for (const c of Object.values(reg.skyClocks ?? {})) {
      if (c?.tz) ck.appendChild(new Option(c.label ?? c.tz, c.tz));
    }
    // a committed tz the def no longer lists: show the raw tz, never a silent "authored"
    if (want && ![...ck.options].some((o) => o.value === want)) {
      ck.appendChild(new Option(`real time — ${want}`, want));
    }
    ck.value = want;
  }).catch((e) => report('sky clocks', e));
  fillClocks();
  bus.on('defs-updated', fillClocks);
  // under a real clock time and rate do nothing: hidden like the basic-only rows; presets set the look, not the hour
  const syncClockUi = () => {
    // the clock the commit will SEND, not the select's: with unsaved edits a remote clock change never reaches it
    const g = gather(); const real = g.clock === 'real' || (typeof g.tz === 'string' && g.clock === undefined && g.tz !== '');
    for (const k of ['hours', 'rate']) {
      const input = inputs[k], row = input?.parentNode; if (!input || !row) continue;
      input.disabled = real;
      const d = real ? 'none' : '';
      if (row.style.display !== d) row.style.display = d;
    }
    presetWrap.title = real ? 'under a real clock the presets set the look, not the hour' : '';
  };
  ck.onchange = () => {
    if (ck.value !== '') { local.clock = 'real'; local.tz = ck.value; }
    else {
      local.clock = undefined; local.tz = undefined;
      // back to authored: restore the day/rate the fold parked under dormantRated (#65), not noon-at-rate-0
      const d = skyArgs().dormantRated;
      if (d) for (const k of ['hours', 'rate']) if (d[k] != null && inputs[k]) {
        inputs[k].value = d[k];
        inputs[k].parentNode.querySelector('.v').textContent = inputs[k].value;
      }
    }
    syncClockUi();
    previewSky(gather()).catch((e) => report('sky preview', e));
    commit.classList.add('dirty');
  };
  syncClockUi();
  ckRow.title = 'real time: the sun tracks the named city’s actual clock — noon is noon';
  body.appendChild(ckRow);

  commit.textContent = '✓ log to world';
  commit.title = 'share this sky with everyone, permanently';
  commit.onclick = () => {
    sendOps([{ verb: 'sky', args: gather() }], { what: 'the sky', expect: false });
    commit.classList.remove('dirty');
    commit.textContent = '✓ logged';
    setTimeout(() => { commit.textContent = '✓ log to world'; }, 1200);
  };
  body.appendChild(commit);

  body._sync = () => {
    // nothing unsaved: the log speaks for `local`, so forget it, or it overrides later remote changes
    // with edits pending (a panel re-open) it's the person's work: keep it
    if (!commit.classList.contains('dirty')) for (const k of Object.keys(local)) delete local[k];
    const a = skyArgs();
    for (const [key, , , , , dflt] of SLIDERS) {
      // under a real clock hours/rate live in dormantRated: load them (rows hidden) as what the world would return to
      inputs[key].value = key === 'azimuth' ? (typeof a.azimuth === 'number' ? +(a.azimuth * 180 / Math.PI).toFixed(1) : dflt) : (a[key] ?? a.dormantRated?.[key] ?? dflt);
      inputs[key].parentNode.querySelector('.v').textContent = inputs[key].value;
    }
    if (a.weather) wx.value = a.weather;
    if (a.clouds) cl.value = a.clouds;
    if (a.world) wl.value = a.world;
    // fillClocks appends a raw-tz option when the committed clock is one the def no longer lists
    const realTz = typeof a.tz === 'string' ? a.tz : a.clock === 'real' ? 'America/Los_Angeles' : '';   // a tz present is the wall clock
    ck.value = realTz;
    if (realTz && ck.value !== realTz) fillClocks();
    syncClockUi();
    syncBasicOnly();
    syncGrassRow();
  };
  body._sync();
  readState();
}

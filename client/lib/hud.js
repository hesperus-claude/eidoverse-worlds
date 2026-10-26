// hud — the ∃ mark: what must be ambient, connection truth (the mark dims + pulses when the socket is down)
// and the editing flag (warn dot). The mic/ear glyphs anchor to this element's edge (mictoggle.js).
// Painted at 1 Hz by main.js's pulse system.

import { net } from './net.js';

export function paintHud() {
  const hud = document.getElementById('hud');
  if (!hud) return;
  hud.classList.toggle('net-live', net.status === 'live');
  hud.classList.toggle('net-wait', net.status === 'connecting' || net.status === 'retrying');
  hud.title = net.status === 'live'
    ? 'eidoverse — menu'
    : `eidoverse — ${net.status}…`;
}

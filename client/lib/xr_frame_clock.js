// Who owns window.requestAnimationFrame while a session presents, as pure state; xr.js installs it (tools/xr-frame-clock-test.mjs).
// No imports on purpose. Register the restore BEFORE setSession (three's 'end' restarts the desktop loop via window.rAF);
// save natives once per page; no shim under IWER (it drives the session on window.rAF).

export function captureNative(saved, win) {
  if (saved) return saved;   // already ours: a second capture would save the SHIM as native
  return { raf: win.requestAnimationFrame.bind(win), caf: win.cancelAnimationFrame.bind(win) };
}

/** Do we shim at all? Not under an emulator whose session clock IS the window clock. */
export function shouldShim({ emulated = false } = {}) { return !emulated; }

/** Native once ended or if the session throws: a session can die between the check and the call. */
export function makeFrameShim({ session, native, hasEnded }) {
  return (cb) => {
    if (hasEnded()) return native.raf(cb);
    try { return session.requestAnimationFrame((t) => cb(t)); }
    catch { return native.raf(cb); }
  };
}

/** Cancel reaches both clocks: an id handed out before the swap may belong to either. */
export function makeCancelShim({ session, native }) {
  return (id) => {
    try { session.cancelAnimationFrame(id); } catch { /* not the session's id, or it is gone */ }
    try { native.caf(id); } catch { /* not the window's id */ }
  };
}

/** What a test should assert: not "restore was called" but "window.rAF is the function we saved". */
export function clockIsRestored(win, native) {
  return !!native && win.requestAnimationFrame === native.raf && win.cancelAnimationFrame === native.caf;
}

/** Capture, register the restore before setSession, then shim: one owned sequence (tools/xr-session-lifecycle-test.mjs).
 *  @param win     the window whose clock is being taken over
 *  @param session the XRSession (or anything with addEventListener/requestAnimationFrame)
 *  @param saved   the previously-saved native pair, or null on a first entry (save-once)
 *  @param emulated true under IWER, where the emulator drives frames itself
 *  @param onEnd   extra teardown to run after the clock is restored
 *  @returns {{ native, installed, restore }} */
export function installFrameClock({ win, session, saved, emulated = false, onEnd = null }) {
  const native = captureNative(saved, win);   // save-once
  let ended = false, restored = false;
  // a generation, so a stale session's end can't take the clock from a live one; only the current claimant restores
  const gen = (win.__xrClockGen = (win.__xrClockGen ?? 0) + 1);
  const restore = () => {
    ended = true;
    if (restored) return false;
    restored = true;
    if (win.__xrClockGen !== gen) return false;   // superseded: a newer session owns the clock now
    win.requestAnimationFrame = native.raf; win.cancelAnimationFrame = native.caf;
    return true;
  };
  // BEFORE setSession, where three registers its own 'end': listeners fire in order, so ours must be first or three
  // restarts the desktop loop against a dead session and no frame ever ticks again
  session.addEventListener('end', () => { restore(); if (onEnd) onEnd(); }, { once: true });
  let installed = false;
  if (shouldShim({ emulated })) {
    win.requestAnimationFrame = makeFrameShim({ session, native, hasEnded: () => ended });
    win.cancelAnimationFrame = makeCancelShim({ session, native });
    installed = true;
  }
  return { native, installed, restore };
}

/** This decides what `emulated` means, so a test can prove a real runtime (no IWER) gets a shim.
 *  @param globals where to look for an emulator; defaults to globalThis so the product need not say. */
export function installEntryClock({ win, session, saved, globals = globalThis, onEnd = null }) {
  const emulated = !!globals?.IWER;   // IWER drives the session clock ON window.rAF; shimming feeds it to itself
  return installFrameClock({ win, session, saved, emulated, onEnd });
}

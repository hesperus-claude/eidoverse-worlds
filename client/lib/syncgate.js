// syncgate — no pipeline is ever LINKED on the render path (WebGL backend), where a sync link can freeze the browser.
// Backstop for what the warms miss: with KHR_parallel_shader_compile the build goes to three's polling branch and pops in late.
// ?syncgate=0 turns the gate off; the census still tees builds ≥ SLOW_MS.
const SLOW_MS = 250;
const GIANT_FS = 400000;   // chars of fragment source: only the sky's cloud programs are this big
// the world's own pass: no target, or the one three's _renderScene binds (tone-mapping framebuffer, XR eye); else someone's target
const isWorldPass = (rt) => rt === null || !!rt?.isPostProcessingRenderTarget || !!rt?.isXRRenderTarget;
// most three children are anonymous under a named root
const named = (o) => { for (let n = o, d = 0; n && d < 6; n = n.parent, d++) if (n.name) return d ? `${n.name}›${d}` : n.name; return '(unnamed)'; };

export function installSyncGate(renderer, { tee = () => {}, gate = true } = {}) {
  const be = renderer.backend;
  if (!be || be.isWebGPUBackend || be.__syncGate) return null;
  const orig = be.createRenderPipeline?.bind(be);
  if (!orig) return null;
  const stats = { renderPath: 0, deferred: 0, intoTarget: 0, slow: [], parallel: !!be.parallel, gate };
  be.__syncGate = stats;
  const pendingGiant = new Set();

  be.createRenderPipeline = (renderObject, promises) => {
    if (promises != null) {                                              // compileAsync: three polls already
      // a BIG program can still freeze the GPU process on a cold cache: name it now, so a freeze leaves it last in the clientlog
      const ret = orig(renderObject, promises);
      const fs = renderObject.pipeline?.fragmentProgram?.code?.length ?? 0;
      if (fs > 200000) {
        const o = renderObject.object, t0 = performance.now(), name = `${o?.type ?? '?'}:${named(o)} ${renderObject.material?.type ?? '?'} fs ${fs}`;
        tee(`[syncgate] async compile started: ${name}`, true);
        Promise.all(promises).then(() => tee(`[syncgate] async compile linked after ${(performance.now() - t0).toFixed(0)} ms: ${name}`, true), () => {});
      }
      return ret;
    }
    stats.renderPath++;
    if (!isWorldPass(renderer.getRenderTarget())) stats.intoTarget++;
    const t0 = performance.now();
    // Only the screen's WORLD may wait a frame: a skipped draw into a one-shot target (bake, PMREM) is a permanently wrong texture.
    // Exception: a GIANT program into a target defers too (a sync link that size can reset the driver); that draw is skipped until it links.
    const fsLen = renderObject.pipeline?.fragmentProgram?.code?.length ?? 0;
    const giantAside = fsLen > GIANT_FS && !isWorldPass(renderer.getRenderTarget());
    const deferring = gate && !!be.parallel && (isWorldPass(renderer.getRenderTarget()) || giantAside);
    if (giantAside && gate && be.parallel) stats.intoTargetDeferred = (stats.intoTargetDeferred ?? 0) + 1;
    let ret;
    const mine = [];
    if (deferring) {
      ret = orig(renderObject, mine);
      if (mine.length) stats.deferred++;
      // a bake about to draw with a still-linking giant must wait (whenGiantLinked), or the target stays black.
      // compileAsync can't be used: once the pipeline exists it resolves at once, linked or not.
      if (mine.length && fsLen > GIANT_FS) {
        const pipe = renderObject.pipeline;
        // a disposed material's link (sky torn down mid-link) holds nobody up, or the next sky's bake waits on an orphan
        const mat = renderObject.material;
        const gone = new Promise((res) => { const h = () => { mat?.removeEventListener?.('dispose', h); res(); }; mat?.addEventListener?.('dispose', h); });
        const p = Promise.race([Promise.all(mine).catch(() => {}), gone]).finally(() => pendingGiant.delete(p));
        p.status = () => { try { const gl = be.gl, prog = be.get(pipe)?.programGPU; if (!gl || !prog) return 'no program';
          const done = be.parallel ? gl.getProgramParameter(prog, be.parallel.COMPLETION_STATUS_KHR) : true;
          return done ? `complete, linked=${gl.getProgramParameter(prog, gl.LINK_STATUS)}` : 'still compiling'; } catch (e) { return `? ${e?.message ?? e}`; } };
        pendingGiant.add(p);
      }
    } else {
      ret = orig(renderObject, null);
    }
    const ms = performance.now() - t0;
    if (ms >= SLOW_MS || deferring) {
      const o = renderObject.object, m = renderObject.material, p = renderObject.pipeline;
      const row = {
        ms: +ms.toFixed(0), deferred: deferring,
        object: `${o?.type ?? '?'}:${named(o)}`,
        material: `${m?.type ?? '?'}:${m?.name || ''}`,
        vs: p?.vertexProgram?.code?.length ?? 0, fs: p?.fragmentProgram?.code?.length ?? 0,
        skinned: !!o?.isSkinnedMesh, morphs: o?.morphTargetInfluences?.length ?? 0,
        lights: renderObject.lightsNode?.getLights?.()?.length ?? null,
      };
      if (ms >= SLOW_MS) stats.slow.push(row);
      // a BLOCKING build over a second logs its caller; the stack is only taken on this rare path
      const who = (giantAside || (!deferring && ms >= 1000)) ? ` into ${(() => { const t = renderer.getRenderTarget(); return t ? `${t.texture?.name || t.constructor?.name || 'target'} ${t.width}x${t.height}` : 'canvas'; })()} via ${(() => { const L = Error.stackTraceLimit; Error.stackTraceLimit = 60; try { return String(new Error().stack ?? ''); } finally { Error.stackTraceLimit = L; } })().split('\n').slice(3, 40).map((l) => l.trim().replace(/^at /, '').replace(/\(?https?:\/\/[^/]+\/(lib\/)?/, '').replace(/\)$/, '')).join(' < ')}` : '';
      if (ms >= SLOW_MS || row.fs > 60000) tee(`[syncgate] render-path build ${row.ms} ms${deferring ? ' (deferred link)' : ' (BLOCKING)'} ${row.object} ${row.material} vs ${row.vs} fs ${row.fs} chars skinned=${row.skinned} morphs=${row.morphs} lights=${row.lights}${who}`, ms >= 1000);
      // i.e. how long its object stayed off screen
      if (deferring && row.fs > 60000 && mine.length) Promise.all(mine).then(
        () => tee(`[syncgate] linked after ${(performance.now() - t0).toFixed(0)} ms: ${row.object} ${row.material} fs ${row.fs} chars`),
        (e) => tee(`[syncgate] link FAILED after ${(performance.now() - t0).toFixed(0)} ms: ${row.object} fs ${row.fs}: ${e?.message ?? e}`));
    }
    return ret;
  };

  tee(`[syncgate] installed: parallel-compile ${stats.parallel ? 'yes' : 'NO (gate inert: links block)'}; gate ${gate ? 'on' : 'off (?syncgate=0, census only)'}`);
  // Never gives up (an unlinked giant leaves a baked target black); tees GL status every tickMs. A dead context is gpulost's.
  stats.whenGiantLinked = (tickMs = 120000) => {
    const list = [...pendingGiant];
    if (!list.length) return Promise.resolve(true);
    const t0 = performance.now();
    const timer = setInterval(() => tee(`[syncgate] giant link still pending after ${((performance.now() - t0) / 1000).toFixed(0)} s (waiting, not drawing): ${list.map((p) => p.status?.() ?? '?').join(' | ')}`, true), tickMs);
    return Promise.all(list).then(() => true).finally(() => clearInterval(timer));
  };
  return stats;
}

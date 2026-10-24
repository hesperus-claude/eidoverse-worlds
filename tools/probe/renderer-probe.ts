// Which renderer does Chrome actually use on this host, with the gate's flags? (research 10-23: WARP/D3D11 vs SwiftShader)
import { cdpPage } from "../protocol/chrome.ts";
const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><title>r</title>", { headers: { "content-type": "text/html" } }) });
const p = await cdpPage();
try {
  await p.goto(`http://127.0.0.1:${srv.port}/`);
  const info = await p.evaluate(`(async () => {
    const out = {};
    for (const kind of ["webgl2", "webgl"]) {
      const gl = document.createElement("canvas").getContext(kind);
      if (!gl) { out[kind] = null; continue; }
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      out[kind] = { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) };
    }
    if (!navigator.gpu) out.webgpu = "no navigator.gpu";
    else { const a = await navigator.gpu.requestAdapter(); out.webgpu = a ? { info: a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description } : null, fallback: a.isFallbackAdapter ?? (a.info && a.info.isFallbackAdapter) } : "no adapter"; }
    return out;
  })()`);
  console.log("RENDERER", process.env.PROBE_V ?? "?", JSON.stringify(info));
  await p.goto("chrome://gpu"); await new Promise((r) => setTimeout(r, 3000));
  const gpu = await p.evaluate(`(() => { const t = []; const walk = (n) => { if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.children ?? []) walk(c); if (!n.children?.length && n.textContent) t.push(n.textContent.trim()); }; walk(document.body); return t.filter(Boolean).join(" | "); })()`);
  for (const k of ["GL_RENDERER", "WebGL", "WebGPU", "Basic Render", "SwiftShader", "WARP", "ANGLE", "Graphics Feature Status"]) { const i = gpu.indexOf(k); if (i >= 0) console.log("GPUPAGE", k, "→", gpu.slice(i, i + 260)); }
} finally { await p.close(); srv.stop(true); }

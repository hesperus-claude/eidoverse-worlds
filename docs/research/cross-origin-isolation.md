# Cross-origin isolation: COOP same-origin + COEP credentialless

Code: `server/routes.ts` `isolate()` (on every response from `route()`), `client/lib/engine-piper.js` (the
consumer), `client/lib/generate.js` (the call sites the choice touched).

## Why

`engine-piper.js` pins `ort.env.wasm.numThreads` to 1 unless `crossOriginIsolated && SharedArrayBuffer`. Without
COOP/COEP headers both are false, and Piper inference ran single-threaded on every machine whatever its core
count; the client's console said so ("SINGLE-THREADED — isolation headers missing").

The headers ride on **every** response, not just the document: a worker script served without them isn't
isolated and the whole context degrades. Two exceptions, both in `isolate()`: a successful `/ws` upgrade returns no
Response (Bun owns the socket; touching it would throw on every connection), and a 101 owns its own handshake.

## Why `credentialless`, not `require-corp`

`require-corp` blocks any cross-origin no-cors subresource that doesn't opt in with a CORP header, which would
break third-party assets the moment someone adds one. `credentialless` gives the same isolation by stripping
credentials from no-cors cross-origin requests instead of refusing them.

## The cross-origin call-site audit

The client does load cross-origin things; each was checked against the choice:

- **Orrery API**, `fetch(…, {credentials: 'include'})` (`generate.js`): unaffected. COEP governs no-cors
  subresources; a cors-mode fetch isn't one.
- **Orrery thumbnails** via `<img>`: affected. A bare `<img>` is no-cors, so credentialless strips the session
  cookie from a private thumbnail. Fixed at the call site with `crossorigin="use-credentials"`, moving it to cors
  mode.
- **Orrery OAuth popup**: COOP `same-origin` severs `window.opener`, so the popup can't `postMessage` back and sign-in
  hung. `generate.js` polls `/api/auth/me` as the primary signal; a message only speeds the poll up.
- **World sounds and pictures from links** are fetched cors-mode first (`crossOrigin = 'anonymous'`); a sound whose
  host sends no CORS headers falls back to a plain element, which under credentialless loads without credentials
  (`docs/research/sound-realizer.md`).
- **The DRACO decoder** is served same-origin (`/node_modules/three/examples/jsm/libs/draco/gltf/`, `assets.js`),
  so isolation doesn't touch it.

Any new cross-origin subresource needs the same check: cors mode, or no-cors and fine without credentials.

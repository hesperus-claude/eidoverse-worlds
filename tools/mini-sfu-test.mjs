// MINIMAL werift↔Chromium: does a browser answer sendonly to a server's recvonly m-line when it has a track?
import { chromium } from 'playwright';
import { RTCPeerConnection } from 'werift';
const server = new RTCPeerConnection({});
// THE REAL SHAPE: sendonly ROUTES (one per consented speaker) PLUS the recvonly floor for the listener's mic, added LAST as sfuadapter does
const { MediaStreamTrack, MediaStream } = await import('werift');
for (const speaker of ['spkA','spkB']) {
  const t = new MediaStreamTrack({ kind: 'audio' });
  server.addTransceiver(t, { direction: 'sendonly', streams: [new MediaStream({ id: speaker, tracks: [t] })] });
}
server.addTransceiver('audio', { direction: 'recvonly' });
let fired = false;
server.onTrack.subscribe(() => { fired = true; console.log('  🔔 SERVER ontrack FIRED'); });
const offer = await server.createOffer();
await server.setLocalDescription(offer);

// portable: Playwright's managed browser by default; SFU_TEST_CHROME overrides it
const b = await chromium.launch({ ...(process.env.SFU_TEST_CHROME ? { executablePath: process.env.SFU_TEST_CHROME } : {}),
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
const pg = await (await b.newContext({permissions:['microphone']})).newPage();
// getUserMedia needs a secure-context origin, and it must be OURS: a one-page server owned by the test
const { createServer } = await import('node:http');
const pageSrv = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>mini-sfu</title>'); });
await new Promise((r) => pageSrv.listen(0, '127.0.0.1', r));
await pg.goto(`http://127.0.0.1:${pageSrv.address().port}/`);
// THE REAL SEQUENCE: answer FIRST with no mic (as at join), then acquire the mic and answer the SAME offer again
const out = await pg.evaluate(async (offerSdp) => {
  const pc = new RTCPeerConnection({});
  const r = {};
  await pc.setRemoteDescription({type:'offer', sdp: offerSdp});
  let a = await pc.createAnswer(); await pc.setLocalDescription(a);
  r.first = (a.sdp.match(/a=(sendonly|recvonly|sendrecv|inactive)/g)||[]).join(',');
  // the mic shows up, as when a user clicks the button
  const s = await navigator.mediaDevices.getUserMedia({audio:true});
  // the fix under test: bind the mic to the transceiver the SERVER offered for it (remote recvonly); addTrack picks the
  // first compatible one, a speaker route, and the floor never gets the track
  const floor = pc.getTransceivers().find(t => t.currentDirection === 'inactive' || t.direction === 'inactive');
  if (floor) { await floor.sender.replaceTrack(s.getTracks()[0]); floor.direction = 'sendonly'; }
  else { for (const t of s.getTracks()) pc.addTrack(t, s); }
  // the server re-offers the SAME sdp (no new transceivers)
  await pc.setRemoteDescription({type:'offer', sdp: offerSdp});
  a = await pc.createAnswer(); await pc.setLocalDescription(a);
  r.second = (a.sdp.match(/a=(sendonly|recvonly|sendrecv|inactive)/g)||[]).join(',');
  r.trx = pc.getTransceivers().map(t=>`${t.direction}${t.sender?.track?'+track':''}`).join(',');

  // ── STAGE 3: SWAP THE SOURCE ON AN ALREADY-PUBLISHED PC. The floor is sendonly now, so a hunt knowing only 'inactive'
  // falls to addTrack, and an answer can't add an m-line: the new sender never enters the SDP.
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();  // a synthetic "TTS" track
  const synthTrack = dest.stream.getAudioTracks()[0];
  // the OLD hunt, verbatim: proves the failure shape
  {
    const floor = pc.getTransceivers().find(t => t.currentDirection === 'inactive' || t.direction === 'inactive');
    if (floor) { await floor.sender.replaceTrack(synthTrack); floor.direction = 'sendonly'; }
    else { pc.addTrack(synthTrack, dest.stream); }
  }
  // addTrack HIJACKS a recvonly route transceiver (its empty sender is "compatible"), whose answer can only say recvonly,
  // so the synth track sits on a sender that never transmits
  r.oldHuntTrx = pc.getTransceivers().length;
  r.oldHuntPutSynthOnRecvRoute = pc.getTransceivers()
    .some(t => t.sender?.track === synthTrack && t.direction !== 'sendonly');
  r.oldHuntOwnedSenderHasSynth = pc.getTransceivers()
    .some(t => t.direction === 'sendonly' && t.sender?.track === synthTrack);
  // the fixed hunt, in sync with voicesfu.js: the NEGOTIATED direction is the authority, the ask counts only
  // pre-negotiation; currentDirection === 'recvonly' excludes a recv-associated sendrecv
  {
    const mine = pc.getTransceivers().find(t =>
      t.currentDirection === 'sendonly'
      || (t.currentDirection == null && (t.direction === 'sendonly' || t.direction === 'sendrecv')));
    if (mine) await mine.sender.replaceTrack(synthTrack);
  }
  r.ownedSenderCarriesSynth = pc.getTransceivers()
    .some(t => t.currentDirection === 'sendonly' && t.sender?.track === synthTrack);
  // control: a transceiver whose ASK is sendrecv but NEGOTIATED answer recvonly (JSEP associated it with our addTrack)
  // must be invisible to the hunt
  r.recvAssociatedExcluded = !pc.getTransceivers().some(t =>
    t.currentDirection === 'recvonly' && t.direction === 'sendrecv'
    && (t.currentDirection === 'sendonly'
        || (t.currentDirection == null && (t.direction === 'sendonly' || t.direction === 'sendrecv'))));
  return r;
}, server.localDescription.sdp);
console.log('  FIRST answer (no mic yet):', out.first);
console.log('  SECOND answer (mic added):', out.second, '| transceivers:', out.trx);
console.log(out.second.includes('sendonly') ? '  ✅ revives' : '  ❌ STAYS DEAD — a rejected m-line cannot be revived');
const reproduced = out.oldHuntPutSynthOnRecvRoute && !out.oldHuntOwnedSenderHasSynth;
console.log(`  STAGE 3 — old hunt hijacks a recv route: ${reproduced ? `✅ reproduced (synth on a non-sendonly sender, ${out.oldHuntTrx} trx)` : '❌ not reproduced'}`);
console.log(`  STAGE 3 — fixed hunt swaps in place:     ${out.ownedSenderCarriesSynth ? '✅ owned sendonly sender carries the synth track' : '❌'}`);
await b.close();
pageSrv.close();
console.log(`  STAGE 3 — recv-associated sendrecv excluded: ${out.recvAssociatedExcluded ? '✅' : '❌'}`);
process.exit(reproduced && out.ownedSenderCarriesSynth && out.recvAssociatedExcluded ? 0 : 1);

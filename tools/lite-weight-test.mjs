// The claim lite mode rests on: a lite boot must never REQUEST the engine. Decided in index.html ahead of the module
// graph (a runtime branch in main.js still pays the download), so this is a network ledger against an owned server.
// Recipe: `node tools/lite-weight-test.mjs` (BUN_PATH=<abs bun.exe> on Windows: playwright's launch hangs under bun there).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const ENGINE = /three\.webgpu|three\.tsl|three-vrm|three-mesh-bvh/;
const { check, done } = checker();
// every world this test joins is founded (joining never founds one), or the arrival checks pass vacuously
const ARRIVAL = 'arrival';
const world = await ownedWorld({ worlds: [ARRIVAL] });
const { browser, page: mkPage } = await launchBrowser();

async function weigh(query, label) {
  const page = await mkPage();
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${world.origin}/?world=staging&name=liteprobe&key=${world.key}${query}`, { waitUntil: 'load' });
  await page.waitForTimeout(6000);  // generous: preloads start at parse, not at load
  const why = await page.evaluate(() => globalThis.__ewLiteWhy ?? null);
  const lite = await page.evaluate(() => globalThis.__ewLite === true);
  const engine = asked.filter((u) => ENGINE.test(u));
  console.log(`\n  ${label}: __ewLite=${lite} why=${why} · ${asked.length} requests, ${engine.length} engine`);
  for (const u of engine.slice(0, 3)) console.log(`      ${u.split('/').pop()}`);
  await page.close();
  return { engine, asked, why, lite, errs };
}

const full = await weigh('', 'full (default)');
check('the full client is not lite', full.lite === false && full.why === 'default');
check('the full client DOES fetch the engine', full.engine.length > 0,
  'if this fails the preloads are broken for everyone, not just lite');

const lite = await weigh('&lite=1', 'lite (?lite=1)');
check('?lite=1 is decided as lite', lite.lite === true && lite.why === 'url');
check('a lite boot requests ZERO engine bytes', lite.engine.length === 0,
  `still asked for: ${lite.engine.map((u) => u.split('/').pop()).join(', ')}`);
check('a lite boot is dramatically lighter overall',
  lite.asked.length < full.asked.length,
  `lite ${lite.asked.length} vs full ${full.asked.length} requests`);

// a lite client must also boot: the splash is static markup only boot.js takes down, so a cleared splash proves lite.js
// ran, connected, and called finishBoot
{
  const page = await mkPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${world.origin}/?world=staging&name=liteprobe&key=${world.key}&lite=1`, { waitUntil: 'load' });
  const cleared = await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).then(() => true).catch(() => false);
  const chat = await page.evaluate(() => !!document.querySelector('.chat-cols, #chat, [data-frame="chat"]'));
  const canvas = await page.evaluate(() => document.querySelectorAll('canvas:not(.sp-rays)').length);
  console.log(`\n  lite boot: splash cleared=${cleared} chat=${chat} non-splash canvases=${canvas} errors=${errs.length}`);
  for (const e of errs.slice(0, 3)) console.log(`      ! ${e}`);
  check('a lite client actually finishes booting (splash clears)', cleared,
    'lite.js calls initBoot/markPhase/finishBoot — if this hangs, one of them is missing');
  check('a lite boot raises no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  check('a lite client renders NO world canvas', canvas === 0);
  await page.close();
}

// realize/livechat.js turns a 'say' entry into a chat line, and lite.js must subscribe (replay alone is past tense)
{
  const page = await mkPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${world.origin}/?world=staging&name=echoprobe&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).catch(() => {});
  const MSG = `echo-probe-${Date.now()}`;
  const typed = await page.evaluate(async (text) => {
    const input = document.getElementById('chatline');
    if (!input) return 'no #chatline';
    input.focus();
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  }, MSG);
  const appeared = await page.waitForFunction(
    (t) => document.body.innerText.includes(t), MSG, { timeout: 12000 },
  ).then(() => true).catch(() => false);
  console.log(`\n  chat echo: input=${typed} own message rendered live=${appeared} errors=${errs.length}`);
  for (const e of errs.slice(0, 2)) console.log(`      ! ${e}`);
  check('a lite client SEES ITS OWN message without reloading', appeared,
    'initCauses() subscribes the live say->chat path; without it chat only works in the past tense');
  await page.close();
}

// the socket observed from INSIDE the page (Playwright's `framesent` missed frames, #188): WebSocket.prototype.send is
// patched before any app script, the same object the client calls
const SOCKET_SPY = `
  globalThis.__frames = { sent: [], opened: 0 };
  const _send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try { globalThis.__frames.sent.push(String(data)); } catch (e) {}
    return _send.call(this, data);
  };
  const _WS = WebSocket;
  globalThis.WebSocket = new Proxy(_WS, {
    construct(t, a) { globalThis.__frames.opened++; return new t(...a); },
  });
`;
const framesOf = (page) => page.evaluate(() => globalThis.__frames ?? { sent: [], opened: 0 });

// one arrival, one socket generation: net.js adopts the inline early socket only when its join matches byte for byte;
// a mismatch opens a second (arrive → leave → arrive) and can discard what the first delivered
{
  const page = await mkPage();
  await page.addInitScript(SOCKET_SPY);
  await page.goto(`${world.origin}/?world=staging&name=litejoin&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).catch(() => {});
  await page.waitForTimeout(2500);
  const f = await framesOf(page);
  const joins = f.sent.filter((x) => x.includes('"type":"join"'));
  const avatars = joins.map((j) => { try { return JSON.parse(j).avatar; } catch { return '?'; } });
  console.log(`\n  join lifecycle: sockets=${f.opened} joins=${joins.length} avatars=${JSON.stringify(avatars)}`);
  check('a lite client opens ONE socket generation', f.opened <= 1,
    `opened ${f.opened}; the early socket must be adopted, not replaced`);
  check('a lite client sends exactly ONE join', joins.length === 1,
    `sent ${joins.length}: ${JSON.stringify(avatars)}`);
  check('lite joins with the avatar the early socket used, not an empty one',
    avatars.length > 0 && avatars.every((a) => a && a !== ''),
    'avatar:"" is what made net.js reject the early socket');
  await page.close();
}

// a gesture carries the remembered body UNCHANGED and adds only the one-shot (specimen: a seated, pitched, wing-folded
// resident holding a custom pose)
{
  const page = await mkPage();
  await page.addInitScript(SOCKET_SPY);
  const STORED = { p: [2, 0, 3], yaw: 1.2, clip: 'sit', pitch: 0.1, wingsFolded: true, pose: { head: [0, 0, 0, 1] } };

  // the body as the FULL client would leave it, so the server remembers it
  await page.goto(`${world.origin}/?world=staging&name=bodykeep&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__ewLite === true, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  // the server calls rememberPose on disconnect (server.ts), so the next join under the id gets it back as `restore`
  await page.evaluate(async (pose) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    await new Promise((res) => { sock.onopen = res; });
    const q = new URLSearchParams(location.search);
    sock.send(JSON.stringify({ type: 'join', world: q.get('world'), id: q.get('name'),
      avatar: globalThis.__ewWantAvatar ?? 'claude', spectate: false, renderer: false, token: q.get('key'), replica: true }));
    await new Promise((res) => setTimeout(res, 1200));
    sock.send(JSON.stringify({ type: 'pose', pose }));
    await new Promise((res) => setTimeout(res, 800));
    sock.close();
  }, STORED);
  await page.waitForTimeout(1200);

  // arrive in lite under that identity and tap one gesture
  await page.goto(`${world.origin}/?world=staging&name=bodykeep&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('.lite-action').length > 0, { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  const tapped = await page.evaluate(() => {
    const b = document.querySelector('.lite-action');
    if (!b) return null;
    b.click();
    return b.dataset.anim;
  });
  await page.waitForTimeout(1500);
  const f2 = await framesOf(page);
  const poses = f2.sent.filter((x) => x.includes('"type":"pose"') && x.includes('"anim"'));
  let sentPose = null;
  try { sentPose = JSON.parse(poses[poses.length - 1]).pose; } catch { /* none */ }
  console.log(`\n  gesture: tapped=${tapped} pose-frames=${poses.length}`);
  if (sentPose) console.log(`      ${JSON.stringify(sentPose).slice(0, 190)}`);

  check('a gesture button exists to tap', !!tapped);
  check('a gesture leaves as a presence pose, not a verb', !!sentPose,
    'there is no gesture verb; it rides pose.anim and needs a finite p');
  if (sentPose) {
    check('the gesture itself rides along', sentPose.anim === tapped);
    check('a seated resident stays seated', sentPose.clip === STORED.clip,
      `clip=${sentPose.clip} (stored ${STORED.clip})`);
    check('pitch survives the gesture', sentPose.pitch === STORED.pitch,
      `pitch=${sentPose.pitch} (stored ${STORED.pitch})`);
    check('folded wings stay folded', sentPose.wingsFolded === true,
      `wingsFolded=${sentPose.wingsFolded}`);
    check('a held pose is not dropped', JSON.stringify(sentPose.pose) === JSON.stringify(STORED.pose),
      `pose=${JSON.stringify(sentPose.pose)}`);
    check('position and facing survive', JSON.stringify(sentPose.p) === JSON.stringify(STORED.p)
      && sentPose.yaw === STORED.yaw, `p=${JSON.stringify(sentPose.p)} yaw=${sentPose.yaw}`);
  }
  await page.close();
}

// ARRIVAL DELIVERY: connect() adopts the early socket and drains what raced ahead before a chat window may exist; the
// drain must not throw, and with arrival-only speech earlier says must NOT appear. `raw` is a second participant.
const RAW = `
  globalThis.__raw = async (msgs, { id, wait = 900 }) => {
    const q = new URLSearchParams(location.search);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(proto + '://' + location.host + '/ws');
    await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
    sock.send(JSON.stringify({ type: 'join', world: q.get('world'), id,
      avatar: 'claude', spectate: false, renderer: false, token: q.get('key'), replica: true }));
    await new Promise((res) => setTimeout(res, wait));
    for (const m of msgs) { sock.send(JSON.stringify(m)); await new Promise((res) => setTimeout(res, 250)); }
    await new Promise((res) => setTimeout(res, wait));
    sock.close();
    await new Promise((res) => setTimeout(res, 400));
    return true;
  };
`;

{
  const WORLD = ARRIVAL;
  const READER = 'reader';
  const SECRET = `removed-whisper-${Date.now()}`;
  const PRIOR = `prior-say-${Date.now()}`;

  // a page that is NOT the reader, only to drive the other participant
  const driver = await mkPage();
  await driver.addInitScript(RAW);
  await driver.goto(`${world.origin}/?world=${WORLD}&name=driver&key=${world.key}&lite=1&earlysock=0`,
    { waitUntil: 'load' });
  await driver.waitForTimeout(1500);

  // one ordinary say before the reader arrives, then a whisper while it's away (refused as removed: held for nobody)
  await driver.evaluate(async ({ secret, prior, reader }) => {
    await globalThis.__raw([
      { type: 'request', id: 'prior-say', verb: 'say', args: { text: prior } },
      { type: 'whisper', to: reader, text: secret },
    ], { id: 'sender' });
  }, { secret: SECRET, prior: PRIOR, reader: READER });
  await driver.close();

  // the reader arrives, in lite, for the first time
  const page = await mkPage();
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const consoleErrs = [];
  page.on('console', (m) => { if (/TypeError|Cannot read prop|net whisper/i.test(m.text())) consoleErrs.push(m.text()); });

  await page.goto(`${world.origin}/?world=${WORLD}&name=${READER}&key=${world.key}&lite=1`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 25000 },
  ).catch(() => {});
  await page.waitForTimeout(3000);

  // the positive control: a line said AFTER arrival reaches it, so the absences below mean something
  const AFTER = `after-say-${Date.now()}`;
  const driver2 = await mkPage();
  await driver2.addInitScript(RAW);
  await driver2.goto(`${world.origin}/?world=${WORLD}&name=driver2&key=${world.key}&lite=1&earlysock=0`, { waitUntil: 'load' });
  await driver2.evaluate(async ({ after }) => {
    await globalThis.__raw([{ type: 'request', id: 'after-say', verb: 'say', args: { text: after } }], { id: 'sender2' });
  }, { after: AFTER });
  await driver2.close();
  await page.waitForFunction((t) => document.body.innerText.includes(t), AFTER, { timeout: 8000 }).catch(() => {});

  const body = await page.evaluate(() => document.body.innerText);
  const countOf = (hay, needle) => hay.split(needle).length - 1;
  const whisperHits = countOf(body, SECRET);
  const priorHits = countOf(body, PRIOR);
  const engine = asked.filter((u) => ENGINE.test(u)).length;

  console.log(`\n  arrival delivery: removed-whisper x${whisperHits}  prior-say x${priorHits}  engine=${engine}  pageErrors=${errs.length}  drainErrors=${consoleErrs.length}`);
  for (const e of consoleErrs.slice(0, 2)) console.log(`      ! ${e.slice(0, 140)}`);

  check('the control: a line said after the reader arrived reaches it', countOf(body, AFTER) > 0, `seen ${countOf(body, AFTER)}x`);
  check('a whisper sent while the reader was away never arrives (whisper removed, R 10-18)', whisperHits === 0, `seen ${whisperHits}x`);
  check('chat said before the reader arrived is not replayed (arrival-only, R 10-18)', priorHits === 0, `seen ${priorHits}x`);
  check('nothing throws inside the drain', consoleErrs.length === 0, consoleErrs[0]?.slice(0, 120));
  check('arrival delivery raises no page errors', errs.length === 0, errs[0]?.slice(0, 120));
  check('none of this costs engine bytes', engine === 0);
  await page.close();
}

// a first-time visitor to a key-gated world gets in from lite: close 4003 → `bad-key`; the full client's openDoor lives
// in ui.js with the engine, so lite has its own door that fetches no engine bytes
{
  const page = await mkPage();
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  // a first-time visitor remembers nothing
  await page.addInitScript(() => { try { localStorage.removeItem('ew-key'); } catch (e) {} });

  await page.goto(`${world.origin}/?world=staging&name=doorprobe&lite=1`, { waitUntil: 'load' });
  const doorShown = await page.waitForSelector('#lite-door', { timeout: 20000 })
    .then(() => true).catch(() => false);
  const engineBeforeKey = asked.filter((u) => ENGINE.test(u)).length;
  console.log(`\n  key door: shown=${doorShown} engine-requests-so-far=${engineBeforeKey}`);
  check('a key-gated lite visitor gets a key door', doorShown,
    'without it the only escape is the full client, which is what kills the device');
  check('the key door costs no engine bytes', engineBeforeKey === 0);

  if (doorShown) {
    await page.fill('#lite-door .lite-door-key', world.key);
    await page.click('#lite-door .lite-door-go');
    const joined = await page.waitForFunction(
      () => !document.getElementById('lite-door') && !!document.getElementById('chatline'),
      { timeout: 20000 },
    ).then(() => true).catch(() => false);
    const engineAfter = asked.filter((u) => ENGINE.test(u)).length;
    console.log(`  key door: entered key -> joined=${joined} engine-requests-total=${engineAfter} errors=${errs.length}`);
    for (const e of errs.slice(0, 2)) console.log(`      ! ${e}`);
    check('a correct key lets a lite visitor in', joined,
      'setToken + connect() should close the door and leave a usable chat');
    check('recovering through the key door still loads no engine', engineAfter === 0);
    check('the key door raises no page errors', errs.length === 0, errs.slice(0, 1).join(''));
  }
  await page.close();
}

// the tripwire (arming, clean exit, per-world keys): tools/lite-choice-test.mjs, over the page's own script
const back = await weigh('&lite=0', 'escape hatch (?lite=0)');
check('?lite=0 forces the full client back', back.lite === false && back.why === 'url');
check('?lite=0 fetches the engine again', back.engine.length > 0);

// the full client still plays a gesture (a re-export without a local binding threw in playOnce);
// tools/reexport-binding-test.mjs catches the class, this the behaviour
{
  const page = await mkPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const toasts = [];
  page.on('console', (m) => { if (/is not defined|ReferenceError/i.test(m.text())) toasts.push(m.text()); });
  await page.goto(`${world.origin}/?world=staging&name=onceplay&key=${world.key}&lite=0`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { const el = document.getElementById('splash'); return !el || el.classList.contains('gone'); },
    { timeout: 60000 },
  ).catch(() => {});
  const tile = await page.waitForSelector('[data-anim]', { timeout: 20000 }).catch(() => null);
  let played = null;
  if (tile) {
    played = await page.evaluate(() => {
      const t = document.querySelector('[data-anim]');
      t.click();
      return t.dataset.anim;
    });
    await page.waitForTimeout(2000);
  }
  const refErrs = [...errs, ...toasts].filter((e) => /is not defined|ReferenceError/i.test(e));
  console.log(`\n  full client gesture: tile=${played} referenceErrors=${refErrs.length}`);
  for (const e of refErrs.slice(0, 2)) console.log(`      ! ${e.slice(0, 140)}`);
  check('the full client still has an action tile to press', !!played);
  check('pressing it raises no ReferenceError', refErrs.length === 0, refErrs[0]?.slice(0, 120));
  await page.close();
}

await browser.close();
await world.close();
done();

// Real screenshots for the README and the site: a demo hub, two people asking agents things,
// then headless Chrome over the DevTools protocol.  node scripts/screenshots.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { HubClient } from '../src/shared/sync.js';
import { findBlock, encodeRel, snapshot } from '../src/shared/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs', 'images'));
const PORT = 4410;
const CDP = 9333;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-shots-'));
fs.mkdirSync(out, { recursive: true });

const hub = spawn(process.execPath, [path.join(root, 'bin', 'margin.js'), 'serve', '--port', String(PORT)], { env: { ...process.env, MARGIN_HOME: home }, stdio: 'ignore' });
for (let i = 0; i < 40; i++) {
  await sleep(250);
  if (await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false)) break;
}
const [space] = await fetch(`http://localhost:${PORT}/api/spaces`).then((r) => r.json());

// People asking agents for help, anchored to exact words.
async function person(name, color) {
  const c = new HubClient({ url: `ws://localhost:${PORT}/ws`, WebSocketImpl: WebSocket, user: { id: 'u-' + name, name, color }, spaceId: space.id });
  await new Promise((r) => c.spaceListeners.add(r));
  return c;
}
const maya = await person('Maya', '#d9480f');
const jon = await person('Jon', '#1971c2');
const docId = maya.space.docs[0].id;
const d = maya.openDoc(docId);
await new Promise((r) => (d.synced ? r() : d.on('synced', r)));
const blocks = snapshot(d.ydoc);
async function ask(c, find, quote, text) {
  const b = blocks.find((x) => x.text.includes(find));
  const yt = findBlock(d.ydoc, b.id).block.get('text');
  const i = b.text.indexOf(quote);
  await c.rpc('thread.create', { docId, blockId: b.id, start: encodeRel(yt, i), end: encodeRel(yt, i + quote.length, -1), quote, text });
}
await ask(maya, 'drowning', 'Research teams are basically drowning in scattered notes.', '@Editor can you tighten this paragraph? It reads like a pitch.');
await ask(jon, '73%', '73% of lab time', '@Fact-Checker where does this number come from?');
await ask(maya, '500 teams', 'we will just announce on our blog', '@Skeptic is this enough to reach 500 teams?');
await sleep(9000); // the computer wakes the sim agents; they reply and propose

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(home, 'chrome')}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  target = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let seq = 0;
const waiting = new Map();
ws.on('message', (m) => {
  const msg = JSON.parse(m.toString());
  if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)(msg), waiting.delete(msg.id);
});
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.result?.value);

async function shot(name, { width, height, scale = 2, setup } = {}) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 700 });
  await cdp('Page.navigate', { url: `http://localhost:${PORT}/?as=Lena` });
  await sleep(2500);
  if (setup) console.log('setup:', await evalJs(setup)), await sleep(600);
  const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name), Buffer.from(result.data, 'base64'));
  console.log('wrote', path.join(out, name));
}

await cdp('Page.enable');
await cdp('Runtime.enable');
const openFirstThread = `(async () => { await new Promise((r) => setTimeout(r, 1500)); const g = document.querySelector('.mcard.group'); if (g) g.click(), await new Promise((r) => setTimeout(r, 600)); const t = document.querySelector('.mcard:not(.group)'); t && t.click(); await new Promise((r) => setTimeout(r, 900)); return !!document.querySelector('.mcard.active'); })()`;
await shot('app.png', { width: 1440, height: 900, setup: openFirstThread });

ws.close();
chrome.kill();
maya.close();
jon.close();
hub.kill();
await sleep(300);
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);

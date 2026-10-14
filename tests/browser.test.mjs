// End-to-end test: drives the real game in headless Chromium over CDP.
//   node tests/browser.test.mjs "file://$PWD/iq-reasoning.html" "$PWD"
// Point CHROME=/path/to/chrome at another build if this one will not start.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const FILE = process.argv[2];
const OUT = process.argv[3] || '.';
const PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIN = process.env.CHROME || ['/snap/chromium/current/usr/lib/chromium-browser/chrome',
  '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .find(existsSync) || 'chromium';
try { execSync('pkill -f "[c]hrome --headless" '); } catch (_) { /* none */ }
const chrome = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--user-data-dir=/tmp/cp2', `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

let ws; const pending = new Map(); let seq = 0; const problems = [];
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch (_) { await sleep(300); continue; }
  break;
}
if (!ws) { console.error('no CDP\n' + chromeErr.slice(0, 500)); process.exit(1); }
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
  else if (msg.method === 'Runtime.exceptionThrown') problems.push('JS: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push('console: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}`, Buffer.from(s.data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${FILE}?seed=424242` });
await sleep(1400);
// start from a clean slate so "default difficulty" is deterministic across runs
await ev(`try { localStorage.removeItem('abstract.difficulty'); } catch (_) {}`);
await send('Page.navigate', { url: `${FILE}?seed=424242` });
await sleep(1200);

const results = [];
const check = (l, p, e = '') => results.push({ l, p, e });

// page boots, overlay explains the game
check('page boots with engine exposed', await ev('!!window.IQ && !!window.__IQ_TEST'));
check('start overlay visible before begin', await ev('!document.getElementById("overlay").hidden'));
await ev(`document.getElementById('ov-btn').click()`);
await sleep(500);
check('begin hides overlay and renders a board', await ev(`document.getElementById('overlay').hidden && document.querySelectorAll('#tile-layer .tile').length >= 4`),
  await ev(`document.querySelectorAll('#tile-layer .tile').length + ' tiles, ' + document.querySelectorAll('.glyph').length + ' glyphs'`));

// in-page helpers: drag a tile onto the slot, and read game state
await ev(`window.__T = {
  state: () => {
    const v = window.__IQ_TEST.view, r = window.__IQ_TEST.run();
    return {
      family: v.puzzle && v.puzzle.family, solved: v.solved, score: r.score, wrong: r.wrong,
      level: r.level, index: r.index, hud: document.getElementById('hud-score').textContent,
      status: document.getElementById('status').textContent.trim(),
      nextVisible: !document.getElementById('btn-next').hidden,
      tiles: document.querySelectorAll('#tile-layer .tile').length,
      glyphs: document.querySelectorAll('.glyph').length,
      filled: document.querySelectorAll('.panel.filled').length,
    };
  },
  fire(el, type, c) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: c.x, clientY: c.y,
      pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  },
  center(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
  async drag(idOrEl, targetEl, steps = 12) {
    const v = window.__IQ_TEST.view;
    const el = typeof idOrEl === 'string' ? v.tileEls.get(idOrEl) : idOrEl;
    const from = this.center(el);
    const to = this.center(targetEl);
    this.fire(el, 'pointerdown', from);
    for (let i = 1; i <= steps; i++) {
      this.fire(el, 'pointermove', { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps });
      await new Promise((r) => setTimeout(r, 12));
    }
    this.fire(el, 'pointerup', to);
    await new Promise((r) => setTimeout(r, 480));
  },
  slot: () => window.__IQ_TEST.view.slotEl,
  answerEl: () => window.__IQ_TEST.view.tileEls.get(window.__IQ_TEST.view.puzzle.answerId),
  wrongEl: () => { const v = window.__IQ_TEST.view; const t = v.puzzle.tiles.find((x) => x.id !== v.puzzle.answerId); return v.tileEls.get(t.id); },
}`);

// wrong answer must be rejected, penalised, and snapped back
const beforeWrong = await ev('__T.state()');
await ev('__T.drag(__T.wrongEl(), __T.slot())');
const afterWrong = await ev('__T.state()');
check('wrong tile rejected with feedback', afterWrong.wrong === beforeWrong.wrong + 1 && !afterWrong.solved && /No —/.test(afterWrong.status),
  afterWrong.status);
check('score untouched by a wrong answer', afterWrong.score === beforeWrong.score, `${beforeWrong.score} → ${afterWrong.score}`);
const back = await ev(`(() => { const v = window.__IQ_TEST.view; const t = v.puzzle.tiles.find((x) => x.id !== v.puzzle.answerId); const el = v.tileEls.get(t.id); const h = v.homes.get(t.id); const r = el.getBoundingClientRect(); const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; const m = document.getElementById('board').getScreenCTM(); const p = new DOMPoint(c.x, c.y).matrixTransform(m.inverse()); return Math.round(Math.hypot(p.x - h.x, p.y - h.y)); })()`);
check('wrong tile returns to its tray slot', back <= 3, `Δ=${back} user units`);

// solve the whole run by dragging the correct tile every time
const seenFamilies = new Set();
let firstShot = false, analogyShot = false, oddShot = false;
for (let n = 0; n < 24; n++) {
  const st = await ev('__T.state()');
  if (!st.family) break;
  seenFamilies.add(st.family);
  if (st.family === 'matrix' && !firstShot) { await shot('iq-matrix.png'); firstShot = true; }
  if (st.family === 'analogy' && !analogyShot) { await shot('iq-analogy.png'); analogyShot = true; }
  if (st.family === 'odd' && !oddShot) { await shot('iq-odd.png'); oddShot = true; }
  const scoreBefore = st.score;
  await ev('__T.drag(__T.answerEl(), __T.slot())');
  const solved = await ev('__T.state()');
  if (!solved.solved) { check(`puzzle ${n} (${st.family}) solvable by drag`, false, JSON.stringify(solved)); break; }
  if (solved.score <= scoreBefore) { check(`puzzle ${n} awards points`, false, `${scoreBefore} → ${solved.score}`); break; }
  if (solved.filled !== 1) { check(`puzzle ${n} fills the slot`, false, String(solved.filled)); break; }
  await ev(`document.getElementById('btn-next').click()`);
  await sleep(280);
}
const endState = await ev('__T.state()');
check('all 24 puzzles playable end-to-end', endState.level === 8 && endState.index === 2 && endState.nextVisible,
  JSON.stringify(endState).slice(0, 160));
check('all three families appeared', seenFamilies.size === 3, [...seenFamilies].join(','));
const hudScore = await ev(`document.getElementById('hud-score').textContent`);
check('HUD score tracks internal score', hudScore === String(endState.score), `${hudScore} vs ${endState.score}`);
check('first-try scoring is generous', endState.score > 2000, `score=${endState.score}`);

// finishing shows the verdict card
await ev(`document.getElementById('btn-next').click()`);
await sleep(400);
const fin = await ev(`({ overlay: !document.getElementById('overlay').hidden, title: document.getElementById('ov-title').textContent, stats: document.getElementById('ov-stats').textContent.replace(/\\s+/g,' ').trim() })`);
check('finish shows verdict + stats card', fin.overlay && fin.title === 'Run complete' && /Score/.test(fin.stats), `${fin.title}: ${fin.stats}`);
await shot('iq-result.png');

// hint + skip paths
await ev(`document.getElementById('ov-btn').click()`);
await sleep(350);
await ev(`document.getElementById('btn-hint').click()`);
const hinted = await ev(`({ hints: document.querySelectorAll('.hint-list li').length, text: (document.querySelector('.hint-list li')||{}).textContent || '' })`);
check('hint reveals exactly one rule', hinted.hints === 1 && hinted.text.length > 12, hinted.text.slice(0, 70));
const sBeforeSkip = (await ev('__T.state()')).score;
await ev(`document.getElementById('btn-skip').click()`);
const skipped = await ev('__T.state()');
check('reveal & skip shows the answer without points', skipped.solved && skipped.score === sBeforeSkip && skipped.filled === 1);

// difficulty settings: selector, hint gating, and a real effect on generation
await ev(`document.getElementById('btn-restart').click()`);
await sleep(350);
const seg = await ev(`[...document.querySelectorAll('#difficulty button')].map(b => ({ label: b.textContent, on: b.getAttribute('aria-checked') === 'true' }))`);
check('difficulty selector offers all six settings', seg.length === 6, seg.map((s) => s.label).join(','));
check('standard is the default selection', seg.some((s) => s.label === 'Standard' && s.on), JSON.stringify(seg));

await ev(`document.querySelector('#difficulty button.nightmare').click()`);
await sleep(350);
const night = await ev(`({ diff: window.__IQ_TEST.run().difficulty, attrs: window.__IQ_TEST.view.puzzle.attrs.length,
  hint: { text: document.getElementById('btn-hint').textContent, off: document.getElementById('btn-hint').disabled },
  score: window.__IQ_TEST.run().score, chip: document.getElementById('hud-diff').textContent })`);
check('switching difficulty restarts the run at the new setting', night.diff === 'nightmare' && night.score === 0 && night.chip === 'Nightmare', JSON.stringify(night));
check('nightmare disables hints', night.hint.off && night.hint.text === 'Hints off', JSON.stringify(night.hint));
check('nightmare boards use all six attributes', night.attrs === 6, String(night.attrs));
await ev('__T.drag(__T.answerEl(), __T.slot())');
const nightSolved = await ev('__T.state()');
check('nightmare pays more per puzzle than standard', nightSolved.score >= 170, `+${nightSolved.score}`);
const persisted = await ev(`(() => { try { return localStorage.getItem('abstract.difficulty'); } catch (_) { return 'unavailable'; } })()`);
check('difficulty choice is remembered', persisted === 'nightmare' || persisted === 'unavailable', String(persisted));

await ev(`document.querySelector('#difficulty button.warmup').click()`);
await sleep(350);
const warm = await ev(`({ diff: window.__IQ_TEST.run().difficulty, attrs: window.__IQ_TEST.view.puzzle.attrs.length,
  hint: document.getElementById('btn-hint').textContent, score: window.__IQ_TEST.run().score })`);
check('warm-up boards are simpler and hints are free', warm.attrs <= 3 && warm.hint === 'Hint (free)' && warm.diff === 'warmup', JSON.stringify(warm));
await ev(`document.getElementById('btn-hint').click()`);
const hintCost = await ev(`({ score: window.__IQ_TEST.run().score, hints: document.querySelectorAll('.hint-list li').length })`);
check('free hints reveal a rule without a score penalty', hintCost.score === 0 && hintCost.hints === 1, JSON.stringify(hintCost));
// oblivion: the hardest rung — one attempt, no skip, hard countdown
await ev(`document.querySelector('#difficulty button.oblivion').click()`);
await sleep(350);
const ob = await ev(`({ diff: window.__IQ_TEST.run().difficulty, per: document.getElementById('hud-index').textContent,
  attrs: window.__IQ_TEST.view.puzzle.attrs.length, tiles: document.querySelectorAll('#tile-layer .tile').length,
  hint: { off: document.getElementById('btn-hint').disabled, text: document.getElementById('btn-hint').textContent },
  skip: { off: document.getElementById('btn-skip').disabled, title: document.getElementById('btn-skip').title },
  clockHidden: document.getElementById('chip-clock').hidden, clock: document.getElementById('hud-clock').textContent,
  status: document.getElementById('status').textContent.trim() })`);
check('oblivion runs four boards a level and forbids skipping', ob.diff === 'oblivion' && ob.per === '1/4' && ob.skip.off,
  JSON.stringify({ per: ob.per, skip: ob.skip }));
check('oblivion has no hints either', ob.hint.off && ob.hint.text === 'Hints off', JSON.stringify(ob.hint));
check('oblivion shows a per-board countdown and attempt limit', !ob.clockHidden && /^\d:\d\d$/.test(ob.clock) && /75 seconds, one attempt/.test(ob.status), `${ob.clock} — ${ob.status}`);
check('oblivion boards carry six attributes and six tiles', ob.attrs === 6 && ob.tiles === 6, `${ob.attrs} attrs / ${ob.tiles} tiles`);
const beforeFail = await ev('__T.state()');
await ev('__T.drag(__T.wrongEl(), __T.slot())');
const afterFail = await ev('__T.state()');
check('a single wrong tile closes an oblivion board', afterFail.solved && afterFail.score === beforeFail.score && afterFail.nextVisible && /attempt/.test(afterFail.status),
  afterFail.status);
check('the closed board reveals the answer and the hidden rules', afterFail.filled >= 1 && (await ev(`document.getElementById('hints').textContent.includes('The hidden rules were')`)),
  `filled=${afterFail.filled}`);
await ev(`document.getElementById('btn-next').click()`);
await sleep(300);
const ob2 = await ev(`({ per: document.getElementById('hud-index').textContent, level: window.__IQ_TEST.run().level, solved: window.__IQ_TEST.run().solved })`);
check('next board advances inside the four-board level', ob2.per === '2/4' && ob2.solved === 0, JSON.stringify(ob2));
await ev(`window.__IQ_TEST.run().deadline = Date.now() + 400`);
await sleep(1500);
const expired = await ev('__T.state()');
check('the countdown closes the board when it runs out', expired.solved && /Out of time/.test(expired.status) && expired.nextVisible, expired.status);
const failedCount = await ev(`window.__IQ_TEST.run().failed`);
check('failed boards are counted for the verdict card', failedCount === 2, `failed=${failedCount}`);

await ev(`document.querySelector('#difficulty button[data-diff="standard"]').click()`);
await sleep(250);
check('selector state follows the last choice', await ev(`document.querySelector('#difficulty button[data-diff="standard"]').getAttribute('aria-checked') === 'true'`));

// board geometry sanity
const geo = await ev(`(() => {
  const svg = document.getElementById('board').getBoundingClientRect();
  const out = { tilesOut: 0, panels: document.querySelectorAll('.panel').length, glyphTotal: document.querySelectorAll('.glyph').length };
  document.querySelectorAll('#tile-layer .tile, #display .panel, #slot-layer .panel').forEach((n) => {
    const r = n.getBoundingClientRect();
    if (r.left < svg.left - 1 || r.right > svg.right + 1 || r.top < svg.top - 1 || r.bottom > svg.bottom + 1) out.tilesOut++;
  });
  const labels = [...document.querySelectorAll('.tile')].map((t) => t.getAttribute('aria-label'));
  out.ariaOk = labels.length > 0 && labels.every((l) => /^Tile \\d+: /.test(l));
  return out;
})()`);
check('nothing renders outside the board', geo.tilesOut === 0 && geo.glyphTotal > 0, JSON.stringify(geo));
check('every tile is keyboard-described for screen readers', geo.ariaOk);
check('no JS exceptions or console errors', problems.length === 0, problems.join(' | '));

console.log('\n=== browser end-to-end ===');
for (const r of results) console.log(`${r.p ? 'PASS' : 'FAIL'}  ${r.l}${r.e ? '   [' + r.e + ']' : ''}`);
const failed = results.filter((r) => !r.p).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
chrome.kill();
process.exit(failed ? 1 : 0);

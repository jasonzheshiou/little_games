// Generator invariants: every generated board must have exactly one valid answer.
//   node tests/engine.test.mjs iq-reasoning.html [seeds]
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(process.argv[2] || 'iq-reasoning.html', 'utf8');
const m = /\/\/ \[ENGINE\]([\s\S]*?)\/\/ \[\/ENGINE\]/.exec(html);
if (!m) { console.error('ENGINE block not found'); process.exit(1); }
const sandbox = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, { filename: 'engine.js' });
const IQ = sandbox.IQ;

const ATTRS = ['kind', 'count', 'rot', 'size', 'fill', 'extra'];
const val = (cell, a) => IQ.attrKeys(cell, a);
const diffCount = (a, b) => ATTRS.filter((k) => String(val(a, k)) !== String(val(b, k))).length;

const results = [];
const check = (l, p, e = '') => results.push({ l, p, e });

const SEEDS = Number(process.argv[3] || 250);
let total = 0, fails = [];
const perFamily = { matrix: 0, analogy: 0, odd: 0 };
const stats = { minOptions: 99, maxOptions: 0, totalRules: 0, maxDiffOfWrong: 0 };
const t0 = Date.now();

for (let s = 0; s < SEEDS; s++) {
  const seed = 100000 + s * 7919;
  for (let level = 1; level <= 8; level++) {
    for (let index = 0; index < 3; index++) {
      const p = IQ.generate(level, index, seed);
      const where = `seed ${seed} L${level}.${index + 1}`;
      if (!p) { fails.push(`${where}: generator returned null`); continue; }
      total++;
      perFamily[p.family]++;
      stats.totalRules += p.rules.length;
      stats.minOptions = Math.min(stats.minOptions, p.tiles.length);
      stats.maxOptions = Math.max(stats.maxOptions, p.tiles.length);
      if (!p.prompt || !p.rules.length) fails.push(`${where}: missing prompt/rules`);

      const sigs = p.tiles.map((t) => IQ.signature(t.cell));
      if (new Set(sigs).size !== sigs.length) fails.push(`${where}: tiles are not visually distinct`);

      const answer = p.tiles.find((t) => t.id === p.answerId);
      if (!answer) { fails.push(`${where}: answer tile missing`); continue; }
      const answerSig = IQ.signature(answer.cell);
      const matches = p.tiles.filter((t) => IQ.signature(t.cell) === answerSig).length;
      if (matches !== 1) fails.push(`${where}: ${matches} tiles match the answer (must be 1)`);

      if (p.family === 'matrix') {
        if (IQ.signature(p.grid[2][2]) !== answerSig) fails.push(`${where}: answer is not the matrix cell (2,2)`);
        for (const t of p.tiles) {
          if (t.id === p.answerId) continue;
          const changed = ATTRS.filter((k) => String(val(answer.cell, k)) !== String(val(t.cell, k)));
          const ok = changed.length === 1
            || (changed.includes('kind') && changed.every((k) => k === 'kind' || k === 'rot'));
          if (!ok) fails.push(`${where}: distractor differs in [${changed.join(',')}] (must be one attribute)`);
          stats.maxDiffOfWrong = Math.max(stats.maxDiffOfWrong, changed.length);
        }
        // the 8 visible panels must not all be identical
        const vis = p.grid.flat().filter((_, i) => i !== 8).map((c) => IQ.signature(c));
        if (new Set(vis).size < 2) fails.push(`${where}: visible panels are all identical`);
      }

      if (p.family === 'analogy') {
        const [A, B, C] = p.items;
        const ops = p.rules.map((r) => {
          const text = r.text.replace(/^From A to B \(and C to the answer\): /, '').replace(/\.$/, '');
          const found = ['count', 'rot', 'fill', 'size'].flatMap((a) => IQ.OPS[a]).find((o) => o.text === text);
          return found || null;
        });
        if (ops.some((o) => !o)) fails.push(`${where}: rule text does not map to a known operation`);
        else {
          const apply = (cell) => ops.reduce((c, o) => o.apply(c), cell);
          if (IQ.signature(apply(A)) !== IQ.signature(B)) fails.push(`${where}: B is not A transformed`);
          if (IQ.signature(apply(C)) !== answerSig) fails.push(`${where}: answer is not C transformed`);
        }
        if (IQ.signature(A) === IQ.signature(C)) fails.push(`${where}: A and C identical`);
        if (IQ.signature(C) === answerSig) fails.push(`${where}: C already equals the answer`);
      }

      if (p.family === 'odd') {
        const text = p.rules[0].text.replace('The invariant was: ', '');
        const inv = IQ.INVARIANTS.find((i) => i.text === text);
        if (!inv) fails.push(`${where}: invariant text unknown`);
        else {
          const bad = p.tiles.filter((t) => !inv.test(t.cell));
          if (bad.length !== 1) fails.push(`${where}: ${bad.length} tiles break the invariant (must be 1)`);
          else if (bad[0].id !== p.answerId) fails.push(`${where}: the invariant-breaking tile is not the answer`);
        }
      }
    }
  }
}

const ms = Date.now() - t0;
check(`${total} puzzles generated across ${SEEDS} seeds × 8 levels`, fails.length === 0 && total === SEEDS * 24,
  fails.length ? `\n  ${fails.slice(0, 12).join('\n  ')}${fails.length > 12 ? `\n  …${fails.length} total` : ''}` : '');
check('all three families produced', perFamily.matrix > 0 && perFamily.analogy > 0 && perFamily.odd > 0,
  JSON.stringify(perFamily));
check('option counts in 4..6', stats.minOptions >= 4 && stats.maxOptions <= 6, `${stats.minOptions}..${stats.maxOptions}`);
check('matrix distractors break a single attribute', stats.maxDiffOfWrong <= 2, `max attrs touched = ${stats.maxDiffOfWrong}`);
check('generation is fast enough', ms < SEEDS * 40, `${ms}ms total (${(ms / (SEEDS * 24)).toFixed(2)}ms/puzzle)`);

// determinism: same seed → identical run
const runA = JSON.stringify(IQ.generateRun(424242));
const runB = JSON.stringify(IQ.generateRun(424242));
check('same seed reproduces the same run', runA === runB);
check('different seed changes the run', runA !== JSON.stringify(IQ.generateRun(424243)));
let holes = 0;
for (let s = 0; s < 1000; s++) {
  const run = IQ.generateRun(1 + Math.floor(Math.random() * 999999));
  if (!run.every(Boolean)) holes++;
}
check('no generator holes in 1000 random seeds', holes === 0, `${holes} seeds had a null puzzle`);

console.log('\n=== engine tests ===');
for (const r of results) console.log(`${r.p ? 'PASS' : 'FAIL'}  ${r.l}${r.e ? '   [' + r.e + ']' : ''}`);
const failed = results.filter((r) => !r.p).length;
console.log(`\n${results.length - failed}/${results.length} groups passed`);
process.exit(failed ? 1 : 0);

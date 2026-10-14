# little_games

Two self-contained browser games. No build step, no dependencies, no network — open a file and play.

| Game | File | What it is |
| --- | --- | --- |
| **Shape Match** | [`shape-match.html`](shape-match.html) | Warm-up. Drag coloured shapes into the matching slot. Pointer drag, snap tolerance, keyboard placement, per-round random layout. |
| **Abstract** | [`iq-reasoning.html`](iq-reasoning.html) | Expert pattern reasoning. Every board is generated from a hidden rule set, and every wrong tile breaks exactly one of those rules. |

## Abstract — the hard one

8 levels × 3 puzzles, three families:

- **Matrix rule induction** — up to six attributes (base shape, glyph count, rotation, size, fill style,
  secondary glyph) are each governed by a hidden rule over row and column position.
- **Figural analogy** — A → B by one or two hidden transformations; apply the same to C.
- **Odd one out** — four tiles share an invariant, one breaks it. The invariant is usually arithmetic
  (`sides + glyphs = 7`, `rotation = sides × 15°`), never a colour match.

Scoring punishes hesitation and hints: `base − 25 per wrong tile − 40 per hint + speed bonus`.
Add `?seed=12345` to the URL to replay or share an identical run.

| Level 1–3 (warm-up) | Level 6+ (six interacting attributes) | Odd one out |
| --- | --- | --- |
| ![matrix](iq-matrix.png) | ![analogy](iq-analogy.png) | ![odd](iq-odd.png) |

### Why the puzzles are always fair

The generator never paints a board it cannot defend. For every board it guarantees:

1. exactly one tile satisfies every generated rule (uniqueness by construction),
2. no two tiles in the tray look identical,
3. matrix distractors deviate from the solution in a single attribute,
4. analogy distractors are real transformation mistakes (no change, half a change, double change),
5. in odd-one-out boards exactly one tile violates the stated invariant.

Those invariants are machine-checked: 7 200 generated boards (300 seeds × 24 puzzles) plus a scripted
playthrough of all 24 puzzles in headless Chromium.

## Run the checks

Both games ship with their own verification scripts (Node only, no dependencies):

```sh
# generator invariants — uniqueness, tile distinctness, single-attribute distractors
node tests/engine.test.mjs iq-reasoning.html 300

# scripted playthrough of all 24 puzzles in headless Chromium (CDP), plus screenshots
node tests/browser.test.mjs "file://$PWD/iq-reasoning.html" .
```

The browser test writes `iq-matrix.png`, `iq-analogy.png`, `iq-odd.png` and `iq-result.png` into the
output directory. Point it at another build with `CHROME=/path/to/chrome`.

## Controls

| | Shape Match | Abstract |
| --- | --- | --- |
| Mouse | drag the shape onto the slot | drag a tile onto the dashed slot |
| Keyboard | `Tab` focus, arrows move, `Enter` place | `Tab` select, `Enter` place, `h` hint, `s` reveal & skip, `n` next |

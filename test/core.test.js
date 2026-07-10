// node test/core.test.js  -- exercises cep/client/core.js
const assert = require("assert");
const { bezierYAtX, rankOrder, computeOffsets, spanFromSpacing, PRESETS } =
  require("../cep/client/core.js");

const LINEAR = PRESETS["Linear"];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// bezier basics
assert.strictEqual(bezierYAtX(0, ...LINEAR), 0);
assert.strictEqual(bezierYAtX(1, ...LINEAR), 1);
for (let t = 0; t <= 1.0001; t += 0.05) {
  assert.ok(near(bezierYAtX(t, ...LINEAR), t, 1e-4), `linear curve at ${t}`);
}

// ease-out: rises fast then flattens, so y > x in the middle. Still monotonic.
const EO = PRESETS["Ease Out"];
assert.ok(bezierYAtX(0.5, ...EO) > 0.5);
let prev = -1;
for (let t = 0; t <= 1.0001; t += 0.02) {
  const y = bezierYAtX(t, ...EO);
  assert.ok(y >= prev - 1e-9, "ease-out must be monotonic");
  prev = y;
}

// overshoot preset must actually exceed 1 somewhere
let sawOvershoot = false;
for (let t = 0; t <= 1; t += 0.01) if (bezierYAtX(t, ...PRESETS["Overshoot"]) > 1.0001) sawOvershoot = true;
assert.ok(sawOvershoot, "Overshoot should push y past 1");

// anticipate dips below 0
let sawDip = false;
for (let t = 0; t <= 1; t += 0.01) if (bezierYAtX(t, ...PRESETS["Anticipate"]) < -0.0001) sawDip = true;
assert.ok(sawDip, "Anticipate should push y below 0");

// x control points outside [0,1] get clamped so the curve stays a function
assert.ok(near(bezierYAtX(0.5, -2, 0, 3, 1), bezierYAtX(0.5, 0, 0, 1, 1)));

// spacing
assert.strictEqual(spanFromSpacing("step", 4, 5), 16);
assert.strictEqual(spanFromSpacing("total", 4, 5), 4);

// ordering
assert.deepStrictEqual(rankOrder(4, "topDown"), [0, 1, 2, 3]);
assert.deepStrictEqual(rankOrder(4, "bottomUp"), [3, 2, 1, 0]);
assert.deepStrictEqual(rankOrder(5, "centerOut"), [3, 1, 0, 2, 4]);
assert.deepStrictEqual(rankOrder(5, "edgesIn"), [1, 3, 4, 2, 0]);

// byTime ranks by the supplied times, ties broken by original index
assert.deepStrictEqual(rankOrder(4, "byTime", 1, [30, 0, 20, 10]), [3, 0, 2, 1]);
assert.deepStrictEqual(rankOrder(3, "byTime", 1, [5, 5, 5]), [0, 1, 2], "ties keep original order");
assert.deepStrictEqual(rankOrder(3, "byTime", 1, undefined), [0, 1, 2], "no times => identity");

{
  const a = rankOrder(6, "random", 42);
  assert.deepStrictEqual(a, rankOrder(6, "random", 42), "same seed => same shuffle");
  assert.notDeepStrictEqual(a, rankOrder(6, "random", 43), "different seed => different shuffle");
  assert.deepStrictEqual([...a].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5], "must be a permutation");
}

const base = { curve: LINEAR, order: "topDown", anchor: "first", seed: 1 };

// linear step of 6 over 5 items
assert.deepStrictEqual(
  computeOffsets(5, { ...base, spanFrames: spanFromSpacing("step", 6, 5) }),
  [0, 6, 12, 18, 24]
);

// bottom-up mirrors it
assert.deepStrictEqual(
  computeOffsets(5, { ...base, order: "bottomUp", spanFrames: 24 }),
  [24, 18, 12, 6, 0]
);

// reverse of top-down == bottom-up
assert.deepStrictEqual(
  computeOffsets(5, { ...base, reverse: true, spanFrames: 24 }),
  computeOffsets(5, { ...base, order: "bottomUp", spanFrames: 24 })
);

// byTime: the layer that currently starts earliest goes first
assert.deepStrictEqual(
  computeOffsets(4, { ...base, order: "byTime", times: [30, 0, 20, 10], spanFrames: 30 }),
  [30, 0, 20, 10]
);

// anchors shift the whole set, never its shape
{
  const first = computeOffsets(5, { ...base, spanFrames: 24 });
  const center = computeOffsets(5, { ...base, anchor: "center", spanFrames: 24 });
  const last = computeOffsets(5, { ...base, anchor: "last", spanFrames: 24 });
  assert.deepStrictEqual(center, [-12, -6, 0, 6, 12]);
  assert.deepStrictEqual(last, [-24, -18, -12, -6, 0]);
  for (let i = 1; i < 5; i++) {
    assert.strictEqual(first[i] - first[i - 1], center[i] - center[i - 1]);
    assert.strictEqual(first[i] - first[i - 1], last[i] - last[i - 1]);
  }
}

// ease-in bunches the early items and spreads the late ones
{
  const o = computeOffsets(5, { ...base, curve: PRESETS["Ease In"], spanFrames: 100, snap: false });
  const gaps = [1, 2, 3, 4].map((i) => o[i] - o[i - 1]);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] > gaps[i - 1], "gaps must widen");
}

// snapping
{
  const raw = computeOffsets(3, { ...base, spanFrames: 5, snap: false });
  assert.ok(near(raw[1], 2.5));
  assert.deepStrictEqual(computeOffsets(3, { ...base, spanFrames: 5 }), [0, 3, 5]);
}

// jitter is bounded, seeded, and off by default
{
  const clean = computeOffsets(6, { ...base, spanFrames: 30 });
  assert.deepStrictEqual(clean, computeOffsets(6, { ...base, spanFrames: 30, jitterFrames: 0 }));
  const j = computeOffsets(6, { ...base, spanFrames: 30, jitterFrames: 3, snap: false });
  assert.deepStrictEqual(j, computeOffsets(6, { ...base, spanFrames: 30, jitterFrames: 3, snap: false }));
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(j[i] - clean[i]) <= 3.0001, "jitter within bounds");
}

// degenerate counts must not throw or NaN
assert.deepStrictEqual(computeOffsets(0, { ...base, spanFrames: 10 }), []);
assert.deepStrictEqual(computeOffsets(1, { ...base, spanFrames: 10 }), [0]);

// offsets are always finite -- the panel joins them into a CSV for the host
for (const order of ["topDown", "bottomUp", "byTime", "centerOut", "edgesIn", "random"]) {
  for (const name of Object.keys(PRESETS)) {
    const o = computeOffsets(7, { ...base, order, curve: PRESETS[name], spanFrames: 24, times: [3, 1, 2, 0, 6, 5, 4] });
    assert.ok(o.every(Number.isFinite), `${order}/${name} produced a non-finite offset`);
  }
}

console.log("core: all assertions passed");

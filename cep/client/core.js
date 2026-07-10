/* Pure sequencing math. No AE, no DOM — loaded by index.html and by test/core.test.js. */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.LSCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // ponytail: LCG, not a great PRNG. Fine for "shuffle 30 layers reproducibly".
    function makeRng(seed) {
        var s = (seed >>> 0) || 1;
        return function () {
            s = (s * 1664525 + 1013904223) % 4294967296;
            return s / 4294967296;
        };
    }

    // Cubic bezier with endpoints pinned at 0 and 1; a,b are the two control coords.
    function bezAt(u, a, b) {
        var v = 1 - u;
        return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
    }
    function bezSlope(u, a, b) {
        var v = 1 - u;
        return 3 * v * v * a + 6 * v * u * (b - a) + 3 * u * u * (1 - b);
    }
    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    /* Curve as [x1,y1,x2,y2], same convention as CSS cubic-bezier(). x is clamped to
     * [0,1] so the curve stays a function; y is free, which is what gives overshoot. */
    function bezierYAtX(x, x1, y1, x2, y2) {
        x1 = clamp01(x1); x2 = clamp01(x2);
        if (x <= 0) return 0;
        if (x >= 1) return 1;

        var u = x, i, err, slope;
        for (i = 0; i < 8; i++) {
            err = bezAt(u, x1, x2) - x;
            if (Math.abs(err) < 1e-7) return bezAt(u, y1, y2);
            slope = bezSlope(u, x1, x2);
            if (Math.abs(slope) < 1e-7) break;
            u -= err / slope;
        }
        var lo = 0, hi = 1;
        u = x;
        for (i = 0; i < 40; i++) {
            err = bezAt(u, x1, x2) - x;
            if (Math.abs(err) < 1e-7) break;
            if (err > 0) hi = u; else lo = u;
            u = (lo + hi) / 2;
        }
        return bezAt(u, y1, y2);
    }

    /* rank[i] = which slot in the stagger item i occupies. Items arrive in timeline order. */
    function rankOrder(n, order, seed, times) {
        var i, j, rank = [];
        if (order === "bottomUp") {
            for (i = 0; i < n; i++) rank[i] = n - 1 - i;
        } else if (order === "random") {
            var r = makeRng(seed), perm = [];
            for (i = 0; i < n; i++) perm[i] = i;
            for (i = n - 1; i > 0; i--) {
                j = Math.floor(r() * (i + 1));
                var t = perm[i]; perm[i] = perm[j]; perm[j] = t;
            }
            for (i = 0; i < n; i++) rank[perm[i]] = i;
        } else if (order === "centerOut" || order === "edgesIn") {
            var mid = (n - 1) / 2, arr = [];
            for (i = 0; i < n; i++) arr.push({ i: i, d: Math.abs(i - mid) });
            arr.sort(function (a, b) { return (a.d - b.d) || (a.i - b.i); });
            for (j = 0; j < n; j++) rank[arr[j].i] = (order === "centerOut") ? j : (n - 1 - j);
        } else if (order === "byTime") {
            var byT = [];
            for (i = 0; i < n; i++) byT.push({ i: i, t: (times && times[i] !== undefined) ? times[i] : i });
            byT.sort(function (a, b) { return (a.t - b.t) || (a.i - b.i); });
            for (j = 0; j < n; j++) rank[byT[j].i] = j;
        } else {
            for (i = 0; i < n; i++) rank[i] = i;
        }
        return rank;
    }

    function spanFromSpacing(mode, amount, n) {
        return (mode === "total") ? amount : amount * (n - 1);
    }

    /* Returns a frame offset per item, in the items' original order.
     * opts: {spanFrames, curve:[x1,y1,x2,y2], order, reverse, anchor, jitterFrames, seed, snap, times} */
    function computeOffsets(n, opts) {
        if (n <= 0) return [];
        var i, o = opts || {};
        var c = o.curve || [1 / 3, 1 / 3, 2 / 3, 2 / 3];
        var seed = o.seed || 1;

        var rank = rankOrder(n, o.order || "topDown", seed, o.times);
        if (o.reverse) for (i = 0; i < n; i++) rank[i] = n - 1 - rank[i];

        var raw = [];  // indexed by slot, not by item
        for (i = 0; i < n; i++) {
            var t = (n > 1) ? i / (n - 1) : 0;
            raw[i] = (o.spanFrames || 0) * bezierYAtX(t, c[0], c[1], c[2], c[3]);
        }

        var base = raw[0];
        if (o.anchor === "last") {
            base = raw[n - 1];
        } else if (o.anchor === "center") {
            var sum = 0;
            for (i = 0; i < n; i++) sum += raw[i];
            base = sum / n;
        }

        var jr = makeRng(seed + 7919), out = [];
        for (i = 0; i < n; i++) {
            var v = raw[rank[i]] - base;
            if (o.jitterFrames) v += (jr() * 2 - 1) * o.jitterFrames;
            out[i] = (o.snap === false) ? v : Math.round(v);
        }
        return out;
    }

    var PRESETS = {
        "Linear":      [1 / 3, 1 / 3, 2 / 3, 2 / 3],
        "Ease In":     [0.42, 0, 1, 1],
        "Ease Out":    [0, 0, 0.58, 1],
        "Ease In-Out": [0.42, 0, 0.58, 1],
        "Exponential": [0.7, 0, 0.84, 0],
        "Anticipate":  [0.68, -0.55, 0.27, 1.0],
        "Overshoot":   [0.34, 1.56, 0.64, 1]
    };

    return {
        bezAt: bezAt,
        bezierYAtX: bezierYAtX,
        clamp01: clamp01,
        rankOrder: rankOrder,
        computeOffsets: computeOffsets,
        spanFromSpacing: spanFromSpacing,
        PRESETS: PRESETS
    };
});

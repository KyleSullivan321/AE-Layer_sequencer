/*
 * In-AE verification of the ExtendScript host (the part node can't reach).
 * Creates a temp comp, exercises the host, deletes the comp, and writes
 * test/ae_result.txt.
 *
 * Run it with:  test/run-ae-verify.ps1
 *
 * AE's -r flag silently mishandles paths with spaces, so that script drops a shim
 * in a space-free directory which sets LS_REPO and evalFile's this file. Reading
 * the repo root from LS_REPO rather than $.fileName keeps it independent of how
 * ExtendScript resolves $.fileName inside evalFile.
 *
 * The offset math lives in cep/client/core.js and is covered by test/core.test.js.
 */
var REPO = (typeof LS_REPO !== "undefined")
    ? String(LS_REPO).replace(/\\/g, "/")
    : new File($.fileName).parent.parent.fsName.replace(/\\/g, "/");   // direct -r, no spaces
var SRC = REPO + "/cep/host/sequencer.jsx";
var OUT = REPO + "/test/ae_result.txt";

var log = [], fails = 0;
function say(s) { log.push(s); }

function report() {
    var f = new File(OUT);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(log.join("\n"));
    f.close();
}

/* -r runs against whatever project is already open. This suite adds comps and
 * fires an Undo, so it must never touch real work. Empty project or nothing. */
if (app.project.numItems > 0) {
    say("ABORTED: project is not empty (" + app.project.numItems + " items).");
    say("These tests create comps and issue an Undo. Open an empty project first:");
    say("  File > New Project   (after saving anything you care about)");
    report();
    throw new Error("ae_verify refused to run in a non-empty project");
}
function ok(name, cond, detail) {
    if (!cond) fails++;
    say((cond ? "PASS  " : "FAIL  ") + name + (detail ? "   [" + detail + "]" : ""));
}
function near(a, b, eps) { return Math.abs(a - b) < (eps || 1e-4); }

function makeComp(n) {
    var comp = app.project.items.addComp("__LS_TEST__", 200, 200, 1, 10, 30);
    for (var i = 0; i < n; i++) {
        var L = comp.layers.addShape();   // shape layers add no project items
        L.name = "L" + i;
        L.selected = false;
    }
    comp.openInViewer();                  // LS_query/LS_apply read app.project.activeItem
    return comp;
}
function selectAll(comp) {
    for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = true;
}
function fd(comp) { return comp.frameDuration; }

var made = [];
try {
    $.evalFile(new File(SRC));
    ok("evalFile exposed host", typeof LS_query === "function" && typeof LS_apply === "function" &&
                                typeof shiftKeys === "function");

    // ---- 1. layer startTime stagger, through the real entry points ----
    (function () {
        var comp = makeComp(5); made.push(comp);
        selectAll(comp);

        var q = LS_query("layers").split("|");
        ok("query: ok status", q[0] === "ok", q.join("|"));
        ok("query: 5 items", q[1] === "5", q[1]);
        ok("query: 30 fps", q[2] === "30", q[2]);
        ok("query: playhead frame", q[3] === "0", q[3]);
        ok("query: times all 0", q[4] === "0,0,0,0,0", q[4]);
        ok("query: comp name last", q[5] === "__LS_TEST__", q[5]);

        var r = LS_apply("layers", "0,6,12,18,24").split("|");
        ok("apply: ok status", r[0] === "ok", r.join("|"));
        ok("apply: 5 applied, 0 locked, 0 merged", r[1] === "5" && r[2] === "0" && r[3] === "0", r.join("|"));

        var good = true, got = [];
        for (var i = 0; i < 5; i++) {
            var st = comp.layer(i + 1).startTime;
            got.push(Math.round(st / fd(comp)));
            if (!near(st, i * 6 * fd(comp))) good = false;
        }
        ok("apply: startTimes 0,6,12,18,24", good, got.join(","));

        // times now reflect the new positions, which is what "By Start Time" orders on
        ok("query: times reflect moves", LS_query("layers").split("|")[4] === "0,6,12,18,24",
           LS_query("layers").split("|")[4]);

        // Realign is panel-side: offset[i] = target - times[i], fed to LS_apply.
        // Collapse the 0,6,12,18,24 stagger back to comp start.
        var toStart = [];
        for (i = 0; i < 5; i++) toStart.push(0 - (i * 6));   // -0,-6,-12,-18,-24
        LS_apply("layers", toStart.join(","));
        var allZero = true;
        for (i = 1; i <= 5; i++) if (!near(comp.layer(i).startTime, 0)) allZero = false;
        ok("realign: all layers collapse to comp start", allZero,
           LS_query("layers").split("|")[4]);

        // ...and to an arbitrary target (playhead frame 12): every layer lands on 12.
        LS_apply("layers", "12,12,12,12,12");
        var allTwelve = true;
        for (i = 1; i <= 5; i++) if (!near(comp.layer(i).startTime, 12 * fd(comp))) allTwelve = false;
        ok("realign: all layers move to target frame 12", allTwelve,
           LS_query("layers").split("|")[4]);
    })();

    // ---- 1b. playhead is reported in frames ----
    (function () {
        var comp = makeComp(2); made.push(comp);
        selectAll(comp);
        comp.time = 15 * fd(comp);       // move the CTI to frame 15
        var q = LS_query("layers").split("|");
        ok("query: playhead reflects comp.time", q[3] === "15", q[3]);
    })();

    // ---- 2. host rejects a stale offset list instead of half-applying it ----
    (function () {
        var comp = makeComp(3); made.push(comp);
        selectAll(comp);
        var r = LS_apply("layers", "0,5").split("|");
        ok("guard: count mismatch rejected", r[0] === "err" && r[1].indexOf("Selection changed") === 0, r.join("|"));
        ok("guard: nothing moved", near(comp.layer(1).startTime, 0) && near(comp.layer(3).startTime, 0));

        var r2 = LS_apply("layers", "0,x,5").split("|");
        ok("guard: NaN offset rejected", r2[0] === "err" && r2[1].indexOf("Bad offset") === 0, r2.join("|"));
    })();

    // ---- 3. too few items ----
    (function () {
        var comp = makeComp(1); made.push(comp);
        selectAll(comp);
        var r = LS_apply("layers", "0").split("|");
        ok("guard: <2 items rejected", r[0] === "err" && r[1].indexOf("Need at least 2") === 0, r.join("|"));
    })();

    // ---- 4. locked layers are skipped, not moved ----
    (function () {
        var comp = makeComp(3); made.push(comp);
        comp.layer(2).locked = true;
        selectAll(comp);
        var r = LS_apply("layers", "0,5,10").split("|");
        ok("locked: reported 1 skip", r[2] === "1", r.join("|"));
        ok("locked: layer 2 did not move", near(comp.layer(2).startTime, 0));
        ok("locked: layer 3 still moved", near(comp.layer(3).startTime, 10 * fd(comp)));
    })();

    // ---- 5. keyframe stagger, per property ----
    (function () {
        var comp = makeComp(4); made.push(comp);
        var i, p;
        for (i = 1; i <= 4; i++) {
            p = comp.layer(i).property("Transform").property("Opacity");
            p.setValueAtTime(0, 0);
            p.setValueAtTime(1, 100);
            p.selected = true;
            p.setSelectedAtKey(1, true);
            p.setSelectedAtKey(2, true);
            comp.layer(i).selected = true;
        }
        var q = LS_query("property").split("|");
        ok("keys: query counts 4 properties", q[1] === "4", q.join("|"));

        var r = LS_apply("property", "0,3,6,9").split("|");
        ok("keys: apply ok", r[0] === "ok", r.join("|"));

        var good = true, got = [];
        for (i = 1; i <= 4; i++) {
            p = comp.layer(i).property("Transform").property("Opacity");
            var shift = (i - 1) * 3 * fd(comp);
            got.push(Math.round(p.keyTime(1) / fd(comp)));
            if (p.numKeys !== 2) good = false;
            if (!near(p.keyTime(1), shift) || !near(p.keyTime(2), 1 + shift)) good = false;
        }
        ok("keys: each property shifted 0,3,6,9", good, got.join(","));

        // removeKey wipes selection comp-wide, so every property must end up
        // re-selected, not just the last one rebuilt.
        var allSel = true, sels = [];
        for (i = 1; i <= 4; i++) {
            p = comp.layer(i).property("Transform").property("Opacity");
            sels.push(p.selectedKeys.length);
            if (p.selectedKeys.length !== 2) allSel = false;
        }
        ok("keys: selection restored on every property", allSel, "sel=" + sels.join(","));

        // ...which means a second Apply is a no-op-free repeat, not a dead click
        var r2 = LS_apply("property", "0,3,6,9").split("|");
        ok("keys: second apply still finds 4 items", r2[0] === "ok" && r2[1] === "4", r2.join("|"));
    })();

    // ---- 6. eases, hold, and spatial tangents survive the rebuild ----
    (function () {
        var comp = makeComp(1); made.push(comp);
        var L = comp.layer(1);

        var op = L.property("Transform").property("Opacity");
        op.setValueAtTime(0, 0);
        op.setValueAtTime(1, 100);
        op.setTemporalEaseAtKey(2, [new KeyframeEase(0, 77)], [new KeyframeEase(0, 77)]);
        op.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.HOLD);

        var pos = L.property("Transform").property("Position");
        pos.setValueAtTime(0, [0, 0]);
        pos.setValueAtTime(1, [100, 100]);
        pos.setSpatialTangentsAtKey(1, [0, 0, 0], [30, -40, 0]);  // AE wants 3 elements even in 2D

        var d = 5 * fd(comp);
        shiftKeys(op, { 1: d, 2: d });
        shiftKeys(pos, { 1: d, 2: d });

        ok("ease: influence preserved", near(op.keyInTemporalEase(2)[0].influence, 77, 0.01),
           "inf=" + op.keyInTemporalEase(2)[0].influence);
        ok("ease: HOLD out-interp preserved",
           op.keyOutInterpolationType(1) === KeyframeInterpolationType.HOLD);
        ok("ease: times shifted by 5f", near(op.keyTime(1), d) && near(op.keyTime(2), 1 + d));

        var t = pos.keyOutSpatialTangent(1);
        ok("spatial: out tangent preserved", near(t[0], 30, 0.01) && near(t[1], -40, 0.01),
           t[0] + "," + t[1]);
    })();

    // ---- 7. unselected keys stay put while selected ones move ----
    (function () {
        var comp = makeComp(1); made.push(comp);
        var op = comp.layer(1).property("Transform").property("Opacity");
        op.setValueAtTime(0, 0);
        op.setValueAtTime(1, 50);
        op.setValueAtTime(2, 100);

        shiftKeys(op, { 3: 5 * fd(comp) });   // only the last key moves
        ok("partial: untouched keys held", near(op.keyTime(1), 0) && near(op.keyTime(2), 1));
        ok("partial: selected key moved", near(op.keyTime(3), 2 + 5 * fd(comp)));
        ok("partial: values intact", op.keyValue(2) === 50 && op.keyValue(3) === 100);
    })();

    // ---- 8. collision is reported, not silently swallowed ----
    (function () {
        var comp = makeComp(1); made.push(comp);
        var op = comp.layer(1).property("Transform").property("Opacity");
        op.setValueAtTime(0, 0);
        op.setValueAtTime(3 * fd(comp), 100);
        var merged = shiftKeys(op, { 1: 3 * fd(comp) }).merged;  // key1 lands exactly on key2
        ok("collision: merge reported", merged === 1, "merged=" + merged);
        ok("collision: one key left", op.numKeys === 1, "numKeys=" + op.numKeys);
    })();

    // ---- 9. per-keyframe mode gives every key its own offset ----
    (function () {
        var comp = makeComp(1); made.push(comp);
        var L = comp.layer(1);
        var op = L.property("Transform").property("Opacity");
        op.setValueAtTime(0, 0);
        op.setValueAtTime(1, 50);
        op.setValueAtTime(2, 100);
        for (var k = 1; k <= 3; k++) op.setSelectedAtKey(k, true);
        op.selected = true;
        L.selected = true;

        var q = LS_query("keyframe").split("|");
        ok("perKey: 3 items", q[1] === "3", q.join("|"));
        ok("perKey: times are the key times in frames", q[4] === "0,30,60", q[4]);

        var r = LS_apply("keyframe", "0,3,6").split("|");
        ok("perKey: apply ok", r[0] === "ok", r.join("|"));
        ok("perKey: fanned out", near(op.keyTime(1), 0) &&
                                 near(op.keyTime(2), 1 + 3 * fd(comp)) &&
                                 near(op.keyTime(3), 2 + 6 * fd(comp)),
           [op.keyTime(1), op.keyTime(2), op.keyTime(3)].join(","));
    })();

    // ---- 10. one undo step reverts the whole apply ----
    (function () {
        var comp = makeComp(4); made.push(comp);
        selectAll(comp);
        LS_apply("layers", "0,4,8,12");
        ok("undo: layers moved", near(comp.layer(4).startTime, 12 * fd(comp)));

        // 16 is AE's Undo command. findMenuCommandId is no use here: the label is
        // dynamic ("Undo Layer Sequencer") and lookups return 2371 or 0 depending
        // on menu state. One Undo must revert all four layers -> one undo group.
        app.executeCommand(16);
        var reverted = near(comp.layer(2).startTime, 0) && near(comp.layer(3).startTime, 0) &&
                       near(comp.layer(4).startTime, 0);
        ok("undo: single step reverts all 4 layers", reverted,
           [comp.layer(2).startTime, comp.layer(3).startTime, comp.layer(4).startTime].join(","));
    })();

} catch (err) {
    fails++;
    say("EXCEPTION  " + err.toString() + "  (line " + err.line + ")");
}

// always clean up, even if something above blew up
for (var m = 0; m < made.length; m++) {
    try { made[m].remove(); } catch (e) {}
}
say(fails === 0 ? "ALL PASSED" : fails + " FAILURE(S)");
report();

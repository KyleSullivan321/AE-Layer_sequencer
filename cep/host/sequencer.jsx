/*
 * Layer Sequencer - ExtendScript host.
 * The panel computes the offsets (see client/core.js); this file only touches AE.
 *
 * evalScript() returns a string, and ExtendScript has no dependable JSON, so the
 * two entry points talk in pipe-delimited strings. Comp name goes last because it
 * is the only field that can legally contain a pipe.
 */

function selectedKeyProps(layer) {
    var out = [], sel = layer.selectedProperties, i, p;
    for (i = 0; i < sel.length; i++) {
        p = sel[i];
        if (p.propertyType === PropertyType.PROPERTY && p.canVaryOverTime &&
            p.numKeys > 0 && p.selectedKeys.length > 0) out.push(p);
    }
    return out;
}

/* Move keys by rebuilding the property's whole keyframe stack. There is no
 * setKeyTime in the AE API, so this is the only way to preserve eases.
 * Returns {merged, select}. Caller must re-select afterwards: removeKey on any
 * property clears keyframe selection for the whole comp, so selecting here
 * would be undone by the next property's rebuild. */
function shiftKeys(prop, deltaByKey) {
    var n = prop.numKeys, i, k, snap = [];
    if (n === 0) return { merged: 0, select: [] };

    for (i = 1; i <= n; i++) {
        var moved = deltaByKey.hasOwnProperty(i);
        k = { t: prop.keyTime(i) + (moved ? deltaByKey[i] : 0), v: prop.keyValue(i), sel: moved };
        k.inI = prop.keyInInterpolationType(i);
        k.outI = prop.keyOutInterpolationType(i);
        try { k.inE = prop.keyInTemporalEase(i); k.outE = prop.keyOutTemporalEase(i); } catch (e1) {}
        try { k.cont = prop.keyTemporalContinuous(i); k.auto = prop.keyTemporalAutoBezier(i); } catch (e2) {}
        if (prop.isSpatial) {
            try {
                k.inT = prop.keyInSpatialTangent(i); k.outT = prop.keyOutSpatialTangent(i);
                k.sCont = prop.keySpatialContinuous(i); k.sAuto = prop.keySpatialAutoBezier(i);
                k.rov = prop.keyRoving(i);
            } catch (e3) {}
        }
        snap.push(k);
    }
    snap.sort(function (a, b) { return a.t - b.t; });

    for (i = n; i >= 1; i--) prop.removeKey(i);
    for (i = 0; i < snap.length; i++) prop.setValueAtTime(snap[i].t, snap[i].v);

    // Two keys landed on the same frame; AE collapsed them. Indices no longer line
    // up with the snapshot, so leave the eases alone rather than corrupt them.
    if (prop.numKeys !== snap.length) {
        return { merged: snap.length - prop.numKeys, select: [] };
    }

    var select = [];
    for (i = 0; i < snap.length; i++) {
        var j = i + 1;
        k = snap[i];
        if (k.sel) select.push(j);
        // ease before interpolation type: setTemporalEaseAtKey forces BEZIER.
        try { if (k.inE && k.outE) prop.setTemporalEaseAtKey(j, k.inE, k.outE); } catch (e4) {}
        try { prop.setInterpolationTypeAtKey(j, k.inI, k.outI); } catch (e5) {}
        try { if (k.cont !== undefined) prop.setTemporalContinuousAtKey(j, k.cont); } catch (e6) {}
        try { if (k.auto !== undefined) prop.setTemporalAutoBezierAtKey(j, k.auto); } catch (e7) {}
        if (prop.isSpatial) {
            try { prop.setSpatialTangentsAtKey(j, k.inT, k.outT); } catch (e8) {}
            try { prop.setSpatialContinuousAtKey(j, k.sCont); } catch (e9) {}
            try { prop.setSpatialAutoBezierAtKey(j, k.sAuto); } catch (e10) {}
            try { if (j > 1 && j < prop.numKeys) prop.setRovingAtKey(j, k.rov); } catch (e11) {}
        }
    }
    return { merged: 0, select: select };
}

function sortedSelectedLayers(comp) {
    var sel = comp.selectedLayers, arr = [], i;
    for (i = 0; i < sel.length; i++) arr.push(sel[i]);
    arr.sort(function (a, b) { return a.index - b.index; });
    return arr;
}

/* Flatten the selection into the things we stagger, in timeline order.
 * mode: "layers" | "layer" | "property" | "keyframe" */
function collectItems(comp, mode) {
    var layers = sortedSelectedLayers(comp), items = [], i, j, k;
    if (mode === "layers") {
        for (i = 0; i < layers.length; i++) items.push({ layer: layers[i] });
        return items;
    }
    for (i = 0; i < layers.length; i++) {
        var props = selectedKeyProps(layers[i]);
        if (!props.length) continue;
        if (mode === "layer") {
            var group = [];
            for (j = 0; j < props.length; j++) group.push({ prop: props[j], keys: props[j].selectedKeys });
            items.push({ parts: group });
            continue;
        }
        for (j = 0; j < props.length; j++) {
            var keys = props[j].selectedKeys;
            if (mode === "property") {
                items.push({ parts: [{ prop: props[j], keys: keys }] });
            } else {
                keys.sort(function (a, b) { return a - b; });
                for (k = 0; k < keys.length; k++) {
                    items.push({ parts: [{ prop: props[j], keys: [keys[k]] }] });
                }
            }
        }
    }
    return items;
}

/* Current time of an item, in frames. Used by the panel's "By Start Time" order. */
function itemTimeFrames(comp, item, isLayerMode) {
    if (isLayerMode) return Math.round(item.layer.startTime / comp.frameDuration);
    var best = null, j, k;
    for (j = 0; j < item.parts.length; j++) {
        var p = item.parts[j];
        for (k = 0; k < p.keys.length; k++) {
            var t = p.prop.keyTime(p.keys[k]);
            if (best === null || t < best) best = t;
        }
    }
    return Math.round((best || 0) / comp.frameDuration);
}

function applyOffsets(comp, items, offsetsFrames, isLayerMode) {
    var fd = comp.frameDuration, i, j, locked = 0, merged = 0;

    if (isLayerMode) {
        for (i = 0; i < items.length; i++) {
            var L = items[i].layer;
            if (L.locked) { locked++; continue; }
            L.startTime += offsetsFrames[i] * fd;
        }
        return { locked: locked, merged: 0 };
    }

    // Accumulate per-property deltas first: in "layer"/"keyframe" mode a single
    // property can receive different offsets for different keys.
    var jobs = [], seen = [];
    for (i = 0; i < items.length; i++) {
        var parts = items[i].parts;
        for (j = 0; j < parts.length; j++) {
            var prop = parts[j].prop, slot = null, s;
            for (s = 0; s < seen.length; s++) if (seen[s] === prop) { slot = jobs[s]; break; }
            if (!slot) { slot = {}; seen.push(prop); jobs.push(slot); }
            for (var kk = 0; kk < parts[j].keys.length; kk++) {
                slot[parts[j].keys[kk]] = offsetsFrames[i] * fd;
            }
        }
    }
    var reselect = [];
    for (i = 0; i < jobs.length; i++) {
        var r = shiftKeys(seen[i], jobs[i]);
        merged += r.merged;
        reselect.push(r.select);
    }
    // Only now that every removeKey is done can selection stick.
    for (i = 0; i < jobs.length; i++) {
        try { seen[i].selected = true; } catch (e13) {}
        for (j = 0; j < reselect[i].length; j++) {
            try { seen[i].setSelectedAtKey(reselect[i][j], true); } catch (e14) {}
        }
    }
    return { locked: 0, merged: merged };
}

// ---------------------------- panel entry points ----------------------------

function LS_activeComp() {
    var it = app.project.activeItem;
    return (it && it instanceof CompItem) ? it : null;
}

/* -> "ok|<count>|<fps>|<t0,t1,...>|<compName>"  or  "err|<message>" */
function LS_query(mode) {
    try {
        var comp = LS_activeComp();
        if (!comp) return "err|No active composition";
        var items = collectItems(comp, mode);
        var times = [], i;
        for (i = 0; i < items.length; i++) {
            times.push(itemTimeFrames(comp, items[i], mode === "layers"));
        }
        return "ok|" + items.length + "|" + comp.frameRate + "|" + times.join(",") + "|" + comp.name;
    } catch (e) {
        return "err|" + e.toString();
    }
}

/* offsetsCsv is in frames, one per item, in the same order LS_query enumerated.
 * -> "ok|<applied>|<locked>|<merged>"  or  "err|<message>" */
function LS_apply(mode, offsetsCsv) {
    try {
        var comp = LS_activeComp();
        if (!comp) return "err|No active composition";

        var items = collectItems(comp, mode);
        var raw = String(offsetsCsv).split(","), offs = [], i;
        for (i = 0; i < raw.length; i++) {
            if (raw[i] !== "") offs.push(parseFloat(raw[i]));
        }
        if (items.length < 2) return "err|Need at least 2 items";
        if (offs.length !== items.length) {
            return "err|Selection changed (" + items.length + " items, " + offs.length +
                   " offsets). Hit Refresh.";
        }
        for (i = 0; i < offs.length; i++) {
            if (isNaN(offs[i])) return "err|Bad offset at position " + (i + 1);
        }

        app.beginUndoGroup("Layer Sequencer");
        var res;
        try {
            res = applyOffsets(comp, items, offs, mode === "layers");
        } finally {
            app.endUndoGroup();
        }
        return "ok|" + items.length + "|" + res.locked + "|" + res.merged;
    } catch (e) {
        return "err|" + e.toString();
    }
}

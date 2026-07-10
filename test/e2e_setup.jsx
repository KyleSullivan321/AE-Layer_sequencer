/* Builds the fixture e2e_panel.js expects: a comp named __E2E__ with 5 selected
 * layers, open in the viewer. Run with AfterFX.exe -r (path must have NO SPACES).
 * Re-runnable: replaces any previous __E2E__ comp.
 *
 * -r runs against whatever project is open, so refuse to touch real work. */
for (var i = app.project.numItems; i >= 1; i--) {
    var it = app.project.item(i);
    if (it instanceof CompItem && it.name === "__E2E__") it.remove();
}
if (app.project.numItems > 0) {
    throw new Error("e2e_setup refuses to run in a non-empty project (" +
                    app.project.numItems + " items). Open an empty project first.");
}
var comp = app.project.items.addComp("__E2E__", 200, 200, 1, 10, 30);
for (var j = 0; j < 5; j++) {
    var L = comp.layers.addShape();   // shape layers add no project items
    L.name = "L" + j;
}
// addShape() deselects the previous layer, so select in a second pass.
for (var k = 1; k <= comp.numLayers; k++) comp.layer(k).selected = true;
comp.openInViewer();

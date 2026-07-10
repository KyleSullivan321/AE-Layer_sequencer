/*
 * End-to-end test: drives the real CEP panel over the Chrome DevTools Protocol
 * and checks that After Effects actually moves.
 *
 * This is the only test that catches a panel that loads but does nothing — e.g.
 * a top-level `const cep = ...`, which is a SyntaxError because CEP injects a
 * global by that name, and which kills the whole inline script silently.
 *
 * Requires:
 *   - After Effects running with the extension installed (cep/ copied to
 *     %APPDATA%\Adobe\CEP\extensions\com.kylesullivan.layersequencer)
 *   - cep/.debug present (opens the devtools port; never ships in the zxp)
 *   - the Layer Sequencer panel open (Window > Extensions > Layer Sequencer)
 *   - a comp named __E2E__ with 5 selected layers (test/e2e_setup.jsx)
 *
 *   node test/e2e_panel.js
 */
const assert = require("assert");
const PORT = 8090;

let seq = 0, ws;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exceptions = [];

function send(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
  return r.result.value;
}

const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click(), 1`);
const setCtl = (id, v) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});
  if(e.type==='checkbox')e.checked=${JSON.stringify(v)};else e.value=${JSON.stringify(v)};
  e.dispatchEvent(new Event('change'));return e.value;})()`);

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.title === "Layer Sequencer");
  assert.ok(page, "Layer Sequencer panel not found on devtools port — is it open?");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      exceptions.push(`${d.exception?.description || d.text} @ line ${d.lineNumber + 1}`);
    }
  });

  await send("Runtime.enable");
  await send("Page.enable");
  exceptions.length = 0;
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);

  assert.deepStrictEqual(exceptions, [], "panel threw during boot");
  assert.strictEqual(await evaluate("typeof LSCore"), "object", "core.js did not load");
  assert.strictEqual(await evaluate("typeof window.refresh"), "function", "inline script did not run");
  assert.ok(await evaluate("document.getElementById('preset').options.length >= 8"), "presets not populated");

  // --- linear, step 6, anchor first ---
  await setCtl("target", "layers");
  await setCtl("order", "topDown");
  await setCtl("spacing", "step");
  await setCtl("amount", "6");
  await setCtl("anchor", "first");
  await setCtl("jitter", "0");
  await setCtl("snap", true);
  assert.strictEqual(await setCtl("preset", "Linear"), "Linear");

  await click("refresh");
  await sleep(900);
  assert.strictEqual(await text("sel"), "5 items");
  assert.strictEqual(await text("offsets"), "0  +6  +12  +18  +24");

  await click("apply");
  await sleep(1500);
  assert.match(await text("status"), /^Sequenced 5 items across 24 frames\./,
    "apply result must survive the refresh that follows it");
  assert.strictEqual(await evaluate("document.getElementById('status').className"), "ok");

  // --- ease-in, total span, centered: offsets straddle zero and gaps widen ---
  await setCtl("spacing", "total");
  await setCtl("amount", "24");
  await setCtl("anchor", "center");
  await setCtl("preset", "Ease In");
  await click("refresh");
  await sleep(900);
  const offs = (await text("offsets")).trim().split(/\s+/).map(Number);
  assert.strictEqual(offs.length, 5);
  assert.ok(offs[0] < 0 && offs[4] > 0, `center anchor should straddle zero: ${offs}`);
  for (let i = 2; i < offs.length; i++) {
    assert.ok(offs[i] - offs[i - 1] >= offs[i - 1] - offs[i - 2], `ease-in gaps must widen: ${offs}`);
  }

  // --- realign: collapse the stagger back to comp start ---
  // Reads AE positions straight from the host (the offsets row shows the prospective
  // stagger, not current times, so it can't confirm a flatten).
  const hostTimes = async () => {
    const res = await evaluate(
      `new Promise(r => window.__adobe_cep__.evalScript('LS_query("layers")', r))`);
    return String(res).split("|")[4];   // ok|count|fps|playhead|times|comp
  };

  await setCtl("target", "layers");
  await setCtl("alignTarget", "start");
  await click("refresh");
  await sleep(900);
  assert.notStrictEqual(await hostTimes(), "0,0,0,0,0", "layers should still be staggered before realign");

  await click("align");
  await sleep(1500);
  assert.match(await text("status"), /^Realigned 5 items to comp start\./, `realign status: ${await text("status")}`);
  assert.strictEqual(await hostTimes(), "0,0,0,0,0", "every layer should start at 0 after realign to comp start");

  assert.deepStrictEqual(exceptions, [], "panel threw during interaction");
  ws.close();
  console.log("e2e: all assertions passed");
})().catch((e) => { console.error("e2e FAILED:", e.message); process.exit(1); });

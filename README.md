# Layer Sequencer

An After Effects extension that staggers layers or keyframes along an editable bezier curve
instead of a flat linear offset.

Lives under **Window > Extensions > Layer Sequencer**.

## Install

Users: download the `.zxp` from the
[latest release](https://github.com/KyleSullivan321/AE-Layer_sequencer/releases/latest) and install it
with [ZXP Installer](https://aescripts.com/learn/zxp-installer/) or Anastasiy's Extension Manager.
It's self-signed, so you'll see an "unverified publisher" notice — that's expected for extensions
not distributed through Adobe Exchange.

Requires After Effects CC 2018 (15.0) or newer.

Developing: copy `cep/` to your CEP extensions folder and restart AE.

```powershell
$dst = "$env:APPDATA\Adobe\CEP\extensions\com.kylesullivan.layersequencer"
Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item .\cep $dst -Recurse
```

Unsigned bundles need `PlayerDebugMode` set — once per CSXS version:

```powershell
New-ItemProperty "HKCU:\Software\Adobe\CSXS.12" -Name PlayerDebugMode -Value 1 -PropertyType String -Force
```

## Use

Select layers (or keyframes), set a spacing, shape the curve, hit **Apply** (or press Enter).

| Control | What it does |
|---|---|
| **Sequence** | `Layers` shifts each layer's `startTime`. `Keyframes` shifts selected keys. |
| **Group by** | Keyframe mode only. `Layer` = all keys on a layer move together. `Property` = per property. `Keyframe` = every key gets its own offset (fans a single property out). |
| **Order** | Which item goes first: top-to-bottom, bottom-to-top, by current start time, center-out, edges-in, or seeded random. |
| **Spacing** | `Step` = N frames between consecutive items. `Total span` = spread everything across N frames. |
| **Anchor** | Which item keeps its current time — the first, the middle, or the last. |
| **Curve** | Maps sequence position to offset. Linear reproduces a normal stagger. `+` saves the current curve as a named preset; `−` deletes it. |
| **Jitter / Seed** | Randomly nudge each offset by up to ±N frames, reproducibly. The die re-rolls the seed. |
| **Snap** | Round offsets to whole frames. On by default. |
| **Realign to** | Starting over: collapse the current stagger so every selected item shares one time — the comp start or the playhead — then re-sequence from there. |

The curve's x axis is sequence position, y is offset. Drag the two orange handles, or type the
four numbers (same convention as CSS `cubic-bezier`). y is allowed past 0 and 1, which is what
`Anticipate` and `Overshoot` use — items back up before moving forward.

**Realign** is the reset. After a few Applies (or hand edits) you rarely want to reverse each one —
you want a clean baseline. It moves every selected layer's `startTime` (or, for keyframes, each
item's earliest selected key) onto the target, so the stagger flattens and you can start fresh.
It's a single undo step like Apply, and reuses the same guard: if the selection changed since the
last Refresh, it refuses rather than moving the wrong things.

The strip under the curve previews where each item actually lands, and the row below it lists the
exact frame offsets. Clumping is the thing you tune for, and dots on a curve don't show it.

Everything is one undo step. Locked layers are skipped and reported. Settings and custom presets
persist across sessions.

### Curve, concretely

With 5 layers and a 6-frame step, `Linear` gives offsets `0 +6 +12 +18 +24`. Switch to `Ease In`
over a 24-frame total span with a center anchor and you get `-10 -8 -2 +5 +14` — the first few
layers arrive almost together, then the tail spreads out. Same span, different feel.

## Layout

```
cep/CSXS/manifest.xml    what AE reads to find the panel
cep/client/index.html    the panel: UI, canvas curve editor, preview
cep/client/core.js       pure math (bezier solve, ordering, anchors, jitter) — no AE, no DOM
cep/host/sequencer.jsx   ExtendScript: the only code that touches AE
cep/.debug               dev only, opens the devtools port. Never shipped.
```

The panel computes offsets and sends them to the host as a CSV of frame numbers. `evalScript`
returns a string and ExtendScript has no dependable `JSON`, so the two entry points
(`LS_query`, `LS_apply`) talk in pipe-delimited strings, with the comp name last because it's
the only field that can contain a pipe.

The host revalidates before mutating: if the selection changed since the last Refresh, the
offset count won't match the item count and it refuses rather than half-applying.

## Tests

```bash
node test/core.test.js          # pure math
node test/e2e_panel.js          # drives the live panel over the devtools protocol
```

```powershell
.\test\run-ae-verify.ps1        # exercises the ExtendScript host inside a real AE
```

AE's `-r` flag silently mishandles paths containing spaces, so `run-ae-verify.ps1` drops a shim
in a space-free temp directory and passes the repo path through `LS_REPO`.

**`-r` runs against whatever project is currently open.** `ae_verify.jsx` and `e2e_setup.jsx`
create comps and fire an Undo, so both refuse to run unless the project is empty. Open a new
project before running them.

`e2e_panel.js` needs AE running, the extension installed with `.debug`, the panel open, and the
`__E2E__` fixture (`test/e2e_setup.jsx`). It's the only test that catches a panel which loads but
does nothing — see the `cep` note below.

## Build

```powershell
.\build-zxp.ps1
```

Needs `tools/ZXPSignCmd.exe` ([Adobe-CEP/CEP-Resources](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD/4.1.3/x64)).
First run generates `dist/selfsigned.p12`. The password comes from `$env:ZXP_CERT_PASS`, falling
back to a default in the script. `dist/`, `tools/`, and `*.p12` are gitignored — don't commit the
certificate. The script reads the version from `manifest.xml` and excludes `.debug` from the package.

## Things that cost real time

- **`const cep = ...` is a SyntaxError.** CEP injects a global named `cep`. The redeclaration kills
  the entire inline script, so the panel renders perfectly and every button does nothing, with no
  visible error. This is why `e2e_panel.js` exists.
- **Moving keyframes means rebuilding the property's whole key stack** — the AE API has no
  `setKeyTime`. Eases, hold interpolation, spatial tangents, and roving are snapshotted and restored.
- **`removeKey` clears keyframe selection comp-wide**, not per-property. Restoring selection inline
  means each property's rebuild wipes the previous one's, so only the last property stays selected
  and a second Apply finds nothing. Selection is restored in a final pass, after every rebuild.
- **Ease before interpolation type.** `setTemporalEaseAtKey` forces BEZIER, so setting the ease
  first and the interpolation type second is what preserves HOLD keys.
- **Spatial tangents want 3-element arrays**, even on a 2D layer.
- If two keys land on the same frame AE merges them. That's reported in the status line, and the
  eases on that property are left alone rather than misapplied to shifted indices.
- **AE's Undo is command id 16.** `findMenuCommandId("Undo")` returns 2371 (something else
  entirely), and the real label is dynamic (`"Undo Layer Sequencer"`).

## Not built

- No live preview while dragging the curve; Apply then undo is fast enough.
- Only two bezier control points, so no multi-segment curves. Add if a single S-curve stops being
  enough.
- Presets are per-machine (`localStorage`), not exportable.

# STARGATE COMMAND — Dialing Computer

An app launcher for Windows that looks and behaves like the SG-1 dialing
computer. Type a program name, hit Enter, and the gate dials it: the inner
track spins, seven chevrons lock, the kawoosh fires, and your program opens
through the wormhole.

Zero dependencies — just Node and the Edge that's already on the machine.

---

## Running it

It runs two ways, from one codebase. The entire frontend — gate renderer,
glyphs, dialing, audio — is identical either way; only the transport differs
(`backend` in `public/app.js` picks it).

### As a desktop app

```bash
npm install
npm start
```

A real frameless window with its own icon and window controls. Program
discovery and launching happen in the Electron main process over IPC; there
is no HTTP server and no browser involved.

**To build an installer:**

```bash
npm run dist
```

Produces `dist/StargateCommand-Setup-1.0.0.exe` — a normal Windows installer
with a choosable install directory plus Start Menu and desktop shortcuts. Use
`npm run pack` for an unpacked build in `dist/win-unpacked` if you just want
to run it without installing.

It is unsigned, so SmartScreen will show "Windows protected your PC" on
another machine — More info → Run anyway. Signing it needs a code-signing
certificate.

### In a browser

```bash
node server.js
```

Or double-click **`Stargate.vbs`** (no console window), or **`Stargate.cmd`**
(keeps a console around, handy for debugging). The server binds to
`127.0.0.1` on a random free port and opens Edge in chromeless app-window
mode. Useful for development — edit and reload without restarting Electron.

**Give that mode a hotkey:**

```bash
powershell -ExecutionPolicy Bypass -File .\Install-Shortcut.ps1 -Desktop
```

Creates Start Menu and desktop shortcuts bound to **Ctrl+Alt+G**. Pass
`-HotKey 'CTRL+ALT+S'` for something else. Windows only honours shortcut
hotkeys for shortcuts that live in the Start Menu or on the Desktop, so leave
them where the script puts them.

---

## Using it

| Key | Does |
| --- | --- |
| *type* | filter the destination registry |
| <kbd>I</kbd> | open / close the iris |
| <kbd>↑</kbd> <kbd>↓</kbd> | move the selection |
| <kbd>Enter</kbd> | dial at the current speed |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | dial the full cinematic sequence |
| <kbd>Tab</kbd> | cycle dial speed |
| <kbd>Esc</kbd> | abort a dial · clear the search · hide the window |
| <kbd>F5</kbd> | rescan installed programs |
| <kbd>M</kbd> | toggle audio |
| *hotkey* | summon the gate from anywhere (default <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>) |

**Summon hotkey.** Click **HOTKEY** in the footer, then press the combination
you want. It must include a modifier — a bare key would be swallowed
system-wide — and <kbd>Esc</kbd> cancels. If the combination is already taken
by another application the registration is refused and the old one stays.
Pressing it restores and focuses the window and puts the caret in the search
box.

**Hiding entries.** Press **MANAGE** by the registry heading. Every row grows a
tick box, hidden entries reappear struck through, and clicking a row toggles
it — tick to hide, untick to restore. Useful for the "About …", "… Help" and
setup-wizard entries the name filter can't catch. Search still works while
managing, so you can filter and clear a batch at a time. Press **DONE** to go
back.

A normal row carries **no hide control at all** — there is nothing to
mis-click while you are launching things, which an earlier per-row ✕ could not
promise however much confirmation was bolted onto it. Dialling is disabled
while managing, and the tick *is* the hidden state, so every action is
immediately reversible and needs no confirmation.

Hidden keys live in `settings.json`, so they survive a rescan.

**Window position and size** are remembered between runs, including whether
it was maximised. Saved bounds are ignored if they no longer land on a
connected display.

**Program icons.** Each entry shows the program's real icon. Anything without
one falls back to a small gate sigil so rows stay aligned. Coverage on a
typical machine is around 94%.

**Custom destinations.** Press **+ ADD** by the registry heading for anything
the Start Menu doesn't list — a program, a document, a folder, or a URL.
**BROWSE…** opens a native picker and fills the name in from the filename.
The target decides how it launches:

| target | kind | launched by |
| --- | --- | --- |
| `…\thing.exe`, `.bat`, `.cmd`, `.com` | `lnk` | direct spawn, real pid |
| `https://…` | `url` | `shell.openExternal` |
| anything else — file or folder | `file` | `shell.openPath` |

Targets that don't exist are refused with the form left open. Custom entries
are tagged `CUSTOM` in the list and can be removed outright from **MANAGE**
mode — hiding one would strand it in `settings.json` with no way back.

**UI scale.** Sizes are authored for a ~1360px window and multiplied by
`--ui`, which steps up with window width (1.0 → 1.40 by 2700px), so panel text
stays readable on a large monitor. Stepped via media queries because CSS
cannot derive a unitless multiplier from `vw`. The gate is unaffected — it
already sizes from its container.

**Dial speeds**, measured end to end:

| | dial | to wormhole | ring rate |
| --- | --- | --- | --- |
| `INSTANT` | 0.2s | 0.5s | — |
| `NORMAL` (default) | 9.0s | 9.9s | 320 °/s |
| `SHOW` | 26.8s | 28.3s | 160 °/s, +1 full revolution per symbol |

The setting persists; Shift+Enter always forces `SHOW`.

The ring turns at a **constant angular rate**, so a spin takes longer the
further it has to go — on `NORMAL` individual spins range from 0.3s to 1.3s
depending on where the symbol is. A fixed per-symbol duration (what this used
to do) makes short hops crawl and long sweeps look flung; constant rate is
what makes it read as a motor. To retune, change `degPerSec` in `SPEEDS` at
the top of `public/app.js` — lower is slower.

Each symbol is shown **large across the aperture** as it locks, one at a time,
then shrinks and flies into its slot in the column of seven destination boxes
down the right of the gate. The flight is not awaited by the dial loop — it
travels while the ring is already turning for the next symbol, so it costs no
time. Below a certain window width there is no room for the column and it is
dropped rather than squeezed.

**The gate stays open for 60 seconds** after transit, counting down in the
GATE readout. The console is released the moment transit completes, so you can
carry on searching or dial again immediately — dialling again, or <kbd>Esc</kbd>,
shuts it early.

**Chevron positions.** They are not evenly numbered around the ring. The seven
address chevrons sit symmetrically — 1, 2, 3 down the right side, 4, 5, 6 back
up the left, 7 at top — and the two extra chevrons, 8 and 9, fill the bottom.
In degrees clockwise from top: `7:0  1:40  2:80  3:120  8:160  9:200  4:240
5:280  6:320`. Lighting them 1→7 therefore sweeps down one side and up the
other.

Every symbol is brought to **top dead centre**, as on screen. The top chevron
grabs it there while the numbered chevron latches and stays lit, so the
chevrons fill in 1→7 around the ring as the dial proceeds. Chevron 7 *is* the
top one, so a seven-symbol address finishes with the Point of Origin sitting
under it. Alignment is exact and tested — every symbol lands within half a
degree of bearing 0.

The grab runs concurrently with the latch rather than as a separate beat, so
it stays visible without lengthening the dial.

The program launches at the moment of the kawoosh, not after it — so even the
cinematic dial doesn't delay your actual app.

---

## How it works

```
electron/
  main.js          desktop app — window, IPC, owns the catalog
  preload.js       the only bridge to the renderer
lib/
  catalog.js       program discovery, caching, usage stats
  launcher.js      starting programs
  icons.js         extracts program icons, cached as data URIs
  appx-activator.js  Store-app activation over a persistent PowerShell
  settings.js      window bounds, hotkey, hidden keys, custom entries
server.js          browser mode — HTTP over the same lib/
public/
  index.html       console chrome
  style.css        cyan diagnostics-screen styling
  glyph-paths.js   generated — traced glyph artwork
  glyphs.js        glyph rendering + gate address derivation
  gate.js          canvas renderer — ring, chevrons, kawoosh, event horizon
  audio.js         synthesized gate sounds (no audio files)
  app.js           search, dial sequencing, transport shim
tools/
  trace-glyphs.js  contact sheet -> exact vector paths
  png.js           minimal PNG decoder (zlib only)
  make-icon.ps1    draws build/icon.png
  capture-window.ps1  screenshots the desktop window, for checking builds
```

State (catalog cache, launch counts, generated helper scripts) lives in
`data/` in browser mode and in Electron's `userData` folder in the desktop
app — the install directory under Program Files is not writable.

**Icons** are extracted once and cached in `icons.json` as 32px PNG data
URIs. Shortcuts go through `Icon.ExtractAssociatedIcon` on the *.lnk itself*,
so a shortcut's own `IconLocation` is honoured rather than guessed from the
target — that is what Explorer shows you. Store apps are resolved from the
package manifest, preferring the `altform-unplated` asset, which is the bare
glyph without the coloured backing tile that looks wrong on a dark console.

Extraction costs roughly 50ms per program, so it runs in the background after
a scan and the renderer is sent a fresh catalog when the icons land — it keeps
your selection and scroll position, since this can arrive while you are
already typing.

> Windows PowerShell's `Set-Content -Encoding UTF8` writes a **BOM**, which
> `JSON.parse` rejects outright. The extractor writes via
> `[IO.File]::WriteAllText` with a BOM-less encoder, and the reader strips one
> defensively.

**Finding programs.** A PowerShell pass walks the all-users and per-user Start
Menu and Desktop folders for `.lnk`/`.url` files, resolving each shortcut's
real target via `WScript.Shell`, then folds in `Get-StartApps` to catch Store
apps. Obvious non-programs (uninstallers, readmes, "Visit our website") are
filtered out and duplicates are collapsed by normalized name. Results are
cached in `data/catalog.json` and refreshed every 12 hours or on demand.

**Launching**, in order of preference:

1. **Direct** — shortcuts whose target resolves to an executable are spawned
   ourselves, using the target, arguments and working directory captured
   during the scan. Real pid, real `error` event.
2. **Activate** — Store apps, via
   `IApplicationActivationManager::ActivateApplication` by AUMID, which
   returns an HRESULT *and* the real process id.
3. **Shell** — `.url` files and shortcuts to documents go through Electron's
   `shell.openPath`, which runs ShellExecuteEx in-process and returns a
   message on failure.
4. **explorer.exe** — last-resort fallback only.

Every launch is logged with the mechanism and pid. The first three can tell
success from failure, so when a program does not start the gate says
`WORMHOLE COULD NOT BE ESTABLISHED` and collapses instead of claiming transit
and sitting open for a minute.

**Store apps** used to be the weak spot: an AUMID under `shell:AppsFolder` is a
shell namespace path — not a file, not a URL — so `shell.openPath` and
`shell.openExternal` both reject it, leaving `explorer.exe`, which reports
nothing and dropped roughly one launch in ten.
`IApplicationActivationManager` is the documented API for this. Reaching it
needs COM interop, which from PowerShell means `Add-Type` and a ~0.5s compile,
so `lib/appx-activator.js` keeps one PowerShell alive for the life of the app:
it pays that cost once at startup and then answers activation requests over
stdin in ~400ms.

> The cast to the COM interface happens inside the C#, not in PowerShell.
> PowerShell cannot cast the runtime-callable wrapper to a `ComImport`
> interface — it fails with "Cannot convert System.__ComObject" — whereas the
> C# cast performs a proper QueryInterface.

> Two things worth knowing if you touch this.
>
> PowerShell's `Start-Process` looks like the obvious choice and works
> interactively, but when spawned detached and hidden from Node it exits
> before the shell activation it started completes, so Store apps silently
> never launch — exit code 0, no window, no error.
>
> `explorer.exe` fixes that, but it is fire-and-forget: it reports nothing and
> always exits 1, and if the shell is busy it will occasionally accept a
> request and simply drop it. That shows up as a dial that reports success and
> launches nothing. Hence the direct spawn for anything we can resolve to an
> executable — it yields a real pid and a real `error` event.

**Gate addresses.** Each program's name is hashed (FNV-1a) into six
constellation glyphs plus the Point of Origin. Deterministic, so a given
program always has the same address — Photoshop is always Photoshop.

**The look** is modelled on the SGC gate-diagnostics screen: deep navy ground,
cyan structure and type, green reserved for the gate symbols, amber for a
handful of status indicators only. The gate is drawn as a schematic rather
than a photograph — glowing structural circles, symbol cells, flat grey
chevron brackets. The telemetry around the edges (code strip, subset tables,
drifting hex) is decorative and marked `aria-hidden`; it's what makes the
thing read as an instrument rather than a web page.

**The ring** follows the gate's construction drawing. Outward from the middle:
the aperture out to 0.740 of the radius, the glyph cells (the rotating inner
track) to 0.885, the scalloped band to 0.958, then the outer rim the chevrons
mount on. The real ring is thinner than memory suggests — the aperture is
nearly three quarters of the outside radius. The top chevron is built
oversized, as on the prop.

**The glyphs** are the real artwork, traced from a contact sheet of all 42
symbols (39 gate glyphs plus the Abydos, Antarctica and P7J-989 points of
origin). To regenerate them:

```bash
node tools/trace-glyphs.js assets/glyphs.png --region 228,196,772,812 --circle 623,623,535 --cols 6 --rows 7 --preview
```

It decodes the PNG (`tools/png.js`, zlib only — still no dependencies),
thresholds to an ink mask, finds the grid by projection profile (glyph bands
are tall, filename captions are short, so they separate cleanly), then traces
each cell along real pixel edges. That yields outer contours and holes
together, so rings stay hollow when filled even-odd. Douglas-Peucker keeps the
output small. Results land in `public/glyph-paths.js`; `--preview` also writes
`tools/glyph-preview.svg` to check the trace by eye.

`--circle` masks out the assembled ring the sheet also draws: a histogram of
white pixels by radius shows a clean gap at 530px — grid content tapers to 40
pixels there, the ring jumps to over a thousand at 540 — so clearing anything
beyond it drops the ring without touching the glyphs.

Column boundaries are taken from all seven rows stacked together rather than
row by row. Per-row merging is fragile: in row 5 two glyphs sit close enough
to collapse into one cell, which silently shifts every index after them.
Stacked, the five gaps between the six columns are the widest blank runs in
the profile, which is unambiguous.

Other useful flags: `--threshold` for the ink cutoff, `--invert` for
dark-on-light sheets, `--minarea` to drop JPEG compression speckle,
`--epsilon` for how hard to simplify.

If `public/glyph-paths.js` is missing or empty, `glyphs.js` falls back to
procedurally generated constellation shapes — recognisable, but not the real
symbols. Names follow the canonical list either way (Crater, Virgo, Boötes, …
Leo), with glyph 1 as the Point of Origin.

**Audio** is synthesized with the Web Audio API — filtered noise bursts and
oscillator envelopes for the chevron locks, a lowpass sweep for the kawoosh, a
detuned drone for the open wormhole. No sample files anywhere.

---

## The iris

Press <kbd>I</kbd> or use the **IRIS** button. The trinium blades spiral shut
across the event horizon and the button turns amber.

The blades are modelled as a real multi-bladed leaf shutter, which is what
canon describes: each plate's leading edge is a circular **arc whose centre is
offset from the gate centre**, and the aperture is the envelope of those arcs.
That is where the spiral comes from — it falls out of the mechanism rather
than being drawn on. The plates sweep round as they close, deepening the
twist, and meet on a small central hub rather than a mathematical point.
Twenty-two of them, per the "more than 20 interlocking plates" in the source
material.

Each plate is filled **flat**, stepping tone between neighbours. An earlier
version shaded a gradient across every blade, which made the whole assembly
read as a smooth 3D cone instead of overlapping sheet metal.

Both arc spans are **derived, not chosen**. A plate is the region inside the
housing and outside its own edge arc, so the two arcs must meet at the same
two points: `s`, the half-angle of the edge arc, comes from the law of cosines
on the triangle centre-to-plate-centre-to-crossing, and `phi` is the bearing of
that crossing. Hard-coding them was the cause of the overlap artifacts — the
edge arc ended at 1.09 rad while the rim arc it joined spanned only 0.43 rad,
so `closePath` drew a chord straight across the aperture. Each plate is drawn as its **actual visible shape**: the region outside its own
edge arc and inside the *next* plate's — precisely the part a real blade leaves
showing before it tucks under its neighbour. These shapes tile the annulus
rather than overlapping.

That last point is load-bearing. Drawing full overlapping lunes requires every
blade to be painted under the next one all the way round, which is a cyclic
overlap and cannot be expressed by a painter's algorithm: exactly one seam
always ends up inverted. With lunes spanning ±61° that seam showed as a large
dark wedge. Tiling removes the ordering question altogether, so the wrap is
seamless.

With the iris closed the gate still dials normally — all seven chevrons, the
kawoosh, the wormhole — but **nothing comes through**: the launch is skipped
and the log reads `IRIS CLOSED — TRANSIT BLOCKED`. Same as the real thing,
and handy as a safety catch if you want to watch a dial without actually
opening the program.

The setting persists between runs.

## Security

Anything that launches programs on request deserves care.

**Both modes** take *an index into the backend's own catalog*, never a path
from the caller. Nothing can talk either one into running an arbitrary
executable — the worst case is starting something already in your Start Menu.

**Desktop app.** `contextIsolation` on, `nodeIntegration` off. The renderer
reaches the machine only through the preload bridge in `electron/preload.js`,
which exposes six calls and no way to pass a path. Navigation away from the
gate is blocked and external links are handed to the real browser rather than
opening in the window.

**Browser mode.** Binds to `127.0.0.1` on an ephemeral port. Every API call
needs a random per-session token in an `X-Gate-Token` header — custom headers
can't be forged by cross-origin form posts, and CORS preflight blocks
cross-origin `fetch`. The token is injected at serve time and rotates every
run. Static serving is confined to `public/`; traversal attempts 404.

---

## Options

```bash
node server.js --no-browser        # don't open Edge (server only)
node server.js --rescan            # force a fresh scan at startup
node server.js --port=47332        # pin the port instead of picking one free
```

`SGC_PORT` works as an environment variable equivalent of `--port`.

---

## Notes

- Needs Node (built and tested on v24) and Windows 10/11.
- **Building on a machine with endpoint protection.** `electron-builder`
  normally downloads Electron and extracts it into `dist/`, then renames the
  directory. Real-time scanners (Sophos, Acronis Active Protection) open the
  freshly written executables, and the rename fails with `EPERM`. The build
  config sets `electronDist` to `node_modules/electron/dist`, which is already
  unpacked, so that step is skipped entirely. Don't "fix" this by excluding
  the folder from managed security software.
- `tools/drive-desktop.js` evaluates an expression inside the running desktop
  app over the DevTools protocol, for checking a packaged build without
  driving the window by hand:
  ```bash
  node tools/drive-desktop.js "state.apps.length"
  ```
  Start the app with `--remote-debugging-port=9222` first.
- Deleting `data/catalog.json` forces a full rescan on next launch.
- `data/usage.json` tracks launch counts and recency, which feed search
  ranking — your most-used programs surface first on an empty query.

# Running under KDE Plasma (Linux)

This adds Linux support to the launcher without touching the Windows paths.
The gate itself — the ring, glyphs, iris, animation, audio and dialing logic
in `public/` — is platform-neutral and unchanged. The platform-specific
"how do I find and start programs" layer now dispatches on `process.platform`:

| Concern | Windows (unchanged) | Linux |
| --- | --- | --- |
| Program discovery | PowerShell walks Start Menu `.lnk` files | Pure-Node scan of `.desktop` files under the XDG application dirs (system, user, Flatpak and Snap exports) |
| Icons | PowerShell + System.Drawing extracts `.ico` | Freedesktop icon-theme lookup; PNGs resized with `nativeImage`, SVGs sent straight to the renderer |
| Launching | `explorer.exe` / COM AppX activation | `gio launch <file.desktop>` with a parsed-`Exec` direct-spawn fallback |

Each of `lib/catalog.js`, `lib/launcher.js` and `lib/icons.js` is now a thin
dispatcher that loads `…-win.js` on Windows and `…-linux.js` everywhere else,
so the original Windows implementations are preserved byte-for-byte.
`lib/appx-activator.js` is back and is only started on Windows.

## Requirements

- Node 18+ and Electron (installed by `npm install`)
- `gio` from glib2 — present on every normal Linux desktop. It is what
  resolves DBus activation, Flatpak/Snap wrappers and `Terminal=true`.

## Build and run

```bash
npm install
npm start            # run it from source
npm run dist:linux   # build an AppImage (in dist/)
```

`electron-builder` writes a `.desktop` entry for the AppImage, which is the
desktop icon you click to open the gate. You can also drop a `.desktop` file
in `~/.local/share/applications/` pointing at the AppImage.

## Wayland note (Plasma 6 default)

- **Launching by clicking the desktop icon works fully.** The only thing that
  cannot work under Wayland is the global summon hotkey
  (Ctrl+Alt+G): Electron's `globalShortcut` cannot grab global keys there.
  The app detects this and skips registration rather than spamming errors.
- If you want a summon key, add a custom shortcut in KDE **System Settings →
  Shortcuts** that runs the AppImage. A second launch summons the already-
  running gate via the single-instance lock.
- Re-clicking the icon while the gate is running may not raise the existing
  window on Wayland (a client cannot raise its own window). Closing it first
  avoids this entirely.

## Browser mode (`server.js`)

`server.js` is also ported. It serves the same gate over localhost and opens
it in the default browser via `xdg-open`:

```bash
npm run serve        # or: node server.js
```

It shares the platform-dispatched `lib/catalog.js` and `lib/launcher.js`
with the desktop app, so the catalog and launching behaviour are identical on
both platforms. On Windows it still opens Edge in `--app` mode; on Linux it
opens the default browser via `xdg-open`. The window-minimise helper is a
no-op on both platforms because the browser owns its window and the UI
launches with `minimize: false` anyway.

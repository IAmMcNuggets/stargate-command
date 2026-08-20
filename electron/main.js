'use strict';
/*
 * Stargate Command — Electron main process.
 *
 * Owns the program catalog, settings and all launching. The renderer never
 * sees a filesystem path: it asks for a catalog id and this process resolves
 * it, so the window can't be talked into running something arbitrary.
 */

const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, screen } = require('electron');
const path = require('path');

const { createCatalog } = require('../lib/catalog');
const { launchApp } = require('../lib/launcher');
const { createSettings } = require('../lib/settings');
const { createAppxActivator } = require('../lib/appx-activator');
const { createIconStore } = require('../lib/icons');

// Program Files is not writable, so state lives in userData.
const DATA_DIR = app.getPath('userData');
const catalog = createCatalog(DATA_DIR);
const settings = createSettings(DATA_DIR);
const icons = createIconStore(DATA_DIR, log);

let mainWindow = null;
let activator = null;

const IS_WIN32 = process.platform === 'win32';

// globalShortcut cannot grab keys under a Wayland session; Plasma defaults to
// Wayland, so a summon hotkey has to come from KDE System Settings there.
// Windows and X11 are unaffected.
const IS_WAYLAND =
  !IS_WIN32 && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

function log(message, isError) {
  (isError ? console.error : console.log)('  ' + message);
}

/* ------------------------------------------------------------- window */

/** Only restore saved bounds if they still land on a connected display. */
function boundsAreVisible(b) {
  if (!b || typeof b.x !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y;
  });
}

function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  // getBounds() reports the maximized rect, which is useless for restoring —
  // keep the last normal rect and the maximized flag separately.
  const b = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  settings.set('bounds', { ...b, maximized });
}

function createWindow() {
  const saved = settings.get('bounds');
  const useSaved = boundsAreVisible(saved);

  mainWindow = new BrowserWindow({
    width: useSaved ? saved.width : 1360,
    height: useSaved ? saved.height : 860,
    x: useSaved ? saved.x : undefined,
    y: useSaved ? saved.y : undefined,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#030d16',
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge and ipcRenderer, both of which
      // work in a sandboxed preload, so there is no reason to weaken this.
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  if (useSaved && saved.maximized) mainWindow.maximize();

  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) {
    mainWindow.on(ev, rememberBounds);
  }
  mainWindow.on('close', () => {
    rememberBounds();
    settings.flush();
  });
  mainWindow.on('closed', () => (mainWindow = null));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only ever hand http(s) to the OS. shell.openExternal will happily run
    // other schemes, and some of those are a known route to code execution.
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

/** Bring the gate up from wherever it is. */
function summon() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  // Windows blocks plain foreground stealing; a brief always-on-top wins it.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.focus();
  mainWindow.webContents.send('gate:summoned');
}

/* ------------------------------------------------------------- hotkey */

let activeHotkey = null;

function applyHotkey(accelerator) {
  if (activeHotkey) {
    globalShortcut.unregister(activeHotkey);
    activeHotkey = null;
  }
  if (!accelerator) return { ok: true, hotkey: null };
  if (IS_WAYLAND) {
    return {
      ok: false,
      hotkey: null,
      error: 'global hotkeys are not available under Wayland — set a shortcut in KDE System Settings instead',
    };
  }
  try {
    const ok = globalShortcut.register(accelerator, summon);
    if (!ok) return { ok: false, hotkey: activeHotkey, error: 'already taken by another app' };
    activeHotkey = accelerator;
    return { ok: true, hotkey: accelerator };
  } catch (e) {
    return { ok: false, hotkey: activeHotkey, error: e.message };
  }
}

/* ---------------------------------------------------------------- IPC */

/*
 * Work out how a hand-added target should be launched from the target itself,
 * so the user only has to supply a path or a link.
 */
function classifyTarget(raw) {
  const t = String(raw || '').trim();
  if (!t) throw new Error('a target is required');
  if (/^https?:\/\//i.test(t)) return { kind: 'url', launchPath: t, target: '' };
  if (IS_WIN32) {
    if (/\.(exe|com|bat|cmd)$/i.test(t)) return { kind: 'lnk', launchPath: t, target: t };
    return { kind: 'file', launchPath: t, target: '' };
  }
  if (/\.desktop$/i.test(t)) return { kind: 'desktop', launchPath: t, target: t };
  // A file with the executable bit set is run directly; anything else
  // (documents, folders) is handed to the shell, like double-clicking it.
  let executable = false;
  try {
    require('fs').accessSync(t, require('fs').constants.X_OK);
    executable = true;
  } catch (_) {
    executable = false;
  }
  if (executable) return { kind: 'command', launchPath: t, target: t };
  return { kind: 'file', launchPath: t, target: '' };
}

function syncCustom() {
  catalog.setCustom(settings.customList());
}

const clientList = () =>
  catalog.toClientList({ hidden: settings.hiddenSet(), icon: (k) => icons.get(k) });

/*
 * Icon extraction takes a couple of seconds for a full catalog, so it never
 * blocks a response — the renderer gets the list immediately and a fresh copy
 * pushed to it once the icons land.
 */
function refreshIcons(force) {
  icons.refresh(catalog.apps, force).then((added) => {
    if (!added) return;
    icons.prune(catalog.apps);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('catalog:updated', clientList());
    }
  });
}

ipcMain.handle('catalog:get', async () => {
  await catalog.ensure(false);
  refreshIcons(false);
  return clientList();
});

ipcMain.handle('catalog:rescan', async () => {
  await catalog.ensure(true);
  syncCustom(); // a rescan rebuilds the merged list, so re-apply custom entries
  refreshIcons(true); // re-attempt previously-missed icons on a manual rescan
  return clientList();
});

ipcMain.handle('catalog:hide', (_e, id) => {
  const entry = catalog.apps[Number(id)];
  if (!entry) throw new Error('unknown address');
  settings.hide(entry.key);
  return clientList();
});

ipcMain.handle('catalog:addCustom', (_e, entry) => {
  const name = String((entry && entry.name) || '').trim();
  if (!name) throw new Error('a designation is required');

  const spec = classifyTarget(entry && entry.target);
  if (spec.kind !== 'url' && !require('fs').existsSync(spec.launchPath)) {
    throw new Error('that target does not exist');
  }

  const record = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    args: String((entry && entry.args) || '').trim(),
    workDir: '',
    ...spec,
  };
  settings.addCustom(record);
  syncCustom();
  refreshIcons(false);
  log('custom destination added: ' + name + ' [' + record.kind + ']');
  return clientList();
});

ipcMain.handle('catalog:removeCustom', (_e, id) => {
  const entry = catalog.apps[Number(id)];
  if (!entry || !entry.custom) throw new Error('not a custom destination');
  settings.removeCustom(entry.customId);
  settings.unhide(entry.key);
  syncCustom();
  log('custom destination removed: ' + entry.name);
  return clientList();
});

ipcMain.handle('dialog:pickTarget', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a program, file or folder',
    properties: ['openFile'],
    filters: IS_WIN32
      ? [
          { name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'com', 'lnk'] },
          { name: 'All files', extensions: ['*'] },
        ]
      : [
          { name: 'Programs', extensions: ['desktop'] },
          { name: 'All files', extensions: ['*'] },
        ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('catalog:unhide', (_e, id) => {
  const entry = catalog.apps[Number(id)];
  if (!entry) throw new Error('unknown address');
  settings.unhide(entry.key);
  return clientList();
});

ipcMain.handle('gate:launch', async (_event, id) => {
  const entry = catalog.apps[Number(id)];
  if (!entry) throw new Error('unknown address');
  const result = await launchApp(entry, {
    log,
    shellOpen: (spec) => shell.openPath(spec),
    openExternal: (url) => shell.openExternal(url),
    activateAppx: activator ? (aumid) => activator.activate(aumid) : null,
  });
  catalog.recordUsage(entry.key);
  return { ok: true, name: entry.name, ...result };
});

ipcMain.handle('settings:get', () => ({
  hotkey: activeHotkey,
  requestedHotkey: settings.get('hotkey'),
}));

ipcMain.handle('settings:setHotkey', (_e, accelerator) => {
  const res = applyHotkey(accelerator);
  if (res.ok) settings.set('hotkey', accelerator);
  return res;
});

ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('window:close', () => mainWindow && mainWindow.close());
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

/* ----------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', summon);

  app.whenReady().then(async () => {
    catalog.loadCache();
    syncCustom();
    if (IS_WIN32) activator = createAppxActivator(DATA_DIR, log);
    createWindow();

    const wanted = settings.get('hotkey');
    if (wanted) {
      const res = applyHotkey(wanted);
      if (!res.ok) log(`hotkey ${wanted} could not be registered: ${res.error}`, true);
    }

    catalog.ensure(false).catch((e) => {
      log('initial scan failed: ' + e.message, true);
      dialog.showErrorBox(
        'Stargate Command',
        'Could not read your installed programs.\n\n' + e.message
      );
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (activator) activator.stop();
    settings.flush();
  });

  app.on('window-all-closed', () => app.quit());
}

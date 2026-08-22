'use strict';
/*
 * Program discovery — macOS edition.
 *
 * Walks the application folders for .app bundles (the macOS equivalent of
 * Start Menu shortcuts), reading each one's Info.plist for the bundle
 * identifier, category and the flags that mark an agent as not-for-launching.
 * The results are cached so startup is instant after the first run.
 *
 * Like the Linux scanner this is pure Node — no shelling out to plutil,
 * mdfind or System Events, all of which are either slow per-bundle or subject
 * to privacy prompts. lib/plist.js reads the binary plists directly.
 *
 * Shared by electron/main.js — the data directory is injected because
 * Electron must write to userData rather than the install folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readPlist } = require('./plist');

// Entries that are almost never something you want to *launch*.
const JUNK_NAME = new RegExp(
  [
    '^uninstall',
    'uninstall(er)?$',
    '^read ?me',
    '^release notes',
    '^documentation$',
    '^docs$',
    '^user (guide|manual)',
    '^help$',
    '^licen[cs]e',
    '^website$',
    '^home ?page$',
    '^changelog',
    '^report (a )?(bug|problem)',
    '^send feedback',
    '^modify( setup)?$',
    '^repair',
    '^check for updates',
    '^what.s new',
    '^visit ',
    '^support$',
  ].join('|'),
  'i'
);

// How far to descend below an application folder. Bundles are commonly one
// level down (/Applications/Utilities, /Applications/Setapp, and the folder
// per suite that Adobe and Microsoft install), rarely two, never more.
const MAX_DEPTH = 2;

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.(lnk|url|exe|desktop|app)$/i, '')
    .replace(/\s*\((x64|x86|64[- ]bit|32[- ]bit)\)\s*/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/*
 * The directories that hold .app bundles, highest precedence first. A bundle
 * found in a higher-precedence directory wins over one of the same name lower
 * down, so a user's own copy shadows the system one.
 */
function applicationDirs(home) {
  return [
    { path: path.join(home, 'Applications'), rank: 3 },
    { path: '/Applications', rank: 2 },
    { path: '/System/Applications', rank: 1 },
    // Screen Sharing, Directory Utility and friends live here. The rest of
    // CoreServices is deliberately skipped: it is full of things like Dock.app
    // and SystemUIServer.app that are not yours to launch.
    { path: '/System/Library/CoreServices/Applications', rank: 1 },
  ];
}

/* ----------------------------------------------------------- Info.plist */

function isTruthy(v) {
  if (v === true) return true;
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

/*
 * "public.app-category.developer-tools" is not a label anybody wants to read.
 * The last component, spaced and capitalised, is — and it lines up with the
 * freedesktop category the Linux scanner puts in the same field.
 */
function prettyCategory(uti) {
  const raw = String(uti || '').trim();
  if (!raw) return '';
  const tail = raw.split('.').pop();
  if (!tail) return '';
  return tail
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/*
 * Turn a bundle on disk into a catalog record, or return null if it should not
 * be listed.
 *
 * The displayed name is the bundle's *filename*, not CFBundleName, because
 * that is what the Finder shows and therefore what people search for.
 * CFBundleName is capped at fifteen characters by an old convention and is
 * routinely wrong for exactly the apps you reach for most — Visual Studio
 * Code calls itself "Code", IntelliJ IDEA calls itself "idea". Info.plist is
 * consulted for everything else, and only as a name of last resort.
 */
function entryFromBundle(bundlePath, rank) {
  const base = path.basename(bundlePath);
  if (!/\.app$/i.test(base)) return null;

  const info = readPlist(path.join(bundlePath, 'Contents', 'Info.plist'));

  if (info) {
    // Background agents and menu-bar-only helpers are not launchable targets.
    if (isTruthy(info.LSUIElement) || isTruthy(info.LSBackgroundOnly)) return null;
    // A bundle that says it is not an application is taken at its word.
    const type = info.CFBundlePackageType;
    if (typeof type === 'string' && type.trim() && type.trim() !== 'APPL') return null;
  }

  let name = base.replace(/\.app$/i, '').trim();
  if (!name && info) {
    const fallback = info.CFBundleDisplayName || info.CFBundleName;
    if (typeof fallback === 'string') name = fallback.trim();
  }
  if (!name || JUNK_NAME.test(name)) return null;

  const key = normalizeName(name);
  if (!key) return null;

  const bundleId = info && typeof info.CFBundleIdentifier === 'string'
    ? info.CFBundleIdentifier.trim()
    : '';

  return {
    name,
    key,
    kind: 'app',
    appPath: bundlePath,
    bundleId,
    // The icon store resolves this straight from the bundle, so the path is
    // the only hint it needs — there is no equivalent of Icon= to look up.
    icon: bundlePath,
    group: prettyCategory(info && info.LSApplicationCategoryType),
    rank,
  };
}

/* ----------------------------------------------------------- scanning */

/*
 * Collect bundles under one application folder.
 *
 * A .app is itself a directory, and a large one usually contains helper
 * bundles (Contents/Frameworks/… .app, login items, crash reporters), so a
 * bundle is recorded and never descended into. `seen` holds resolved paths so
 * a symlinked folder — Homebrew and Setapp both make them — cannot send the
 * walk round in a circle.
 */
function scanDirectory(dir, out, rank, seen, depth) {
  if (depth > MAX_DEPTH) return;

  let real;
  try {
    real = fs.realpathSync(dir);
  } catch (_) {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);

    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch (_) {
        continue; // dangling symlink
      }
    }
    if (!isDir) continue;

    if (/\.app$/i.test(e.name)) {
      let entry;
      try {
        entry = entryFromBundle(full, rank);
      } catch (_) {
        continue;
      }
      if (entry) out.push(entry);
      continue; // never walk inside a bundle
    }

    scanDirectory(full, out, rank, seen, depth + 1);
  }
}

function createCatalog(dataDir, options) {
  const opts = options || {};
  const maxAgeMs = opts.maxAgeMs || 1000 * 60 * 60 * 12;
  const cacheFile = path.join(dataDir, 'catalog.json');
  const usageFile = path.join(dataDir, 'usage.json');
  const home = os.homedir();

  // Scanned entries and hand-added ones are kept apart and merged into
  // `apps` on every change, because ids are indexes into the merged list.
  let scanned = [];
  let customList = [];
  let apps = [];
  let scannedAt = 0;
  let usage = {};

  function rebuild() {
    apps = [...scanned, ...customList].sort((a, b) => a.name.localeCompare(b.name));
    apps.forEach((a, i) => (a.id = i));
  }

  try {
    usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')) || {};
  } catch (_) {
    usage = {};
  }

  function loadCache() {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && Array.isArray(c.apps) && c.apps.length) {
        scanned = c.apps;
        scannedAt = c.scannedAt || 0;
        rebuild();
        return true;
      }
    } catch (_) {
      /* no cache yet */
    }
    return false;
  }

  async function scan() {
    const found = [];
    const seen = new Set();
    for (const d of applicationDirs(home)) {
      scanDirectory(d.path, found, d.rank, seen, 0);
    }

    // Collapse by key; higher-ranked sources (the user's own copy) win.
    const byKey = new Map();
    for (const entry of found) {
      const existing = byKey.get(entry.key);
      if (!existing || entry.rank > existing.rank) byKey.set(entry.key, entry);
    }

    scanned = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
    scanned.forEach((e) => delete e.rank);
    scannedAt = Date.now();
    rebuild();

    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ apps: scanned, scannedAt }), 'utf8');
    } catch (_) {
      /* cache is best-effort */
    }
    return apps;
  }

  /** Replace the hand-added entries and re-merge. */
  function setCustom(list) {
    customList = (list || []).map((e) => ({
      name: e.name,
      key: normalizeName(e.name),
      launchPath: e.launchPath,
      target: e.target || '',
      args: e.args || '',
      workDir: e.workDir || '',
      group: '',
      kind: e.kind,
      custom: true,
      customId: e.id,
    }));
    rebuild();
    return apps;
  }

  async function ensure(force) {
    const stale = Date.now() - scannedAt > maxAgeMs;
    if (force || !scanned.length || stale) {
      try {
        await scan();
      } catch (e) {
        if (!scanned.length) throw e;
      }
    }
    return apps;
  }

  function recordUsage(key) {
    const u = usage[key] || { count: 0, last: 0 };
    u.count += 1;
    u.last = Date.now();
    usage[key] = u;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(usageFile, JSON.stringify(usage), 'utf8');
    } catch (_) {
      /* best-effort */
    }
  }

  /**
   * The shape the renderer wants — no filesystem paths leave the backend.
   *
   * Hidden entries are marked rather than removed: ids are indexes into this
   * same array, so dropping them would renumber everything, and the renderer
   * needs to be able to list them again to offer a restore.
   */
  function toClientList(opts) {
    const o = opts || {};
    const hide = o.hidden || new Set();
    const icon = o.icon || (() => null);
    // A user-set address overrides the one derived from the name.
    const addressOf = (k) => (o.address && o.address[k]) || null;
    return {
      scannedAt,
      apps: apps.map((a) => ({
        id: a.id,
        name: a.name,
        key: a.key,
        address: addressOf(a.key),
        group: a.group,
        kind: a.kind,
        use: usage[a.key] || null,
        hidden: hide.has(a.key),
        custom: !!a.custom,
        icon: icon(a.key),
      })),
    };
  }

  return {
    scan,
    ensure,
    loadCache,
    setCustom,
    recordUsage,
    toClientList,
    get apps() {
      return apps;
    },
    get scannedAt() {
      return scannedAt;
    },
  };
}

module.exports = {
  createCatalog,
  normalizeName,
  // Exposed for tests.
  _internals: {
    applicationDirs,
    entryFromBundle,
    scanDirectory,
    prettyCategory,
    isTruthy,
    MAX_DEPTH,
  },
};

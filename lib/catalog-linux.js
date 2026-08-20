'use strict';
/*
 * Program discovery — Linux/KDE (freedesktop) edition.
 *
 * Walks the XDG application directories for .desktop files (the Linux
 * equivalent of Start Menu shortcuts), reading each one's Name, Exec, Icon,
 * Categories and Terminal flag. The results are cached so startup is instant
 * after the first run.
 *
 * This is a pure-Node replacement for the Windows PowerShell scanner: no
 * shelling out to anything. Flatpak and Snap exports are picked up from their
 * standard locations, and a user-local .desktop file shadows a system one of
 * the same name, exactly as the desktop's own menu does.
 *
 * Shared by electron/main.js — the data directory is injected because
 * Electron must write to userData rather than the install folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.(lnk|url|exe|desktop)$/i, '')
    .replace(/\s*\((x64|x86|64[- ]bit|32[- ]bit)\)\s*/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/*
 * The directories that hold .desktop files, highest precedence first. A file
 * found in a higher-precedence directory wins over one of the same name lower
 * down, mirroring how the desktop's own menu resolves collisions.
 */
function applicationDirs(home) {
  const dirs = [];
  const add = (p, rank) => dirs.push({ path: p, rank });

  const xdgDataHome = process.env.XDG_DATA_HOME
    ? path.resolve(process.env.XDG_DATA_HOME)
    : path.join(home, '.local', 'share');

  // Per-user overrides (rank 3).
  add(path.join(xdgDataHome, 'applications'), 3);
  add(path.join(xdgDataHome, 'flatpak', 'exports', 'share', 'applications'), 3);

  // System-wide exports from sandboxes (rank 2).
  add('/var/lib/flatpak/exports/share/applications', 2);
  add('/var/lib/snapd/desktop/applications', 2);
  add('/var/lib/snapd/desktop', 2);

  // System directories (rank 1).
  const xdgDataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .filter(Boolean);
  for (const d of xdgDataDirs) add(path.join(d, 'applications'), 1);

  return dirs;
}

/* ----------------------------------------------------------- INI parsing */

/*
 * A .desktop file is an INI file. We only care about [Desktop Entry], but the
 * format is shared, so parse every section into a map of key -> value and pull
 * what we need. Values may be quoted; the quotes are stripped.
 */
function parseDesktopFile(text) {
  const sections = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sec[1];
      sections[current] = sections[current] || {};
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1);
    }
    sections[current][key] = val;
  }
  return sections;
}

/* ----------------------------------------------------------- locale */

function localeName(entry) {
  const lang = (process.env.LANG || process.env.LC_ALL || '').split('.')[0];
  const parts = lang.split('_');
  const candidates = [];
  if (lang) candidates.push('Name[' + lang + ']');
  if (parts.length === 2) candidates.push('Name[' + parts[0] + ']');
  candidates.push('Name');
  for (const c of candidates) {
    const v = entry[c];
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/* ----------------------------------------------------------- scanning */

function isTruthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || '').trim());
}

function fileIsExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function findOnPath(bin) {
  if (!bin) return false;
  if (bin.includes('/')) return fs.existsSync(bin);
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    if (fileIsExecutable(p)) return true;
  }
  return false;
}

/*
 * Turn a parsed [Desktop Entry] into a catalog record, or return null if it
 * should not be listed (not an application, hidden, or missing an Exec).
 */
function entryFromFile(filePath, entry) {
  const type = entry.Type || '';
  if (type && type !== 'Application') return null;
  if (isTruthy(entry.NoDisplay) || isTruthy(entry.Hidden)) return null;

  const name = localeName(entry);
  if (!name || JUNK_NAME.test(name)) return null;

  const exec = String(entry.Exec || '').trim();
  if (!exec) return null;

  // A TryExec that is an absolute path and absent means the binary is gone.
  const tryExec = String(entry.TryExec || '').trim();
  if (tryExec && tryExec.includes('/') && !fs.existsSync(tryExec)) return null;

  const key = normalizeName(name);
  if (!key) return null;

  const categories = String(entry.Categories || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const group = categories.length ? categories[0] : '';

  return {
    name,
    key,
    kind: 'desktop',
    desktopPath: filePath,
    exec,
    icon: String(entry.Icon || '').trim(),
    terminal: isTruthy(entry.Terminal),
    group,
  };
}

function scanDirectory(dir, out, rank) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('.desktop')) continue;
    const full = path.join(dir, n);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!stat.isFile()) continue;

    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (_) {
      continue;
    }
    let entry;
    try {
      entry = entryFromFile(full, (parseDesktopFile(text)['Desktop Entry']) || {});
    } catch (_) {
      continue;
    }
    if (entry) {
      entry.rank = rank;
      out.push(entry);
    }
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
    for (const d of applicationDirs(home)) {
      scanDirectory(d.path, found, d.rank);
    }

    // Collapse by key; higher-ranked sources (user-local) win.
    const byKey = new Map();
    for (const entry of found) {
      const existing = byKey.get(entry.key);
      if (!existing) {
        byKey.set(entry.key, entry);
      } else if (entry.rank > existing.rank) {
        byKey.set(entry.key, entry);
      }
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
    return {
      scannedAt,
      apps: apps.map((a) => ({
        id: a.id,
        name: a.name,
        key: a.key,
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
    parseDesktopFile,
    entryFromFile,
    localeName,
    findOnPath,
  },
};

'use strict';
/*
 * Program icons — Linux (freedesktop) edition.
 *
 * A launcher that shows only text is doing half a job, so each catalog entry
 * gets its real icon. On Linux the icon comes from the entry's Icon= field,
 * which is resolved against the freedesktop icon themes and pixmaps dirs.
 *
 * The lookup is pure filesystem work: the icon directories are walked once
 * into an index, then each name resolves in O(1). PNGs are resized to 32px
 * with Electron's nativeImage (which decodes PNG natively); SVGs are shipped
 * straight to the renderer as data URIs, because Chromium renders SVG <img>
 * sources directly and the CSP already permits data: images.
 *
 * Results are cached as data URIs in icons.json, keyed by catalog key, so a
 * compromised renderer never needs to read the filesystem.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// nativeImage exists only in the Electron main process; load it lazily so the
// lookup helpers can be exercised headlessly in tests.
let nativeImage = null;
function getNativeImage() {
  if (!nativeImage) nativeImage = require('electron').nativeImage;
  return nativeImage;
}

const IMAGE_EXT = /\.(png|svg|xpm|jpg|jpeg)$/i;

function extOf(name) {
  const m = IMAGE_EXT.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** The directories that hold icon themes and standalone pixmaps. */
function iconSearchDirs() {
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME
    ? path.resolve(process.env.XDG_DATA_HOME)
    : path.join(home, '.local', 'share');
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .filter(Boolean);

  const dirs = [path.join(dataHome, 'icons')];
  for (const d of dataDirs) dirs.push(path.join(d, 'icons'));
  dirs.push(path.join(dataHome, 'pixmaps'));
  for (const d of dataDirs) dirs.push(path.join(d, 'pixmaps'));
  return dirs;
}

/** Roughly how big a source icon is, from any NxN directory component. */
function sizeHint(p) {
  const m = /(\d{2,4})x(\d{2,4})/.exec(p);
  if (m) return Math.max(Number(m[1]), Number(m[2]));
  return 0;
}

/*
 * Walk the icon directories once and index every image by its basename
 * (extension stripped). For each name we keep the best PNG and, failing that,
 * an SVG. Larger PNGs are preferred because they downscale crisply.
 */
function buildIconIndex(dirs) {
  const index = new Map(); // basename -> { png: path, svg: path, xpm: path }
  function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const ext = extOf(e.name);
      if (!ext) continue;
      const base = e.name.slice(0, e.name.length - ext.length - 1);
      let rec = index.get(base);
      if (!rec) {
        rec = { png: null, svg: null, xpm: null };
        index.set(base, rec);
      }
      if (ext === 'png' && (!rec.png || sizeHint(full) > sizeHint(rec.png))) {
        rec.png = full;
      } else if (ext === 'svg' && !rec.svg) {
        rec.svg = full;
      } else if ((ext === 'xpm' || ext === 'jpg' || ext === 'jpeg') && !rec.xpm) {
        rec.xpm = full;
      }
    }
  }
  for (const d of dirs) walk(d, 0);
  return index;
}

/** Resolve an Icon= value to a filesystem path, or null. */
function resolveIcon(iconName, index) {
  if (!iconName) return null;
  if (iconName.startsWith('/')) {
    return fs.existsSync(iconName) ? iconName : null;
  }
  // If it carries an extension, strip it for the index key.
  const base = iconName.replace(IMAGE_EXT, '');
  const rec = index.get(base) || index.get(iconName);
  if (!rec) return null;
  return rec.png || rec.svg || rec.xpm || null;
}

function createIconStore(dataDir, log) {
  const say = log || (() => {});
  const iconFile = path.join(dataDir, 'icons.json');
  const missFile = path.join(dataDir, 'icon-misses.json');

  let icons = {};
  let misses = new Set(); // catalog keys whose icon could not be resolved
  let running = false;

  try {
    icons = JSON.parse(fs.readFileSync(iconFile, 'utf8')) || {};
  } catch (_) {
    icons = {};
  }

  try {
    const m = JSON.parse(fs.readFileSync(missFile, 'utf8'));
    if (Array.isArray(m)) misses = new Set(m);
  } catch (_) {
    misses = new Set();
  }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(iconFile, JSON.stringify(icons), 'utf8');
    } catch (_) {
      /* best-effort */
    }
  }

  function saveMisses() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(missFile, JSON.stringify([...misses]), 'utf8');
    } catch (_) {
      /* best-effort */
    }
  }

  function encodeImage(filePath) {
    if (/\.svg$/i.test(filePath)) {
      try {
        return 'data:image/svg+xml;base64,' + fs.readFileSync(filePath).toString('base64');
      } catch (_) {
        return null;
      }
    }
    try {
      const img = getNativeImage().createFromPath(filePath);
      if (img.isEmpty()) return null;
      return img.resize({ width: 32, height: 32, quality: 'good' }).toDataURL();
    } catch (_) {
      return null;
    }
  }

  /**
   * Resolve icons for anything not already cached.
   * @param {Array} apps catalog entries
   * @param {boolean} force retry entries previously recorded as missing
   * @returns {Promise<number>} how many were added
   */
  function refresh(apps, force) {
    if (running) return Promise.resolve(0);
    running = true;

    // A force (manual rescan) retries entries we previously gave up on.
    if (force) misses.clear();

    const wanted = apps.filter(
      (a) => a.icon && !icons[a.key] && (force || !misses.has(a.key))
    );
    if (!wanted.length) {
      running = false;
      return Promise.resolve(0);
    }

    return Promise.resolve().then(() => {
      const index = buildIconIndex(iconSearchDirs());
      let added = 0;
      let missed = 0;
      for (const a of wanted) {
        const p = resolveIcon(a.icon, index);
        if (!p) {
          // Remember the miss so the next launch doesn't pay for the walk
          // again only to arrive at the same null.
          misses.add(a.key);
          missed++;
          continue;
        }
        const uri = encodeImage(p);
        if (uri) {
          icons[a.key] = uri;
          added++;
        } else {
          misses.add(a.key);
          missed++;
        }
      }
      if (added) save();
      if (missed) saveMisses();
      say('icons: ' + added + ' of ' + wanted.length + ' resolved, ' + missed + ' cached as missing');
      return added;
    }).then((added) => {
      running = false;
      return added;
    });
  }

  /** Forget icons for entries no longer in the catalog. */
  function prune(apps) {
    const live = new Set(apps.map((a) => a.key));
    let removed = 0;
    for (const k of Object.keys(icons)) {
      if (!live.has(k)) {
        delete icons[k];
        removed++;
      }
    }
    if (removed) save();

    // Drop miss entries for keys no longer in the catalog.
    let missRemoved = 0;
    for (const k of misses) {
      if (!live.has(k)) {
        misses.delete(k);
        missRemoved++;
      }
    }
    if (missRemoved) saveMisses();
    return removed;
  }

  return {
    get: (key) => icons[key] || null,
    refresh,
    prune,
    all: () => icons,
    get busy() {
      return running;
    },
  };
}

module.exports = {
  createIconStore,
  _internals: {
    iconSearchDirs,
    buildIconIndex,
    resolveIcon,
    sizeHint,
  },
};

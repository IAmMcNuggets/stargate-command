'use strict';
/*
 * Program icons — macOS edition.
 *
 * A launcher that shows only text is doing half a job, so each catalog entry
 * gets its real icon. macOS is the easy case of the three: Launch Services
 * already knows every bundle's icon, and Electron exposes that as
 * app.getFileIcon(), so there is no .icns to decode and no theme index to
 * build. It also means a hand-added document or folder gets the same icon the
 * Finder would draw for it, for free.
 *
 * Results are cached as data URIs in icons.json, keyed by catalog key, so a
 * compromised renderer never needs to read the filesystem.
 */

const fs = require('fs');
const path = require('path');

// The electron module exists only in the main process; load it lazily so the
// helpers below can be exercised headlessly in tests.
let electron = null;
function getElectron() {
  if (!electron) electron = require('electron');
  return electron;
}

// Launch Services answers quickly, but a few hundred bundles still add up.
// Enough parallelism to hide the latency, not enough to stampede it.
const CONCURRENCY = 8;

/** The file whose icon represents this entry, or null if it has no file. */
function iconSourceOf(entry) {
  if (!entry) return null;
  // A link or a remote host is not a file, so there is nothing to ask about.
  if (entry.kind === 'url' || entry.kind === 'remote') return null;
  const p = entry.appPath || entry.launchPath;
  return typeof p === 'string' && p ? p : null;
}

/** Run an async worker over items, at most `limit` in flight. */
async function mapLimit(items, limit, worker) {
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
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

  /** Ask Launch Services for one icon and encode it for the renderer. */
  async function encodeIcon(filePath) {
    try {
      const img = await getElectron().app.getFileIcon(filePath, { size: 'normal' });
      if (!img || img.isEmpty()) return null;
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
  async function refresh(apps, force) {
    if (running) return 0;
    running = true;

    try {
      // A force (manual rescan) retries entries we previously gave up on.
      if (force) misses.clear();

      const wanted = (apps || []).filter(
        (a) => iconSourceOf(a) && !icons[a.key] && (force || !misses.has(a.key))
      );
      if (!wanted.length) return 0;

      let added = 0;
      let missed = 0;

      await mapLimit(wanted, CONCURRENCY, async (a) => {
        const uri = await encodeIcon(iconSourceOf(a));
        if (uri) {
          icons[a.key] = uri;
          added++;
        } else {
          // Remember the miss so the next launch doesn't ask again only to
          // arrive at the same null.
          misses.add(a.key);
          missed++;
        }
      });

      if (added) save();
      if (missed) saveMisses();
      say(
        'icons: ' + added + ' of ' + wanted.length + ' resolved, ' + missed + ' cached as missing'
      );
      return added;
    } finally {
      running = false;
    }
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
    iconSourceOf,
    mapLimit,
  },
};

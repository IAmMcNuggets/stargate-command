'use strict';
/*
 * Small JSON store in the app's data directory: window bounds, the global
 * hotkey, and the set of registry entries the user has hidden.
 *
 * Owned by the main process. The renderer never touches it directly — it asks
 * over IPC — so a compromised window cannot rewrite arbitrary settings.
 */

const fs = require('fs');
const path = require('path');

// Control+Alt is the Windows and Linux idiom. macOS reaches for Command+Option
// instead, and Control there is the modifier the system itself claims, so a
// new install on a Mac gets the shortcut a Mac user would expect. Anyone who
// already has a hotkey saved keeps it.
const DEFAULT_HOTKEY = process.platform === 'darwin' ? 'Command+Alt+G' : 'Control+Alt+G';

const DEFAULTS = {
  hotkey: DEFAULT_HOTKEY,
  bounds: null, // { x, y, width, height, maximized }
  hidden: [], // catalog keys the user has hidden
  custom: [], // destinations the user added by hand
  addresses: {}, // catalog key -> glyph indexes, overriding the derived address
};

// A glyph index is 1..38: 0 is the point of origin, which closes every address
// and is appended rather than chosen.
const MAX_GLYPH = 38;

/**
 * Validate an address the renderer asked to store.
 *
 * This is the trust boundary. Six glyphs is a seven-chevron address and eight
 * is a nine-chevron one; anything else, out of range, repeated or not a whole
 * number is refused rather than written and tripped over later.
 */
function validAddress(glyphs) {
  if (!Array.isArray(glyphs)) return false;
  if (glyphs.length !== 6 && glyphs.length !== 8) return false;
  const seen = new Set();
  for (const g of glyphs) {
    if (!Number.isInteger(g) || g < 1 || g > MAX_GLYPH) return false;
    if (seen.has(g)) return false;
    seen.add(g);
  }
  return true;
}

function createSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  let data = { ...DEFAULTS };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') data = { ...DEFAULTS, ...raw };
    if (!Array.isArray(data.hidden)) data.hidden = [];
    if (!Array.isArray(data.custom)) data.custom = [];
    if (!data.addresses || typeof data.addresses !== 'object') data.addresses = {};
    // Drop anything hand-edited into an invalid state rather than serving it.
    for (const k of Object.keys(data.addresses)) {
      if (!validAddress(data.addresses[k])) delete data.addresses[k];
    }
  } catch (_) {
    /* first run */
  }

  let saveTimer = null;
  function save() {
    // Debounced: window resize fires continuously while dragging.
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      } catch (_) {
        /* best-effort */
      }
    }, 400);
  }

  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {
      /* best-effort */
    }
  }

  return {
    get: (k) => data[k],
    set(k, v) {
      data[k] = v;
      save();
    },
    hiddenSet: () => new Set(data.hidden),
    addressMap: () => ({ ...data.addresses }),
    setAddress(key, glyphs) {
      if (!key || !validAddress(glyphs)) return false;
      data.addresses[key] = glyphs.slice();
      save();
      return true;
    },
    clearAddress(key) {
      if (!(key in data.addresses)) return false;
      delete data.addresses[key];
      save();
      return true;
    },
    customList: () => data.custom.slice(),
    addCustom(entry) {
      data.custom.push(entry);
      save();
    },
    removeCustom(id) {
      const i = data.custom.findIndex((c) => c.id === id);
      if (i >= 0) {
        data.custom.splice(i, 1);
        save();
      }
      return i >= 0;
    },
    hide(key) {
      if (!data.hidden.includes(key)) {
        data.hidden.push(key);
        save();
      }
    },
    unhide(key) {
      const i = data.hidden.indexOf(key);
      if (i >= 0) {
        data.hidden.splice(i, 1);
        save();
      }
    },
    flush,
  };
}

module.exports = { createSettings, DEFAULTS, DEFAULT_HOTKEY, validAddress };

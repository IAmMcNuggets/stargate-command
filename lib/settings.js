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

const DEFAULTS = {
  hotkey: 'Control+Alt+G',
  bounds: null, // { x, y, width, height, maximized }
  hidden: [], // catalog keys the user has hidden
  custom: [], // destinations the user added by hand
};

function createSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  let data = { ...DEFAULTS };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') data = { ...DEFAULTS, ...raw };
    if (!Array.isArray(data.hidden)) data.hidden = [];
    if (!Array.isArray(data.custom)) data.custom = [];
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

module.exports = { createSettings, DEFAULTS };

'use strict';
/*
 * The only bridge between the gate and the machine.
 *
 * Deliberately narrow: the renderer can ask for the catalog, launch something
 * *by id*, hide/unhide *by id*, set a hotkey, and drive its own window. It
 * cannot pass a path, so a compromised renderer still can't run anything that
 * isn't already in the catalog the main process built.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gateHost', {
  platform: 'electron',

  getCatalog: () => ipcRenderer.invoke('catalog:get'),
  rescan: () => ipcRenderer.invoke('catalog:rescan'),
  launch: (id) => ipcRenderer.invoke('gate:launch', id),
  hide: (id) => ipcRenderer.invoke('catalog:hide', id),
  unhide: (id) => ipcRenderer.invoke('catalog:unhide', id),
  addCustom: (entry) => ipcRenderer.invoke('catalog:addCustom', entry),
  removeCustom: (id) => ipcRenderer.invoke('catalog:removeCustom', id),
  pickTarget: () => ipcRenderer.invoke('dialog:pickTarget'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setHotkey: (accelerator) => ipcRenderer.invoke('settings:setHotkey', accelerator),
  setAddress: (id, glyphs) => ipcRenderer.invoke('settings:setAddress', id, glyphs),
  clearAddress: (id) => ipcRenderer.invoke('settings:clearAddress', id),

  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),

  // Fired when the global hotkey brings the window up, so the renderer can
  // put the caret back in the search box.
  onSummon: (fn) => ipcRenderer.on('gate:summoned', () => fn()),

  // Fired when background work (icon extraction) has changed the catalog.
  onCatalogUpdated: (fn) => ipcRenderer.on('catalog:updated', (_e, data) => fn(data)),
});

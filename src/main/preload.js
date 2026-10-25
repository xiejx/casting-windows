'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cast', {
  getStatus: () => ipcRenderer.invoke('app:status'),
  saveConfig: (config) => ipcRenderer.invoke('app:save-config', config),
  openFirewall: () => ipcRenderer.invoke('app:open-firewall'),
  getCacheInfo: () => ipcRenderer.invoke('app:cache-info'),
  clearCache: () => ipcRenderer.invoke('app:clear-cache'),
  openCacheDir: () => ipcRenderer.invoke('app:open-cache-dir'),
  quit: () => ipcRenderer.send('app:quit'),
  updatePlayer: (name, data) => ipcRenderer.send('player:event', { name, data }),
  onCommand: (handler) => {
    const listener = (event, command) => handler(command);
    ipcRenderer.on('player:command', listener);
    return () => ipcRenderer.removeListener('player:command', listener);
  },
  onStatus: (handler) => {
    const listener = (event, status) => handler(status);
    ipcRenderer.on('device:status', listener);
    return () => ipcRenderer.removeListener('device:status', listener);
  },
  onLog: (handler) => {
    const listener = (event, entry) => handler(entry);
    ipcRenderer.on('device:log', listener);
    return () => ipcRenderer.removeListener('device:log', listener);
  },
});

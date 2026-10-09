'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rmmDesk', {
  isDesktop: true,
  platform: process.platform,
  appInfo: () => ipcRenderer.invoke('app-info'),
  update: {
    state: () => ipcRenderer.invoke('update-state'),
    check: () => ipcRenderer.invoke('update-check'),
    install: () => ipcRenderer.invoke('update-install'),
    onState: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on('update-state', h);
      return () => ipcRenderer.removeListener('update-state', h);
    },
  },
});

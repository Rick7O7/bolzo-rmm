'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rmmDesk', {
  isDesktop: true,
  platform: process.platform,
  appInfo: () => ipcRenderer.invoke('app-info'),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    state: () => ipcRenderer.invoke('win:state'),
    onState: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on('win-state', h);
      return () => ipcRenderer.removeListener('win-state', h);
    },
  },
  openConsole: (g) => ipcRenderer.send('open-console', g),
  netWeb: (o) => ipcRenderer.invoke('net-web', o),
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

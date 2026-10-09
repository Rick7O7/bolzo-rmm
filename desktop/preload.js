'use strict';
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('rmmDesk', {
  isDesktop: true,
  platform: process.platform,
});

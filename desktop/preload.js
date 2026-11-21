// The only bridge between the COVAL web app and Windows. The web app checks for
// `window.covalDesktop` and uses it for notifications and local scans.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("covalDesktop", {
  platform: process.platform,
  notify: (notification) => ipcRenderer.invoke("coval:notify", notification),
  setUnread: (count) => ipcRenderer.send("coval:unread", count),
  scanFolder: () => ipcRenderer.invoke("coval:scan-folder"),
  onNavigate: (callback) => subscribe("coval:navigate", callback),
  onScanResult: (callback) => subscribe("coval:scan-result", callback),
});

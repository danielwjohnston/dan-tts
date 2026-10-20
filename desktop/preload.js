// The only bridge between the window and the main process: downloading a URL.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('danDesktop', {
  fetch: (url) => ipcRenderer.invoke('dan:fetch', url),
});

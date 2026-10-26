// The only bridge between the window and the main process: fetching a URL (a page or PDF
// download, or a call to the voice server; GET, or POST with a small JSON body).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('danDesktop', {
  fetch: (url, init) => ipcRenderer.invoke('dan:fetch', url, init),
});

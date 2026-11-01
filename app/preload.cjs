// The only desktop features the page can reach.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('smi', {
  pick: kind => ipcRenderer.invoke('pick', kind),
  pathOf: file => webUtils.getPathForFile(file),
  openReleases: () => ipcRenderer.invoke('open-releases'),
});

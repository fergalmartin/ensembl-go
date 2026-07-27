const { contextBridge, ipcRenderer } = require('electron');

let backendRuntimeSnapshot = null;

try {
  backendRuntimeSnapshot = ipcRenderer.sendSync('backend:getRuntimeSync');
} catch {
  backendRuntimeSnapshot = null;
}

let electronConfigSnapshot = null;

try {
  electronConfigSnapshot = ipcRenderer.sendSync('config:loadSync');
} catch {
  electronConfigSnapshot = null;
}

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (defaultPath) => ipcRenderer.invoke('dialog:openFile', defaultPath),
  saveFile: (defaultPath) => ipcRenderer.invoke('dialog:saveFile', defaultPath),
  selectDirectory: (defaultPath) => ipcRenderer.invoke('dialog:openDirectory', defaultPath),
  getDesktopPath: () => ipcRenderer.invoke('app:getDesktopPath'),
  captureHtmlSnapshot: (payload) => ipcRenderer.invoke('screenshot:captureHtmlSnapshot', payload),
  getBackendRuntimeSnapshot: () => backendRuntimeSnapshot,
  getBackendRuntimeStatus: async () => {
    const nextSnapshot = await ipcRenderer.invoke('backend:getRuntimeStatus');
    backendRuntimeSnapshot = nextSnapshot;
    return nextSnapshot;
  },
  getApiBase: () => backendRuntimeSnapshot?.apiBase || null,
  getApiToken: () => backendRuntimeSnapshot?.apiToken || null,
  retryBackendCheck: async () => {
    const nextSnapshot = await ipcRenderer.invoke('backend:retry-check');
    backendRuntimeSnapshot = nextSnapshot;
    return nextSnapshot;
  },
  retryBackendLaunch: async () => {
    const nextSnapshot = await ipcRenderer.invoke('backend:retry-launch');
    backendRuntimeSnapshot = nextSnapshot;
    return nextSnapshot;
  },
  onBackendRuntimeStatus: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const listener = (_event, payload) => {
      backendRuntimeSnapshot = payload;
      callback(payload);
    };
    ipcRenderer.on('backend:status', listener);
    return () => {
      ipcRenderer.removeListener('backend:status', listener);
    };
  },
  isElectron: true,
  getElectronConfig: () => electronConfigSnapshot,
  saveElectronConfig: (config) => ipcRenderer.invoke('config:save', config),
});

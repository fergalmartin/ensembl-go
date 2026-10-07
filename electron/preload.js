const { contextBridge, ipcRenderer } = require('electron');

let backendRuntimeSnapshot = null;

try {
  backendRuntimeSnapshot = ipcRenderer.sendSync('backend:getRuntimeSync');
} catch {
  backendRuntimeSnapshot = null;
}

let launchId = '';

try {
  launchId = String(ipcRenderer.sendSync('app:getLaunchIdSync') || '');
} catch {
  launchId = '';
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
  onBackendSetupRequested: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('backend:open-setup', listener);
    return () => ipcRenderer.removeListener('backend:open-setup', listener);
  },
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
  // Which launch of the app this page belongs to. A reload keeps it; a relaunch does not.
  getLaunchId: () => launchId,
  // The machine is about to sleep or the screen is locking: the moment to note where
  // the reader is, in case the page reloads before they are back.
  onSystemSuspend: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('system:suspend', listener);
    return () => ipcRenderer.removeListener('system:suspend', listener);
  },
  isElectron: true,
  getElectronConfig: () => electronConfigSnapshot,
  saveElectronConfig: (config) => ipcRenderer.invoke('config:save', config),
});

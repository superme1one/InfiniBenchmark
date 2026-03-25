const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  runTest: (scriptName) => ipcRenderer.invoke('run-test', scriptName),
  stopTest: () => ipcRenderer.invoke('stop-test'),
  openResults: () => ipcRenderer.invoke('open-results'),
  onOutput: (cb) => ipcRenderer.on('output', (_, d) => cb(d)),
  onOutputErr: (cb) => ipcRenderer.on('output-err', (_, d) => cb(d)),
  onTestDone: (cb) => ipcRenderer.on('test-done', (_, code) => cb(code)),
  removeAll: (ch) => ipcRenderer.removeAllListeners(ch)
});

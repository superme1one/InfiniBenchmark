const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow;
let currentProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Windows端基准测试 GUI',
    backgroundColor: '#1e1e1e',
    show: false
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (currentProcess) currentProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('run-test', (event, scriptName) => {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
  }

  const scriptsDir = path.join(__dirname, '../jiuge_nvda');
  const scriptPath = path.join(scriptsDir, scriptName);

  currentProcess = spawn('node', [scriptPath], {
    cwd: scriptsDir,
    env: { ...process.env, FORCE_COLOR: '0' }
  });

  currentProcess.stdout.on('data', (data) => {
    if (mainWindow) mainWindow.webContents.send('output', data.toString());
  });

  currentProcess.stderr.on('data', (data) => {
    if (mainWindow) mainWindow.webContents.send('output-err', data.toString());
  });

  currentProcess.on('close', (code) => {
    currentProcess = null;
    if (mainWindow) mainWindow.webContents.send('test-done', code);
  });

  currentProcess.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('output-err', `启动失败: ${err.message}\n`);
    if (mainWindow) mainWindow.webContents.send('test-done', -1);
  });

  return { ok: true };
});

ipcMain.handle('stop-test', () => {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
    return { stopped: true };
  }
  return { stopped: false };
});

ipcMain.handle('open-results', () => {
  const candidateDirs = [
    path.join(__dirname, '../jiuge_nvda/result'),
    path.join(__dirname, '../jiuge_nvda/results')
  ];
  const resultsDir = candidateDirs.find((dir) => fs.existsSync(dir)) || candidateDirs[0];
  shell.openPath(resultsDir);
});

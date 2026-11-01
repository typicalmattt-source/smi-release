// Desktop shell: one window around the local backend, with native file dialogs.
// The backend stays on its fixed local port, because the Studio plugin reads builds from it.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let win = null;

const PICKERS = {
  map: { title: 'Open a map', properties: ['openFile'], filters: [{ name: 'Source maps and addons', extensions: ['bsp', 'vmf', 'gma'] }, { name: 'All files', extensions: ['*'] }] },
  content: { title: 'Add a content file', properties: ['openFile'], filters: [{ name: 'Source content', extensions: ['vpk', 'gma'] }, { name: 'All files', extensions: ['*'] }] },
  folder: { title: 'Add a content folder', properties: ['openDirectory'] },
};

// Passing the window makes the dialog belong to it, so it can't open hidden behind anything.
ipcMain.handle('pick', async (_, kind) => {
  const options = PICKERS[kind];
  if (!options || !win) return '';
  const r = await dialog.showOpenDialog(win, options);
  return r.canceled ? '' : r.filePaths[0] ?? '';
});

// A fixed address, so the page can never ask the app to open anything else.
ipcMain.handle('open-releases', () => shell.openExternal('https://github.com/typicalmattt-source/source-map-importer/releases/latest'));

async function createWindow(url) {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 900, minHeight: 600,
    title: 'Source Map Importer', backgroundColor: '#14161a', show: false,
    icon: path.join(HERE, 'icon.ico'),
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Dropping a file must never navigate the app away from its own page.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  await win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    process.env.SMI_DATA = path.join(app.getPath('documents'), 'SourceMapImporter');
    try {
      // Loaded here, so the backend sees SMI_DATA as it starts.
      const { startServer } = await import('../src/server.js');
      await createWindow(await startServer());
    } catch (e) {
      dialog.showErrorBox('Source Map Importer could not start', e.message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  session,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
} = require('electron');
const deepgramSession = require('./deepgramSession');
const openRouter = require('./openRouter');
const groq = require('./groq');

const isDev = !app.isPackaged;
const DEV_SERVER_URL = 'http://127.0.0.1:5173';
const TOGGLE_SHORTCUT = 'Control+Shift+M';
const ASK_AI_SHORTCUT = 'Shift+Enter';

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let isQuitting = false;
let screenCaptureInProgress = false;

// Windows uses SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) for this, which
// makes the overlay fully invisible to screen captures (Meet, Zoom, Teams,
// Discord). Protection can be lost across hide/re-show cycles, so it is
// re-applied every time the window is shown.
function applyContentProtection(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(true);
  } catch (error) {
    console.error('Failed to apply content protection:', error);
  }
}

function emitToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

async function captureScreenForAnswer() {
  if (screenCaptureInProgress) return;
  screenCaptureInProgress = true;
  const overlayWasVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  emitToRenderer('assistant:event', { type: 'capturing' });

  try {
    if (overlayWasVisible) {
      mainWindow.hide();
      // Give the desktop compositor a moment to expose the app beneath the overlay.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
    const scaleFactor = display.scaleFactor || 1;
    const screenWidth = Math.round(display.size.width * scaleFactor);
    const screenHeight = Math.round(display.size.height * scaleFactor);
    const sizeScale = Math.min(1, 1600 / screenWidth, 1000 / screenHeight);
    const thumbnailSize = {
      width: Math.max(1, Math.round(screenWidth * sizeScale)),
      height: Math.max(1, Math.round(screenHeight * sizeScale)),
    };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false,
    });
    const source =
      sources.find((candidate) => String(candidate.display_id) === String(display.id)) || sources[0];
    if (!source?.thumbnail || source.thumbnail.isEmpty()) {
      throw new Error('No screen image was returned by Electron.');
    }

    const imageDataUrl = `data:image/jpeg;base64,${source.thumbnail.toJPEG(72).toString('base64')}`;
    showOverlay();
    emitToRenderer('screen:capture', { imageDataUrl });
  } catch (error) {
    showOverlay();
    emitToRenderer('assistant:event', {
      type: 'error',
      message: `Screen capture failed: ${error?.message || String(error)}`,
    });
  } finally {
    screenCaptureInProgress = false;
  }
}

function createTrayIcon() {
  // 16×16 teal square PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR4nGNgGAWjYBSMglEwCkbBKBicgP///zMwMjL+Z2BgmDZt2v9RMCqIRsEoGAWjAABe0QQd2m1Q2QAAAABJRU5ErkJggg==',
    'base64',
  );
  const fromPng = nativeImage.createFromBuffer(png);
  if (!fromPng.isEmpty()) return fromPng;
  return nativeImage.createFromPath(process.execPath);
}

function showOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  applyContentProtection(mainWindow);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setSkipTaskbar(true);
  mainWindow.focus();
}

function hideOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  tray?.displayBalloon({
    title: 'MEETR',
    content: 'Overlay hidden. Click this tray icon or press Ctrl+Shift+M to show it again.',
  });
}

function toggleOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showOverlay();
    return;
  }
  if (mainWindow.isVisible()) {
    hideOverlay();
  } else {
    showOverlay();
  }
}

function createTray() {
  if (tray) return;

  tray = new Tray(createTrayIcon());
  tray.setToolTip('MEETR — Ctrl+Shift+M to show/hide');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show overlay', click: () => showOverlay() },
      { label: 'Hide overlay', click: () => hideOverlay() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => toggleOverlay());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 320,
    minHeight: 420,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Hide overlay from screen-sharing / capture tools (Zoom, Meet, Teams, Discord)
  applyContentProtection(mainWindow);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.on('show', () => applyContentProtection(mainWindow));
  mainWindow.on('restore', () => applyContentProtection(mainWindow));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    hideOverlay();
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideOverlay();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('window:minimize', () => {
    hideOverlay();
  });

  ipcMain.handle('window:close', async () => {
    isQuitting = true;
    await deepgramSession.stopSession();
    app.quit();
  });

  ipcMain.handle('screen:captureForAnswer', async () => {
    await captureScreenForAnswer();
  });

  ipcMain.handle('desktop:getLoopbackSource', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });

    if (!sources.length) {
      throw new Error('No screen sources available for loopback audio capture.');
    }

    const primary = sources[0];
    return { id: primary.id, name: primary.name };
  });

  ipcMain.handle('transcription:start', async () => {
    return deepgramSession.startSession((event) => {
      emitToRenderer('transcription:event', event);
    });
  });

  ipcMain.on('transcription:audio', (_event, chunk) => {
    deepgramSession.sendAudio(chunk);
  });

  ipcMain.handle('transcription:stop', async () => {
    await deepgramSession.stopSession();
  });

  ipcMain.handle('transcription:hasApiKey', () => Boolean(deepgramSession.getApiKey()));

  ipcMain.handle('groq:hasApiKey', () => Boolean(groq.getApiKey()));
  ipcMain.handle('groq:ask', async (event, payload) => {
    const requestId = payload?.requestId;
    const sendToken = (token) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send('assistant:token', { requestId, token });
    };
    return groq.answerFromTranscript(payload, sendToken);
  });

  ipcMain.handle('openrouter:hasApiKey', () => Boolean(openRouter.getApiKey()));
  ipcMain.handle('openrouter:ask', async (event, payload) => {
    const requestId = payload?.requestId;
    const sendToken = (token) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send('assistant:token', { requestId, token });
    };
    return openRouter.answerFromScreen(payload, sendToken);
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.meetr');

  // Belt-and-suspenders: protect any window created through any code path.
  app.on('browser-window-created', (_event, win) => applyContentProtection(win));

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture' || permission === 'mediaKeySystem') {
      callback(true);
      return;
    }
    callback(false);
  });

  registerIpc();
  createTray();
  createWindow();

  globalShortcut.register(TOGGLE_SHORTCUT, () => toggleOverlay());
  if (!globalShortcut.register(ASK_AI_SHORTCUT, captureScreenForAnswer)) {
    console.error(`Could not register global shortcut ${ASK_AI_SHORTCUT}.`);
  }

  app.on('activate', () => {
    showOverlay();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  deepgramSession.stopSession();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

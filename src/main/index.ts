import { app, BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions, net, protocol, shell, Tray } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from './ipc/database';
import { setMainWindow, setupIpcHandlers } from './ipc';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let rendererReloads = 0;
const MAX_RENDERER_RELOADS = 3;

const devServerArg = process.argv.find(arg => arg.startsWith('--dev-server-url='));
const devServerUrl = process.env['VITE_DEV_SERVER_URL'] || devServerArg?.slice('--dev-server-url='.length);

// 必须在 app.whenReady() 之前设置 userData 路径
if (devServerUrl) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');
  const devUserData = path.join(os.tmpdir(), 'ZoomlaXizhi-electron-dev-v2');
  fs.mkdirSync(devUserData, { recursive: true });
  app.setPath('userData', devUserData);
} else {
  const prodUserData = path.join(os.homedir(), '.ZoomlaXizhi');
  fs.mkdirSync(prodUserData, { recursive: true });
  app.setPath('userData', prodUserData);
}

// 读取硬件加速配置（默认关闭，确保稳定性）
let hardwareAccelEnabled = true;
try {
  const hwConfigPath = path.join(app.getPath('userData'), 'hardware.json');
  if (fs.existsSync(hwConfigPath)) {
    hardwareAccelEnabled = !!JSON.parse(fs.readFileSync(hwConfigPath, 'utf8')).hardwareAcceleration;
  }
} catch {
  hardwareAccelEnabled = true;
}

if (!hardwareAccelEnabled) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('in-process-gpu');
}

// 将硬件加速状态写入日志
appendRuntimeLog(`Hardware acceleration: ${hardwareAccelEnabled ? 'enabled' : 'disabled'}`);

function appendRuntimeLog(message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    const targets = new Set<string>();
    try {
      targets.add(path.join(app.getPath('userData'), 'runtime.log'));
    } catch {
      // app.getPath can fail very early during process startup.
    }
    if (process.execPath) {
      targets.add(path.join(path.dirname(process.execPath), 'runtime.log'));
    }
    for (const target of targets) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, line, 'utf8');
      } catch {
        // Try the next log target.
      }
    }
  } catch {
    // Logging must never be the reason startup fails.
  }
}

process.on('uncaughtException', error => {
  appendRuntimeLog(`uncaughtException: ${error.stack || error.message}`);
});

process.on('unhandledRejection', reason => {
  appendRuntimeLog(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});

app.on('child-process-gone', (_event, details) => {
  appendRuntimeLog(`Child process gone: ${JSON.stringify(details)}`);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // 注册字体文件协议 —— 避免 file:// 在 http:// 页面中跨域被拦截
    protocol.handle('zoomla-font', (request) => {
      const filePath = decodeURIComponent(request.url.slice('zoomla-font://'.length));
      return net.fetch(`file:///${filePath.replace(/\\/g, '/')}`);
    });
    await initDatabase();
    setupIpcHandlers();
    createMainWindow();
    setupTray();
    setupMenu();
  });
}

function createMainWindow(): void {
  rendererReloads = 0;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 960,
    minHeight: 720,
    show: false,
    icon: path.join(__dirname, '..', '..', '..', 'build', 'icon.ico'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  setMainWindow(mainWindow);

  // 开发模式：自动打开DevTools + F12切换
  if (devServerUrl) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'F12') {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  }

  appendRuntimeLog([
    `App starting. packaged=${app.isPackaged}`,
    `userData=${app.getPath('userData')}`,
    `resourcesPath=${process.resourcesPath}`,
    `versions=${JSON.stringify(process.versions)}`,
    `platform=${process.platform} ${os.release()}`,
  ].join(' | '));

  loadRenderer();

  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const rendererState = await mainWindow?.webContents.executeJavaScript(`({
        title: document.title,
        rootTextLength: document.getElementById('root')?.innerText?.length || 0,
        bodyText: document.body?.innerText?.slice(0, 120) || ''
      })`);
      console.log('Renderer mounted:', rendererState);
      appendRuntimeLog(`Renderer mounted: ${JSON.stringify(rendererState)}`);
    } catch (error: any) {
      appendRuntimeLog(`Renderer state probe failed: ${error?.stack || error?.message || String(error)}`);
    }
    mainWindow?.show();
    mainWindow?.maximize();
    mainWindow?.focus();
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`Renderer failed to load: ${code} ${description} ${url}`);
    appendRuntimeLog(`Renderer failed to load: ${code} ${description} ${url}`);
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`Renderer console [${level}] ${sourceId}:${line} ${message}`);
    appendRuntimeLog(`Renderer console [${level}] ${sourceId}:${line} ${message}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendRuntimeLog(`Renderer process gone: ${JSON.stringify(details)}`);
    console.error('Renderer process gone:', details);

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    if (rendererReloads < MAX_RENDERER_RELOADS) {
      rendererReloads += 1;
      appendRuntimeLog(`Reloading renderer after process gone. attempt=${rendererReloads}/${MAX_RENDERER_RELOADS}`);
      setTimeout(() => loadRenderer(), 500);
      return;
    }

    appendRuntimeLog('Renderer reload limit reached. Leaving window open for diagnostics.');
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(diagnosticHtml(details.reason || 'unknown'))}`);
  });

  mainWindow.on('unresponsive', () => {
    appendRuntimeLog('Main window became unresponsive');
  });

  mainWindow.on('responsive', () => {
    appendRuntimeLog('Main window became responsive');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function loadRenderer(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const loadPromise = devServerUrl
    ? mainWindow.loadURL(devServerUrl)
    : mainWindow.loadFile(path.join(__dirname, '../../renderer/src/renderer/index.html'));

  loadPromise.catch(error => {
    console.error('Renderer load promise failed:', error);
    appendRuntimeLog(`Renderer load promise failed: ${error?.stack || error?.message || String(error)}`);
  });
}

function diagnosticHtml(reason: string): string {
  const logHint = app.isPackaged
    ? `${path.dirname(process.execPath)}\\runtime.log`
    : path.join(app.getPath('userData'), 'runtime.log');
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>Renderer crashed</title>
<body style="margin:0;font-family:Microsoft YaHei,Segoe UI,sans-serif;background:#eef1f5;color:#1f2937;">
  <main style="padding:32px;line-height:1.8;">
    <h1 style="font-size:22px;margin:0 0 12px;">界面进程已崩溃</h1>
    <p>程序已尝试自动恢复 ${MAX_RENDERER_RELOADS} 次，但渲染进程仍然退出。</p>
    <p>原因：${escapeHtml(reason)}</p>
    <p>请查看日志：${escapeHtml(logHint)}</p>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('will-quit', () => {
  tray?.destroy();
  tray = null;
});

function setupTray(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icon.ico')
    : path.join(app.getAppPath(), 'build', 'icon.ico');

  try {
    tray = new Tray(iconPath);
  } catch (error) {
    console.warn('Tray icon unavailable:', error);
    return;
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '设置', click: () => mainWindow?.webContents.send('menu:settings') },
    { label: '日志', click: () => mainWindow?.webContents.send('menu:log') },
    { type: 'separator' },
    { label: '官网', click: () => shell.openExternal('http://www.z01.cn') },
    { label: '退出', click: () => app.quit() },
  ]));

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function setupMenu(): void {
  const template: Array<MenuItem | MenuItemConstructorOptions> = [
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    { label: '开始', click: () => mainWindow?.webContents.send('menu:start') },
    { label: '日志', click: () => mainWindow?.webContents.send('menu:log') },
    { label: '设置', click: () => mainWindow?.webContents.send('menu:settings') },
    { label: '帮助', click: () => mainWindow?.webContents.send('menu:help') },
    { label: '置顶', click: toggleTopmost },
    { label: '官网', click: () => shell.openExternal('http://www.z01.cn') },
    { label: '退出', click: () => app.quit() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toggleTopmost(): void {
  if (!mainWindow) {
    return;
  }
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next);
  mainWindow.webContents.send('menu:topmost', next);
}

export { mainWindow, tray };

// IPC 通信模块 - 主进程 IPC 处理器入口

import { app, ipcMain, dialog, Menu, Tray, shell, clipboard } from 'electron';
import fs from 'fs';
import path from 'path';

// 数据库模块
import { addLog, getLogs, clearLogs, deleteLogsByIds, deleteLogsByDate, getLogsByDateRange } from './database';
import { addProdRecordWithTrim, deleteProdRecord, getEditorState, getProdRecords, getSetting, setEditorState, setSetting } from './database';

// 字体处理
import {
  analyzeFont,
  batchExportGlyphs,
  composeFont,
  createDesignProject,
  exportGlyph,
  exportProjectGlyph,
  getProjectGlyph,
  importGlyphAsset,
  listSystemFonts,
  modifyFontMetadata,
  openDesignProject,
  processMaterials,
  publishFont,
  readFontInfo,
  saveDesignProjectAs,
  saveProjectGlyph,
  scanMaterials,
  updateProjectCodes,
  updateProjectMetadata,
  isColorFont,
} from './font';

let mainWindow: any = null;
const LAST_DIALOG_DIR_KEY = 'dialog.lastDirectory';

function extractSvgFromClipboardText(value: string): string {
  const text = String(value || '');
  const direct = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (direct) return direct[0];
  const encoded = text.match(/data:image\/svg\+xml[^"' >,]*,([^"' >]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {}
  }
  return '';
}

const CLIPBOARD_ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.eps', '.svg']);

function normalizeClipboardFilePath(value: string): string {
  let text = String(value || '').trim().replace(/^"|"$/g, '');
  if (text.startsWith('file:///')) {
    try {
      text = decodeURIComponent(new URL(text).pathname);
      if (process.platform === 'win32') text = text.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
    } catch {}
  }
  return text;
}

function validClipboardAssetPath(value: string): string {
  const filePath = normalizeClipboardFilePath(value);
  if (!filePath || !fs.existsSync(filePath)) return '';
  const ext = path.extname(filePath).toLowerCase();
  return CLIPBOARD_ASSET_EXTS.has(ext) ? filePath : '';
}

function readClipboardAssetFilePath(): string {
  const fileNameW = clipboard.readBuffer('FileNameW');
  if (fileNameW.length > 2) {
    const filePath = validClipboardAssetPath(fileNameW.toString('utf16le').replace(/\0+$/g, ''));
    if (filePath) return filePath;
  }
  const candidates = [
    ...String(clipboard.readText() || '').split(/\r?\n/),
    ...Array.from(String(clipboard.readHTML() || '').matchAll(/(?:file:\/\/\/[^"'<>\s]+|[A-Za-z]:\\[^"'<>\r\n]+)/g)).map(match => match[0]),
  ];
  for (const candidate of candidates) {
    const filePath = validClipboardAssetPath(candidate);
    if (filePath) return filePath;
  }
  return '';
}

// 暴露 mainWindow 给其他模块使用
export function setMainWindow(win: any): void {
  mainWindow = win;
}

// 导出数据库相关函数（供其他模块调用）
export { addLog, getLogs, clearLogs };

function defaultDialogPath(options: any): string {
  if (options?.defaultPath) return options.defaultPath;
  const last = getSetting(LAST_DIALOG_DIR_KEY, '');
  if (last && fs.existsSync(last)) return last;
  return app.getPath('desktop');
}

function rememberDialogPath(target?: string | null): void {
  if (!target) return;
  const existing = fs.existsSync(target) ? target : path.dirname(target);
  const dir = fs.existsSync(existing) && fs.statSync(existing).isDirectory() ? existing : path.dirname(existing);
  if (dir && fs.existsSync(dir)) setSetting(LAST_DIALOG_DIR_KEY, dir);
}

// 初始化 IPC 处理器
export function setupIpcHandlers(): void {
  // ==================== 文件对话框 ====================
  ipcMain.handle('dialog:openFile', async (_event, options: any) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultDialogPath(options),
      ...options,
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    rememberDialogPath(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('window:setTitleBarTheme', async (_event, options: { color?: string; symbolColor?: string }) => {
    if (!mainWindow || typeof mainWindow.setTitleBarOverlay !== 'function') return { success: false };
    try {
      mainWindow.setTitleBarOverlay({
        color: options?.color || '#ffffff',
        symbolColor: options?.symbolColor || '#1e3a5f',
        height: 32,
      });
      return { success: true };
    } catch (error: any) {
      console.warn('Titlebar overlay unavailable:', error?.message || error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('dialog:openFiles', async (_event, options: any) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultDialogPath(options),
      ...options,
      properties: Array.from(new Set([...(options?.properties || []), 'openFile', 'multiSelections'])),
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    rememberDialogPath(result.filePaths[0]);
    return result.filePaths;
  });

  ipcMain.handle('dialog:openDirectory', async (_event, options: any) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      defaultPath: defaultDialogPath(options),
      properties: ['openDirectory'],
      ...options,
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    rememberDialogPath(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (_event, options: any) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultDialogPath(options),
      ...options,
    });

    if (result.canceled) {
      return null;
    }

    rememberDialogPath(result.filePath);
    return result.filePath;
  });

  // ==================== 字体处理 ====================
  ipcMain.handle('font:analyze', async (_event, filePath: string) => {
    try {
      const result = analyzeFont(filePath);
      addLog(`字体分析完成：${path.basename(filePath)}, 字符数：${result.codes.length}`);
      return result;
    } catch (e: any) {
      addLog(`字体分析失败：${filePath}, 错误：${e.message}`);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('font:info', async (_event, filePath: string) => {
    return readFontInfo(filePath);
  });

  ipcMain.handle('font:isColorFont', async (_event, filePath: string) => {
    return isColorFont(filePath);
  });

  ipcMain.handle('font:export', async (_event, options: any) => {
    try {
      const result = exportGlyph(options);
      return result;
    } catch (e: any) {
      addLog(`导出字形失败：U+${options.code.toString(16)}, 错误：${e.message}`);
      return { success: false, message: e.message };
    }
  });

  ipcMain.handle('font:batchExport', async (_event, options: any) => {
    return batchExportGlyphs(options.fontPath, options.codes, options.format, options.size, options.outputDir);
  });

  ipcMain.handle('project:exportGlyph', async (_event, options: any) => {
    try {
      const result = exportProjectGlyph(options);
      if (result.success && result.outputPath) addLog(`工程字形已导出：${path.basename(result.outputPath)}`);
      return result;
    } catch (e: any) {
      addLog(`工程字形导出失败：${e.message}`);
      return { success: false, message: e.message };
    }
  });

  ipcMain.handle('font:publish', async (_event, projectPath: string, outputDir: string, options: any = {}) => {
    try {
      const result = publishFont(projectPath, outputDir, options);
      if (result.success) {
        addLog(`发布新字体：${path.basename(result.outputPath)}, 新设计字形数：${result.glyphCount}`);
      }
      return result;
    } catch (e: any) {
      addLog(`发布字体失败：${e.message}`);
      return { success: false, outputPath: '', glyphCount: 0, error: e.message };
    }
  });

  ipcMain.handle('font:scanMaterials', async (_event, materialDir: string, pattern = '*') => {
    return scanMaterials(materialDir, pattern);
  });

  ipcMain.handle('material:process', async (_event, operation: string, options: any) => {
    const result = processMaterials(operation, options);
    if (result.success) {
      addLog(`素材处理完成：${operation}，${result.count} 个文件 -> ${result.outputPath}`);
    }
    return result;
  });

  ipcMain.handle('font:compose', async (_event, options: any) => {
    const result = composeFont(options);
    if (result.success) {
      addLog(`生产新字体：${path.basename(result.outputPath)}，覆盖字形：${result.glyphCount}`);
      addProdRecordWithTrim(options.baseFont, result.outputPath, result.glyphCount);
    }
    return result;
  });

  ipcMain.handle('font:metadata', async (_event, options: any) => {
    const result = modifyFontMetadata(options);
    if (result.success) {
      addLog(`字体元数据已写入：${path.basename(result.outputPath)}，Name ID：${result.nameIds}`);
    }
    return result;
  });

  ipcMain.handle('project:create', async (_event, sourceTtf: string, output?: string) => {
    const result = createDesignProject(sourceTtf, output);
    if (result.success) {
      addLog(`设计工程已创建：${result.path}`);
      addProdRecordWithTrim(sourceTtf, result.path, result.project?.codes?.length || 0);
    }
    return result;
  });

  ipcMain.handle('project:open', async (_event, projectPath: string) => {
    const result = openDesignProject(projectPath);
    if (result.success) {
      addLog(`设计工程已打开：${projectPath}`);
      addProdRecordWithTrim(
        result.project?.source_ttf || result.project?.sourceTtf || '',
        projectPath,
        result.project?.codes?.length || 0,
      );
    }
    return result;
  });

  ipcMain.handle('project:saveAs', async (_event, projectPath: string, outputPath: string) => {
    const result = saveDesignProjectAs(projectPath, outputPath);
    if (result.success) {
      addLog(`设计工程已另存为：${result.path}`);
      addProdRecordWithTrim(
        result.project?.source_ttf || result.project?.sourceTtf || '',
        result.path,
        result.project?.codes?.length || 0,
      );
    }
    return result;
  });

  ipcMain.handle('project:glyph', async (_event, projectPath: string, code: number) => {
    return getProjectGlyph(projectPath, code);
  });

  ipcMain.handle('project:saveGlyph', async (_event, projectPath: string, code: number, glyph: any) => {
    const result = saveProjectGlyph(projectPath, code, glyph);
    if (result.success) {
      addLog(`字形已保存：U+${code.toString(16).toUpperCase()}`);
    }
    return result;
  });

  ipcMain.handle('project:updateCodes', async (_event, projectPath: string, codes: number[], removed: number[] = []) => {
    const result = updateProjectCodes(projectPath, codes, removed);
    addLog(`工程字符集已更新：${codes.length} 个字符`);
    return result;
  });

  ipcMain.handle('project:updateMetadata', async (_event, projectPath: string, metadata: any) => {
    const result = updateProjectMetadata(projectPath, metadata);
    if (result.success) {
      addLog(`工程字体属性已更新：${projectPath}`);
    }
    return result;
  });

  // ==================== 数据库操作 ====================
  ipcMain.handle('font:importGlyphAsset', async (_event, options: any) => {
    try {
      const result = importGlyphAsset(options);
      addLog(`导入字形素材：${path.basename(options.input)}，轮廓 ${result.count || 0} 个`);
      return result;
    } catch (e: any) {
      addLog(`导入字形素材失败：${options?.input || ''}，错误：${e.message}`);
      return { success: false, error: e.message, contours: [], count: 0 };
    }
  });

  ipcMain.handle('font:listSystemFonts', async () => listSystemFonts());

  ipcMain.handle('db:addLog', async (_event, message: string) => {
    addLog(message);
    return { success: true };
  });

  ipcMain.handle('app:runtimeLog', async (_event, message: string) => {
    const line = `[${new Date().toISOString()}] ${String(message || '').slice(0, 20000)}\n`;
    const targets = new Set<string>();
    try {
      targets.add(path.join(app.getPath('userData'), 'runtime.log'));
    } catch {}
    if (process.execPath) {
      targets.add(path.join(path.dirname(process.execPath), 'runtime.log'));
    }
    for (const target of targets) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, line, 'utf8');
      } catch {}
    }
    return { success: true };
  });

  ipcMain.handle('db:getLogs', async (_event, limit: number = 500) => {
    return getLogs(limit);
  });

  ipcMain.handle('db:getLogsByDateRange', async (_event, startDate: string, endDate: string, limit: number = 500) => {
    return getLogsByDateRange(startDate, endDate, limit);
  });

  ipcMain.handle('db:clearLogs', async () => {
    clearLogs();
    return { success: true };
  });

  ipcMain.handle('db:deleteLogsByIds', async (_event, ids: number[]) => {
    const n = deleteLogsByIds(ids);
    return { success: true, deleted: n };
  });

  ipcMain.handle('db:deleteLogsByDate', async (_event, dateStr: string) => {
    const n = deleteLogsByDate(dateStr);
    return { success: true, deleted: n };
  });

  ipcMain.handle('db:getSetting', async (_event, key: string, defaultValue: string = '') => {
    return getSetting(key, defaultValue);
  });

  ipcMain.handle('db:setSetting', async (_event, key: string, value: string) => {
    setSetting(key, value);
    return { success: true };
  });

  ipcMain.handle('editor:getState', async (_event, key: string, defaultValue: string = '') => {
    return getEditorState(key, defaultValue);
  });

  ipcMain.handle('editor:setState', async (_event, key: string, value: string) => {
    setEditorState(key, value);
    return { success: true };
  });

  ipcMain.handle('db:getProdRecords', async () => {
    return getProdRecords();
  });

  ipcMain.handle('db:addProdRecord', async (_event, record: any) => {
    const id = addProdRecordWithTrim(record.baseFont, record.outputFile, record.glyphCount);
    return { success: true, id };
  });

  ipcMain.handle('db:deleteProdRecord', async (_event, id: number) => {
    deleteProdRecord(id);
    return { success: true };
  });

  ipcMain.handle('window:setAlwaysOnTop', async (_event, value: boolean) => {
    mainWindow?.setAlwaysOnTop(value);
    return mainWindow?.isAlwaysOnTop() ?? false;
  });

  ipcMain.handle('window:minimize', async () => {
    mainWindow?.minimize();
    return { success: true };
  });

  ipcMain.handle('window:toggleMaximize', async () => {
    if (!mainWindow) return { success: false, maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { success: true, maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('window:close', async () => {
    mainWindow?.close();
    return { success: true };
  });

  ipcMain.handle('app:quit', async () => {
    app.quit();
  });

  ipcMain.handle('app:getHardwareAcceleration', async () => {
    try {
      const configPath = path.join(app.getPath('userData'), 'hardware.json');
      if (fs.existsSync(configPath)) {
        return !!JSON.parse(fs.readFileSync(configPath, 'utf8')).hardwareAcceleration;
      }
    } catch {}
    return true;
  });

  ipcMain.handle('app:setHardwareAcceleration', async (_event, enabled: boolean) => {
    const configPath = path.join(app.getPath('userData'), 'hardware.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ hardwareAcceleration: !!enabled }, null, 2), 'utf8');
    return { success: true, needsRestart: true };
  });

  ipcMain.handle('app:restart', async () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('app:registerFileAssociation', async () => {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅支持 Windows 系统' };
    }
    const exePath = process.execPath;
    try {
      const { execSync } = await import('child_process');
      // 注册 .z01 扩展名
      execSync('reg add "HKCU\\Software\\Classes\\.z01" /ve /d "ZoomlaXizhi.z01" /f', { windowsHide: true, encoding: 'utf8' });
      // 注册 ProgId 描述
      execSync('reg add "HKCU\\Software\\Classes\\ZoomlaXizhi.z01" /ve /d "逐浪羲之工程文件" /f', { windowsHide: true, encoding: 'utf8' });
      // 注册文件图标（使用 exe 内嵌图标）
      execSync(`reg add "HKCU\\Software\\Classes\\ZoomlaXizhi.z01\\DefaultIcon" /ve /d "\\"${exePath}\\",0" /f`, { windowsHide: true, encoding: 'utf8' });
      // 注册打开命令
      execSync(`reg add "HKCU\\Software\\Classes\\ZoomlaXizhi.z01\\shell\\open\\command" /ve /d "\\"${exePath}\\" \\"%1\\"" /f`, { windowsHide: true, encoding: 'utf8' });
      // 重启资源管理器以刷新图标缓存
      execSync('cmd /c "taskkill /f /im explorer.exe & start explorer.exe"', { windowsHide: true, encoding: 'utf8' });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion();
  });

  ipcMain.handle('app:getPath', async (_event, name: Parameters<typeof app.getPath>[0]) => {
    return app.getPath(name);
  });

  // ==================== 文件操作 ====================
  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    return fs.readFileSync(filePath, 'utf-8');
  });

  ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  });

  ipcMain.handle('fs:writeBinaryBase64', async (_event, filePath: string, contentBase64: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(String(contentBase64 || ''), 'base64'));
    return { success: true };
  });

  ipcMain.handle('fs:exists', async (_event, filePath: string) => {
    return fs.existsSync(filePath);
  });

  ipcMain.handle('fs:mkdir', async (_event, dirPath: string) => {
    fs.mkdirSync(dirPath, { recursive: true });
    return { success: true };
  });

  ipcMain.handle('fs:listDir', async (_event, dirPath: string) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(e => {
      const itemPath = path.join(dirPath, e.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const stat = fs.statSync(itemPath);
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {}
      return { name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), size, mtimeMs };
    });
  });

  // ==================== 路径工具 ====================
  ipcMain.handle('clipboard:material', async () => {
    const tempDir = path.join(app.getPath('temp'), 'ZoomlaXizhiClipboard');
    fs.mkdirSync(tempDir, { recursive: true });
    const assetFilePath = readClipboardAssetFilePath();
    if (assetFilePath) {
      return { success: true, path: assetFilePath, kind: 'file' };
    }
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const filePath = path.join(tempDir, `clipboard-${Date.now()}.png`);
      fs.writeFileSync(filePath, image.toPNG());
      return { success: true, path: filePath, kind: 'image' };
    }
    const svg = extractSvgFromClipboardText(clipboard.readHTML()) || extractSvgFromClipboardText(clipboard.readText());
    if (svg) {
      const filePath = path.join(tempDir, `clipboard-${Date.now()}.svg`);
      fs.writeFileSync(filePath, svg, 'utf8');
      return { success: true, path: filePath, kind: 'svg' };
    }
    return { success: false, error: '剪贴板中没有可用的位图或 SVG 矢量资源' };
  });

  ipcMain.handle('clipboard:writeText', async (_event, text: string) => {
    clipboard.writeText(String(text || ''));
    return { success: true };
  });

  ipcMain.handle('path:resolve', async (_event, ...parts: string[]) => {
    return path.resolve(...parts);
  });

  ipcMain.handle('path:join', async (_event, ...parts: string[]) => {
    return path.join(...parts);
  });

  ipcMain.handle('path:basename', async (_event, p: string, ext?: string) => {
    return path.basename(p, ext);
  });

  ipcMain.handle('path:dirname', async (_event, p: string) => {
    return path.dirname(p);
  });

  ipcMain.handle('shell:showItem', async (_event, p: string) => {
    shell.showItemInFolder(p);
    return { success: true };
  });

  ipcMain.handle('shell:openPath', async (_event, p: string) => {
    if (!p || !fs.existsSync(p)) {
      return { success: false, error: '路径不存在' };
    }
    const error = await shell.openPath(p);
    return error ? { success: false, error } : { success: true };
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return { success: false, error: '无效的网址' };
    }
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('font:installLocal', async (_event, fontPath: string) => {
    if (!fontPath || !fs.existsSync(fontPath)) return { success: false, error: '字体文件不存在' };
    if (process.platform !== 'win32') {
      const error = await shell.openPath(fontPath);
      return error ? { success: false, error } : { success: true, message: '已用系统默认方式打开字体，请按系统提示安装' };
    }
    const fontName = path.basename(fontPath);
    const targetDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Fonts');
    const targetPath = path.join(targetDir, fontName);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(fontPath, targetPath);
    try {
      const { execFileSync } = await import('child_process');
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `$name=${JSON.stringify(fontName)};$path=${JSON.stringify(targetPath)};New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name $name -Value $path -PropertyType String -Force | Out-Null`,
      ], { windowsHide: true });
    } catch {
      // Copying to the per-user Fonts folder is still useful; registry registration may require policy permissions.
    }
    return { success: true, message: `字体已复制到当前用户字体目录：${targetPath}`, path: targetPath };
  });

  ipcMain.handle('font:dataUrl', async (_event, fontPath: string) => {
    if (!fontPath || !fs.existsSync(fontPath)) return { success: false, error: '字体文件不存在' };
    const ext = path.extname(fontPath).slice(1).toLowerCase();
    const mime = ext === 'otf' ? 'font/otf' : ext === 'woff' ? 'font/woff' : ext === 'woff2' ? 'font/woff2' : 'font/ttf';
    const data = fs.readFileSync(fontPath).toString('base64');
    return { success: true, dataUrl: `data:${mime};base64,${data}` };
  });

  ipcMain.handle('help:read', async () => {
    const candidates = [
      path.join(process.cwd(), 'help.md'),
      path.join(app.getAppPath(), 'help.md'),
      path.join(process.resourcesPath || '', 'help.md'),
    ];
    const target = candidates.find(file => file && fs.existsSync(file));
    return target ? fs.readFileSync(target, 'utf8') : '# 帮助\n\n未找到 help.md。';
  });
}

// 托盘菜单
export function setupTray(): Tray | null {
  const iconPath = path.join(__dirname, '../build/icon.ico');

  if (!fs.existsSync(iconPath)) {
    console.warn('托盘图标不存在:', iconPath);
    return null;
  }

  const tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    { label: '设置', click: () => mainWindow?.webContents.send('menu:settings') },
    { label: '日志', click: () => mainWindow?.webContents.send('menu:log') },
    { type: 'separator' },
    { label: '官网', click: () => shell.openExternal('http://www.z01.cn') },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  return tray;
}

// 应用程序菜单
export function setupMenu(sendToWindow: (channel: string) => void): void {
  const template = [
    { label: '开始', click: () => sendToWindow('menu:start') },
    { label: '日志', click: () => sendToWindow('menu:log') },
    { label: '设置', click: () => sendToWindow('menu:settings') },
    { label: '帮助', click: () => sendToWindow('menu:help') },
    { label: '置顶', click: () => sendToWindow('menu:topmost') },
    { label: '官网', click: () => shell.openExternal('http://www.z01.cn') },
    { label: '退出', click: () => app.quit() },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

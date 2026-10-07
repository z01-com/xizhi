// 预加载脚本 - 在渲染进程和主进程之间创建安全桥接

import { contextBridge, ipcRenderer } from 'electron';
import type { ExportFormat, FontMetrics } from '../shared/types';
import { EXPORT_SIZES } from '../shared/constants';

// 类型定义
interface FileDialogOptions {
  title?: string;
  defaultPath?: string;
  properties?: string[];
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface ExportResult {
  success: boolean;
  message: string;
  outputPath?: string;
}

interface PublishResult {
  success: boolean;
  outputPath: string;
  glyphCount: number;
  error?: string;
}

// 安全的 API 暴露
contextBridge.exposeInMainWorld('electronAPI', {
  // ==================== 文件对话框 ====================
  openFile: (options: FileDialogOptions) => ipcRenderer.invoke('dialog:openFile', options),
  openFiles: (options: FileDialogOptions) => ipcRenderer.invoke('dialog:openFiles', options),
  openDirectory: (options: FileDialogOptions) => ipcRenderer.invoke('dialog:openDirectory', options),
  saveFile: (options: FileDialogOptions) => ipcRenderer.invoke('dialog:saveFile', options),

  // ==================== 字体处理 ====================
  analyzeFont: (path: string) => ipcRenderer.invoke('font:analyze', path),
  getFontInfo: (path: string) => ipcRenderer.invoke('font:info', path),
  exportGlyph: (options: { fontPath: string; code: number; format: ExportFormat; size: number; outputDir: string }) =>
    ipcRenderer.invoke('font:export', options),
  batchExportGlyphs: (options: { fontPath: string; codes: number[]; format: ExportFormat; size: number; outputDir: string }) =>
    ipcRenderer.invoke('font:batchExport', options),
  exportProjectGlyph: (options: { projectPath: string; code: number; format: ExportFormat; size: number; outputPath: string }) =>
    ipcRenderer.invoke('project:exportGlyph', options),
  publishFont: (projectPath: string, outputPath: string, options?: any) => ipcRenderer.invoke('font:publish', projectPath, outputPath, options),
  scanMaterials: (materialDir: string, pattern: string = '*') => ipcRenderer.invoke('font:scanMaterials', materialDir, pattern),
  processMaterials: (operation: string, options: any) => ipcRenderer.invoke('material:process', operation, options),
  composeFont: (options: any) => ipcRenderer.invoke('font:compose', options),
  modifyFontMetadata: (options: any) => ipcRenderer.invoke('font:metadata', options),
  createDesignProject: (sourceTtf: string, output?: string) => ipcRenderer.invoke('project:create', sourceTtf, output),
  openDesignProject: (projectPath: string) => ipcRenderer.invoke('project:open', projectPath),
  saveDesignProjectAs: (projectPath: string, outputPath: string) => ipcRenderer.invoke('project:saveAs', projectPath, outputPath),
  getProjectGlyph: (projectPath: string, code: number) => ipcRenderer.invoke('project:glyph', projectPath, code),
  saveProjectGlyph: (projectPath: string, code: number, glyph: any) => ipcRenderer.invoke('project:saveGlyph', projectPath, code, glyph),
  updateProjectCodes: (projectPath: string, codes: number[], removed: number[] = []) => ipcRenderer.invoke('project:updateCodes', projectPath, codes, removed),
  updateProjectMetadata: (projectPath: string, metadata: any) => ipcRenderer.invoke('project:updateMetadata', projectPath, metadata),
  importGlyphAsset: (options: { input: string; upm: number; ascent: number; descent: number; advance: number }) =>
    ipcRenderer.invoke('font:importGlyphAsset', options),
  listSystemFonts: () => ipcRenderer.invoke('font:listSystemFonts'),
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke('window:setAlwaysOnTop', value),
  setTitleBarTheme: (options: { color?: string; symbolColor?: string }) => ipcRenderer.invoke('window:setTitleBarTheme', options),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getHardwareAcceleration: () => ipcRenderer.invoke('app:getHardwareAcceleration'),
  setHardwareAcceleration: (enabled: boolean) => ipcRenderer.invoke('app:setHardwareAcceleration', enabled),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  registerFileAssociation: () => ipcRenderer.invoke('app:registerFileAssociation'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getAppPath: (name: string) => ipcRenderer.invoke('app:getPath', name),
  runtimeLog: (message: string) => ipcRenderer.invoke('app:runtimeLog', message),

  // ==================== 数据库操作 ====================
  dbAddLog: (message: string) => ipcRenderer.invoke('db:addLog', message),
  dbGetLogs: (limit: number = 500) => ipcRenderer.invoke('db:getLogs', limit),
  dbGetLogsByDateRange: (startDate: string, endDate: string, limit: number = 500) => ipcRenderer.invoke('db:getLogsByDateRange', startDate, endDate, limit),
  dbClearLogs: () => ipcRenderer.invoke('db:clearLogs'),
  dbDeleteLogsByIds: (ids: number[]) => ipcRenderer.invoke('db:deleteLogsByIds', ids),
  dbDeleteLogsByDate: (dateStr: string) => ipcRenderer.invoke('db:deleteLogsByDate', dateStr),
  dbGetSetting: (key: string, defaultValue: string = '') => ipcRenderer.invoke('db:getSetting', key, defaultValue),
  dbSetSetting: (key: string, value: string) => ipcRenderer.invoke('db:setSetting', key, value),
  getEditorState: (key: string, defaultValue: string = '') => ipcRenderer.invoke('editor:getState', key, defaultValue),
  setEditorState: (key: string, value: string) => ipcRenderer.invoke('editor:setState', key, value),
  dbGetProdRecords: () => ipcRenderer.invoke('db:getProdRecords'),
  dbAddProdRecord: (record: { baseFont: string; outputFile: string; glyphCount: number }) =>
    ipcRenderer.invoke('db:addProdRecord', record),
  dbDeleteProdRecord: (id: number) => ipcRenderer.invoke('db:deleteProdRecord', id),

  // ==================== 文件系统 ====================
  fsReadFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  fsWriteFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  fsWriteBinaryBase64: (filePath: string, contentBase64: string) => ipcRenderer.invoke('fs:writeBinaryBase64', filePath, contentBase64),
  fsExists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath),
  fsMkdir: (dirPath: string) => ipcRenderer.invoke('fs:mkdir', dirPath),
  fsListDir: (dirPath: string) => ipcRenderer.invoke('fs:listDir', dirPath),
  readClipboardMaterial: () => ipcRenderer.invoke('clipboard:material'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),

  // ==================== 路径工具 ====================
  pathResolve: (...parts: string[]) => ipcRenderer.invoke('path:resolve', ...parts),
  pathJoin: (...parts: string[]) => ipcRenderer.invoke('path:join', ...parts),
  pathBasename: (p: string, ext?: string) => ipcRenderer.invoke('path:basename', p, ext),
  pathDirname: (p: string) => ipcRenderer.invoke('path:dirname', p),
  showItemInFolder: (p: string) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  installFont: (p: string) => ipcRenderer.invoke('font:installLocal', p),
  isColorFont: (p: string) => ipcRenderer.invoke('font:isColorFont', p),
  getFontDataUrl: (p: string) => ipcRenderer.invoke('font:dataUrl', p),
  readHelp: () => ipcRenderer.invoke('help:read'),

  // ==================== IPC 订阅 ====================
  on: (channel: string, func: (...args: any[]) => void) => {
    const subscription = (_event: any, ...args: any[]) => func(...args);
    ipcRenderer.on(channel, subscription);
    return {
      unsubscribe: () => {
        ipcRenderer.removeListener(channel, subscription);
      },
    };
  },

  // ==================== 常量 ====================
  EXPORT_SIZES,

  // ==================== 应用信息 ====================
  appInfo: {
    name: '逐浪羲之 - 仓颉造字开华夏【逐浪字库团队荣耀出品z01.cn',
    version: '1.0.0',
  },
});

// 定义 API 类型
declare global {
  interface ElectronAPI {
    // 文件对话框
    openFile: (options: FileDialogOptions) => Promise<string | null>;
    openFiles: (options: FileDialogOptions) => Promise<string[]>;
    openDirectory: (options: FileDialogOptions) => Promise<string | null>;
    saveFile: (options: FileDialogOptions) => Promise<string | null>;

    // 字体处理
    analyzeFont: (path: string) => Promise<{
      success: boolean;
      metrics: FontMetrics;
      codes: number[];
      cmap: Map<number, string>;
      glyphCount: number;
      error?: string;
    }>;
    getFontInfo: (path: string) => Promise<{ success: boolean; chineseName: string; englishName: string; family: string; version: string; characterCount: number; glyphCount: number; unitsPerEm: number; colorFont: boolean; error?: string }>;
    exportGlyph: (options: { fontPath: string; code: number; format: ExportFormat; size: number; outputDir: string }) => Promise<ExportResult>;
    batchExportGlyphs: (options: { fontPath: string; codes: number[]; format: ExportFormat; size: number; outputDir: string }) => Promise<{ success: number; failed: number; outputPath: string }>;
    exportProjectGlyph: (options: { projectPath: string; code: number; format: ExportFormat; size: number; outputPath: string }) => Promise<ExportResult>;
    publishFont: (projectPath: string, outputPath: string, options?: any) => Promise<PublishResult>;
    scanMaterials: (materialDir: string, pattern?: string) => Promise<{ success: boolean; items: Array<{ path: string; name: string; char: string; code: number; size: string }>; skipped: number; error?: string }>;
    processMaterials: (operation: string, options: any) => Promise<{ success: boolean; outputPath: string; count: number; error?: string }>;
    composeFont: (options: any) => Promise<{ success: boolean; outputPath: string; glyphCount: number; missing: number; failed: number; error?: string }>;
    modifyFontMetadata: (options: any) => Promise<{ success: boolean; outputPath: string; nameIds: number; error?: string }>;
    createDesignProject: (sourceTtf: string, output?: string) => Promise<any>;
    openDesignProject: (projectPath: string) => Promise<any>;
    saveDesignProjectAs: (projectPath: string, outputPath: string) => Promise<any>;
    getProjectGlyph: (projectPath: string, code: number) => Promise<any>;
    saveProjectGlyph: (projectPath: string, code: number, glyph: any) => Promise<any>;
    updateProjectCodes: (projectPath: string, codes: number[], removed?: number[]) => Promise<{ success: boolean; codes: number[]; removed: number[]; error?: string }>;
    updateProjectMetadata: (projectPath: string, metadata: any) => Promise<any>;
    importGlyphAsset: (options: { input: string; upm: number; ascent: number; descent: number; advance: number }) => Promise<{ success: boolean; contours: Array<Array<{ x: number; y: number; on?: boolean }>>; count: number; method?: string; warnings?: string[]; error?: string }>;
    listSystemFonts: () => Promise<Array<{ family: string; path: string }>>;
    setAlwaysOnTop: (value: boolean) => Promise<boolean>;
    setTitleBarTheme: (options: { color?: string; symbolColor?: string }) => Promise<{ success: boolean }>;
    minimizeWindow: () => Promise<{ success: boolean }>;
    toggleMaximizeWindow: () => Promise<{ success: boolean; maximized: boolean }>;
    closeWindow: () => Promise<{ success: boolean }>;
    quitApp: () => Promise<void>;
    getHardwareAcceleration: () => Promise<boolean>;
    setHardwareAcceleration: (enabled: boolean) => Promise<{ success: boolean; needsRestart: boolean }>;
    restartApp: () => Promise<void>;
    registerFileAssociation: () => Promise<{ success: boolean; error?: string }>;
    getAppVersion: () => Promise<string>;
    getAppPath: (name: string) => Promise<string>;
    runtimeLog: (message: string) => Promise<{ success: boolean }>;

    // 数据库操作
    dbAddLog: (message: string) => Promise<{ success: boolean }>;
    dbGetLogs: (limit?: number) => Promise<Array<{ id: number; created: Date; message: string }>>;
    dbGetLogsByDateRange: (startDate: string, endDate: string, limit?: number) => Promise<Array<{ id: number; created: Date; message: string }>>;
    dbClearLogs: () => Promise<{ success: boolean }>;
    dbDeleteLogsByIds: (ids: number[]) => Promise<{ success: boolean; deleted: number }>;
    dbDeleteLogsByDate: (dateStr: string) => Promise<{ success: boolean; deleted: number }>;
    dbGetSetting: (key: string, defaultValue?: string) => Promise<string>;
    dbSetSetting: (key: string, value: string) => Promise<{ success: boolean }>;
    getEditorState: (key: string, defaultValue?: string) => Promise<string>;
    setEditorState: (key: string, value: string) => Promise<{ success: boolean }>;
    dbGetProdRecords: () => Promise<Array<{ id: number; timestamp: string; base_font: string; output_file: string; glyph_count: number }>>;
    dbAddProdRecord: (record: { baseFont: string; outputFile: string; glyphCount: number }) => Promise<{ success: boolean; id: number }>;
    dbDeleteProdRecord: (id: number) => Promise<{ success: boolean }>;

    // 文件系统
    fsReadFile: (filePath: string) => Promise<string>;
    fsWriteFile: (filePath: string, content: string) => Promise<{ success: boolean }>;
    fsWriteBinaryBase64: (filePath: string, contentBase64: string) => Promise<{ success: boolean }>;
    fsExists: (filePath: string) => Promise<boolean>;
    fsMkdir: (dirPath: string) => Promise<{ success: boolean }>;
    fsListDir: (dirPath: string) => Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; size?: number; mtimeMs?: number }>>;
    readClipboardMaterial: () => Promise<{ success: boolean; path?: string; kind?: string; error?: string }>;
    writeClipboardText: (text: string) => Promise<{ success: boolean }>;

    // 路径工具
    pathResolve: (...parts: string[]) => Promise<string>;
    pathJoin: (...parts: string[]) => Promise<string>;
    pathBasename: (p: string, ext?: string) => Promise<string>;
    pathDirname: (p: string) => Promise<string>;
    showItemInFolder: (p: string) => Promise<{ success: boolean }>;
    openPath: (p: string) => Promise<{ success: boolean; error?: string }>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
    installFont: (p: string) => Promise<{ success: boolean; message?: string; path?: string; error?: string }>;
    isColorFont: (p: string) => Promise<boolean>;
    getFontDataUrl: (p: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
    readHelp: () => Promise<string>;

    // IPC 订阅
    on: (channel: string, func: (...args: any[]) => void) => { unsubscribe: () => void };

    // 常量
    EXPORT_SIZES: number[];

    // 应用信息
    appInfo: { name: string; version: string };
  }
}

// 声明 electronAPI
declare global {
  interface Window {
    electronAPI: ElectronAPI;
    appInfo: { name: string; version: string };
  }
}

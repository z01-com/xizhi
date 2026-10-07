// 类型定义文件 - 供渲染进程使用

import { ExportFormat, FontMetrics } from '@shared/types';

declare module '*.ico' {
  const src: string;
  export default src;
}

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
    publishFont: (projectPath: string, outputDir: string, options?: any) => Promise<PublishResult>;
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
    setTitleBarTheme: (options: { color?: string; symbolColor?: string }) => Promise<{ success: boolean; error?: string }>;
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

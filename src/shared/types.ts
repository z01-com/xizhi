// 共享类型定义

// 字形数据结构
export interface Glyph {
  code: number;              // Unicode 码点
  name: string;              // 字形名称
  advance: number;           // 字宽
  contours: Contour[];       // 轮廓数组
}

// 轮廓数据结构
export interface Contour {
  points: Point[];
}

// 锚点数据
export interface Point {
  x: number;
  y: number;
  on: boolean;               // true=on-curve, false=off-curve
}

// 字体度量信息
export interface FontMetrics {
  upm: number;               // Units Per Em
  ascent: number;            // 升部高度
  descent: number;           // 降部深度（负值）
  family: string;            // 字体系列名
}

// 导出格式
export type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'EPS';
export const EXPORT_FORMATS: ExportFormat[] = ['PNG', 'JPG', 'SVG', 'EPS'];
export const EXPORT_SIZES = [200, 400, 600, 800, 1000, 1200, 1800];

// 设计工程数据
export interface DesignProject {
  sourceTtf: string;         // 源字体路径
  path: string;              // 工程文件路径
  family: string;            // 字体系列名
  upm: number;
  ascent: number;
  descent: number;
  glyphs: Map<number, GlyphData>;  // code -> glyph data
}

export interface GlyphData {
  advance: number;
  contours: Contour[];
}

// 生产记录
export interface ProdRecord {
  id: number;
  timestamp: string;         // 'YYYY-MM-DD HH:MM:SS'
  baseFont: string;          // 基础 TTF 路径
  outputFile: string;        // 输出 TTF 路径
  glyphCount: number;        // 覆盖字形数
}

// 日志记录
export interface LogEntry {
  id: number;
  created: Date;
  message: string;
}

// 设置项
export interface AppSetting {
  autoStart: boolean;
  hotkeys: Record<string, string>;
  exportDir: string;
  thumbSize: number;
  pageSize: number;
}

// 字性处理元数据
export interface FontMetadata {
  // name 表
  fontFamily: string;        // 家族名
  fontStyle: string;         // 风格名
  fontSubfamily: string;     // 子家族名
  vendorId: string;          // 厂商 ID
  fullName: string;          // 全名
  fontVersion: string;       // 版本号
  postScriptName: string;    // PostScript 名
  trademark: string;         // 商标
  manufacturer: string;      // 厂商名
  designer: string;          // 设计师
  description: string;       // 描述
  fontFamilyEN?: string;     // 家族名英文
  fontStyleEN?: string;      // 风格名英文

  // URL 字段
  vendorUrl?: string;        // 厂商网址
  designerUrl?: string;      // 设计师网址
  license?: string;          // 许可协议
  licenseUrl?: string;       // 许可协议网址

  // 其他
  sampleText: string;        // 示例文本

  // 扩展参数
  vendorCode: string;        // 厂商代码
  created?: string;          // 创建时间
  modified?: string;         // 修改时间
}

// IPC 事件类型
export interface IpcEvents {
  // 渲染进程 -> 主进程
  'font:analyze': (path: string) => void;
  'font:export': (code: number, format: ExportFormat, size: number, outputPath: string) => void;
  'font:publish': (projectPath: string, outputDir: string) => void;
  'db:query': (table: string, query: any) => void;
  'glyph:edit': (code: number, data: GlyphData) => void;

  // 主进程 -> 渲染进程
  'font:loaded': (metrics: FontMetrics, codes: number[]) => void;
  'font:exported': (success: number, failed: number, outputPath: string) => void;
  'font:published': (outputPath: string, glyphCount: number) => void;
  'db:updated': (table: string, data: any) => void;
  'app:ready': () => void;
}

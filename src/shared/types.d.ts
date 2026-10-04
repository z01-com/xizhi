export interface Glyph {
    code: number;
    name: string;
    advance: number;
    contours: Contour[];
}
export interface Contour {
    points: Point[];
}
export interface Point {
    x: number;
    y: number;
    on: boolean;
}
export interface FontMetrics {
    upm: number;
    ascent: number;
    descent: number;
    family: string;
}
export type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'EPS';
export declare const EXPORT_FORMATS: ExportFormat[];
export declare const EXPORT_SIZES: number[];
export interface DesignProject {
    sourceTtf: string;
    path: string;
    family: string;
    upm: number;
    ascent: number;
    descent: number;
    glyphs: Map<number, GlyphData>;
}
export interface GlyphData {
    advance: number;
    contours: Contour[];
}
export interface ProdRecord {
    id: number;
    timestamp: string;
    baseFont: string;
    outputFile: string;
    glyphCount: number;
}
export interface LogEntry {
    id: number;
    created: Date;
    message: string;
}
export interface AppSetting {
    autoStart: boolean;
    hotkeys: Record<string, string>;
    exportDir: string;
    thumbSize: number;
    pageSize: number;
}
export interface FontMetadata {
    fontFamily: string;
    fontStyle: string;
    fontSubfamily: string;
    vendorId: string;
    fullName: string;
    fontVersion: string;
    postScriptName: string;
    trademark: string;
    manufacturer: string;
    designer: string;
    description: string;
    fontFamilyEN?: string;
    fontStyleEN?: string;
    vendorUrl?: string;
    designerUrl?: string;
    license?: string;
    licenseUrl?: string;
    sampleText: string;
    vendorCode: string;
    created?: string;
    modified?: string;
}
export interface IpcEvents {
    'font:analyze': (path: string) => void;
    'font:export': (code: number, format: ExportFormat, size: number, outputPath: string) => void;
    'font:publish': (projectPath: string, outputDir: string) => void;
    'db:query': (table: string, query: any) => void;
    'glyph:edit': (code: number, data: GlyphData) => void;
    'font:loaded': (metrics: FontMetrics, codes: number[]) => void;
    'font:exported': (success: number, failed: number, outputPath: string) => void;
    'font:published': (outputPath: string, glyphCount: number) => void;
    'db:updated': (table: string, data: any) => void;
    'app:ready': () => void;
}
//# sourceMappingURL=types.d.ts.map
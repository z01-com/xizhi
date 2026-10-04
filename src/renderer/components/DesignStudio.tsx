import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';
import { GlyphEditor } from './GlyphEditor';
import { LoadingOverlay } from './LoadingOverlay';
import { PathTools } from './PathTools';
import { colorModeLabel, normalizeColorMode, type SettingsTab } from './SettingsDialog';
import type { ExportFormat } from '@shared/types';

type Point = { x: number; y: number; on?: boolean };

type GlyphData = { advance?: number; sourceAdvance?: number; sourceLsb?: number; advanceModified?: boolean; targetHeight?: number; glyphName?: string; contours?: Point[][]; contourColors?: string[]; sourceBounds?: { xMin?: number; yMin?: number; xMax?: number; yMax?: number } };
type GlyphCodeFilter = 'all' | 'simplified' | 'traditional' | 'cjk' | 'empty';
type GlyphListHistory = { codes: number[]; glyphs: Record<string, any>; selectedCodes: number[] };
type BatchScope = 'all' | 'cjk' | 'selected';
type BatchDeformMode = 'variant' | 'thin' | 'bold';

interface EditorTab {
  id: number;
  code: number;
  glyphData: any;
  floating?: boolean;
  floatRect?: { left: number; top: number; width: number; height: number };
}

type FloatingResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type MetadataTab = 'font' | 'metrics' | 'extended' | 'variation' | 'supplement';
type GlyphPropertyDock = { code: number; left: number; top: number };

interface DesignStudioProps {
  showToast: (message: string, type: 'info' | 'success' | 'error') => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
  openProjectPath?: string;
}

function parseCode(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  if (text.toUpperCase().startsWith('U+')) return parseInt(text.slice(2), 16);
  if (text.toLowerCase().startsWith('0x')) return parseInt(text.slice(2), 16);
  if (/^[0-9a-fA-F]{4,6}$/.test(text)) return parseInt(text, 16);
  return text.codePointAt(0) ?? null;
}

function codeLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function defaultGlyphName(code: number): string {
  return `uni${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function normalizeGlyphName(value: string): string {
  return value.trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
}

function uniqueGlyphName(baseName: string, usedNames: string[]): string {
  const used = new Set(usedNames.map(name => name.trim()).filter(Boolean));
  const base = normalizeGlyphName(baseName) || 'glyph';
  if (!used.has(base)) return base;
  for (let index = 0; index < 20; index += 1) {
    const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  let counter = 1;
  while (used.has(`${base}${counter}`)) counter += 1;
  return `${base}${counter}`;
}

function contourBounds(contours: Point[][] = []): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const points = contours.flat();
  if (!points.length) return null;
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, Number(point.x) || 0),
    maxX: Math.max(bounds.maxX, Number(point.x) || 0),
    minY: Math.min(bounds.minY, Number(point.y) || 0),
    maxY: Math.max(bounds.maxY, Number(point.y) || 0),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
}

function transformGlyphContours(glyph: GlyphData, transform: (point: Point, contour: Point[], bounds: NonNullable<ReturnType<typeof contourBounds>>) => Point): GlyphData {
  const bounds = contourBounds(glyph.contours || []);
  if (!bounds) return glyph;
  return {
    ...glyph,
    contours: (glyph.contours || []).map(contour => contour.map(point => transform(point, contour, bounds))),
  };
}

function scaleGlyphContours(glyph: GlyphData, sx: number, sy: number): GlyphData {
  const bounds = contourBounds(glyph.contours || []);
  if (!bounds || (!Number.isFinite(sx) && !Number.isFinite(sy))) return glyph;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return transformGlyphContours(glyph, point => ({
    ...point,
    x: Math.round(cx + ((Number(point.x) || 0) - cx) * (Number.isFinite(sx) ? sx : 1)),
    y: Math.round(cy + ((Number(point.y) || 0) - cy) * (Number.isFinite(sy) ? sy : 1)),
  }));
}

function commonRoundedMetric(values: number[]): number {
  const counts = new Map<number, number>();
  values.filter(value => Number.isFinite(value) && value > 0).forEach(value => {
    const rounded = Math.max(1, Math.round(value / 10) * 10);
    counts.set(rounded, (counts.get(rounded) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || 0;
}

function codeFromAssetName(filePath: string): number | null {
  const base = (filePath.split(/[\\/]/).pop() || filePath).replace(/\.[^.]+$/, '').trim();
  const cleaned = base.replace(/^uni/i, '').replace(/^U\+/i, '').replace(/^0x/i, '');
  if (/^[0-9A-Fa-f]{4,6}$/.test(cleaned)) {
    const code = parseInt(cleaned, 16);
    return Number.isFinite(code) ? code : null;
  }
  const chars = Array.from(base);
  return chars.length === 1 ? chars[0].codePointAt(0) ?? null : null;
}

function parseCodes(input: string): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const add = (code: number) => {
    if (code >= 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) && !seen.has(code)) {
      seen.add(code);
      result.push(code);
    }
  };
  input.split(/[\s,，;；]+/).filter(Boolean).forEach(token => {
    if (/^U\+[0-9a-f]{1,6}$/i.test(token)) add(parseInt(token.slice(2), 16));
    else if (/^0x[0-9a-f]{1,6}$/i.test(token)) add(parseInt(token.slice(2), 16));
    else if (/^[0-9a-f]{4,6}$/i.test(token)) add(parseInt(token, 16));
    else Array.from(token).forEach(char => add(char.codePointAt(0)!));
  });
  return result;
}

function glyphSvgPath(glyph?: GlyphData, upm = 1024, ascent = 880, descent = -144): string {
  if (!glyph?.contours?.length) return '';
  const height = ascent - descent || upm;
  const sx = 78 / Math.max(glyph.advance || upm, 1);
  const sy = 78 / Math.max(height, 1);
  const scale = Math.min(sx, sy);
  const ox = 41 - ((glyph.advance || upm) * scale) / 2;
  const oy = 41 + ((ascent + descent) * scale) / 2;
  return glyph.contours.map(contour => contour.map((p, index) => {
    const x = ox + p.x * scale;
    const y = oy - p.y * scale;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ') + ' Z').join(' ');
}

function glyphSvgContourPaths(glyph?: GlyphData, upm = 1024, ascent = 880, descent = -144): string[] {
  if (!glyph?.contours?.length) return [];
  const height = ascent - descent || upm;
  const sx = 78 / Math.max(glyph.advance || upm, 1);
  const sy = 78 / Math.max(height, 1);
  const scale = Math.min(sx, sy);
  const ox = 41 - ((glyph.advance || upm) * scale) / 2;
  const oy = 41 + ((ascent + descent) * scale) / 2;
  return glyph.contours.map(contour => contour.map((p, index) => {
    const x = ox + p.x * scale;
    const y = oy - p.y * scale;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ') + ' Z');
}

function contourArea(contour: Point[] = []): number {
  return contour.reduce((sum, point, index) => {
    const next = contour[(index + 1) % contour.length];
    return sum + (Number(point.x) || 0) * (Number(next?.y) || 0) - (Number(next?.x) || 0) * (Number(point.y) || 0);
  }, 0) / 2;
}

function contourCenter(contour: Point[] = []): { x: number; y: number } {
  const count = Math.max(1, contour.length);
  return {
    x: contour.reduce((sum, point) => sum + (Number(point.x) || 0), 0) / count,
    y: contour.reduce((sum, point) => sum + (Number(point.y) || 0), 0) / count,
  };
}

function pointInContour(point: { x: number; y: number }, contour: Point[] = []): boolean {
  let inside = false;
  for (let index = 0; index < contour.length; index += 1) {
    const a = contour[index];
    const b = contour[(index + 1) % contour.length];
    const ax = Number(a?.x) || 0;
    const ay = Number(a?.y) || 0;
    const bx = Number(b?.x) || 0;
    const by = Number(b?.y) || 0;
    if ((ay > point.y) !== (by > point.y)) {
      const crossX = ((bx - ax) * (point.y - ay)) / ((by - ay) || 1e-9) + ax;
      if (point.x < crossX) inside = !inside;
    }
  }
  return inside;
}

function effectiveContourColors(glyph?: GlyphData): string[] {
  const contours = glyph?.contours || [];
  const rawColors = Array.isArray(glyph?.contourColors) ? glyph.contourColors : [];
  const areas = contours.map(contourArea);
  return contours.map((_contour, index) => {
    let parentIndex = -1;
    let parentArea = Infinity;
    const center = contourCenter(contours[index]);
    contours.forEach((candidate, candidateIndex) => {
      const area = Math.abs(areas[candidateIndex]);
      if (candidateIndex === index || area <= Math.abs(areas[index]) || area >= parentArea) return;
      if (pointInContour(center, candidate)) {
        parentIndex = candidateIndex;
        parentArea = area;
      }
    });
    if (parentIndex >= 0 && areas[index] * areas[parentIndex] < 0 && (!rawColors[index] || rawColors[index] === '#111111')) {
      return rawColors[parentIndex] || '#111111';
    }
    return rawColors[index] || '#111111';
  });
}

function glyphSvgColorGroups(glyph?: GlyphData, upm = 1024, ascent = 880, descent = -144): Array<{ color: string; data: string }> {
  const paths = glyphSvgContourPaths(glyph, upm, ascent, descent);
  const colors = effectiveContourColors(glyph);
  const groups = new Map<string, string[]>();
  paths.forEach((path, index) => {
    const color = colors[index] || '#111111';
    groups.set(color, [...(groups.get(color) || []), path]);
  });
  return Array.from(groups.entries()).map(([color, items]) => ({ color, data: items.join(' ') }));
}

function serializeGlyphData(data: any): string {
  const contours: Array<Array<{ x: number; y: number; on: boolean }>> = (data?.contours || []).map((contour: any[]) => contour.map(point => ({
    x: Math.round(Number(point?.x) || 0),
    y: Math.round(Number(point?.y) || 0),
    on: point?.on !== false,
  })));
  const rawColors = Array.isArray(data?.contourColors) ? data.contourColors : [];
  const sourceBounds = data?.sourceBounds && typeof data.sourceBounds === 'object'
    ? {
      xMin: Number.isFinite(Number(data.sourceBounds.xMin)) ? Number(data.sourceBounds.xMin) : undefined,
      yMin: Number.isFinite(Number(data.sourceBounds.yMin)) ? Number(data.sourceBounds.yMin) : undefined,
      xMax: Number.isFinite(Number(data.sourceBounds.xMax)) ? Number(data.sourceBounds.xMax) : undefined,
      yMax: Number.isFinite(Number(data.sourceBounds.yMax)) ? Number(data.sourceBounds.yMax) : undefined,
    }
    : null;
  return JSON.stringify({
    advance: Number(data?.advance) || 0,
    sourceAdvance: Number(data?.sourceAdvance) || 0,
    sourceLsb: Number(data?.sourceLsb) || 0,
    advanceModified: Boolean(data?.advanceModified),
    glyphName: String(data?.glyphName || ''),
    sourceBounds,
    contours,
    contourColors: contours.map((_contour, index) => rawColors[index] || '#111111'),
  });
}

function normalizeGlyphData(glyph: any, fallbackAdvance: number): GlyphData {
  const advance = Number(glyph?.advance);
  const contours = Array.isArray(glyph?.contours)
    ? glyph.contours
      .filter((contour: any) => Array.isArray(contour))
      .map((contour: any[]) => contour.map(point => ({
        x: Number(point?.x) || 0,
        y: Number(point?.y) || 0,
        on: point?.on !== false,
      })))
    : [];
  const colors = Array.isArray(glyph?.contourColors) ? glyph.contourColors : [];
  const sourceAdvance = Number(glyph?.sourceAdvance);
  const sourceLsb = Number(glyph?.sourceLsb);
  const sourceBounds = glyph?.sourceBounds && typeof glyph.sourceBounds === 'object'
    ? { xMin: Number(glyph.sourceBounds.xMin) || 0, yMin: Number(glyph.sourceBounds.yMin) || 0,
        xMax: Number(glyph.sourceBounds.xMax) || 0, yMax: Number(glyph.sourceBounds.yMax) || 0 }
    : undefined;
  return {
    advance: Number.isFinite(advance) && advance >= 0 ? advance : fallbackAdvance,
    sourceAdvance: Number.isFinite(sourceAdvance) && sourceAdvance >= 0 ? sourceAdvance : (Number.isFinite(advance) && advance >= 0 ? advance : fallbackAdvance),
    sourceLsb: Number.isFinite(sourceLsb) ? sourceLsb : 0,
    advanceModified: Boolean(glyph?.advanceModified),
    sourceBounds,
    contours,
    contourColors: contours.map((_contour: Point[], index: number) => colors[index] || '#111111'),
  };
}

function sourceGlyphProfile(project: any, code: number): { advance?: number; lsb?: number; bounds?: { xMin?: number; yMin?: number; xMax?: number; yMax?: number } } {
  return ((project?.metricsProfile?.glyphs || {})[String(code)] || {}) as any;
}

function isCjkCode(code: number): boolean {
  return (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0x20000 && code <= 0x2EBEF);
}

function isTraditionalCode(code: number): boolean {
  return (code >= 0xF900 && code <= 0xFAFF) || (code >= 0x2F800 && code <= 0x2FA1F);
}

function isSimplifiedCode(code: number): boolean {
  return code >= 0x4E00 && code <= 0x9FFF && !isTraditionalCode(code);
}

function hasGlyphContours(glyph?: GlyphData): boolean {
  return Boolean(glyph?.contours?.some(contour => contour.length >= 3));
}

function hasProjectGlyphRecord(glyphs: Record<string, any> | undefined, code: number): boolean {
  return Object.prototype.hasOwnProperty.call(glyphs || {}, String(code));
}

function projectGlyphsWithSavedGlyph(glyphs: Record<string, any> = {}, code: number, data: any): Record<string, any> {
  const next = { ...(glyphs || {}) };
  next[String(code)] = data;
  return next;
}

function charFilename(code: number): string {
  const ch = String.fromCodePoint(code);
  return /[<>:"/\\|?*\x00-\x1F]/.test(ch) || ch.trim() === '' ? `uni${code.toString(16).toUpperCase().padStart(4, '0')}` : ch;
}

function exportFormatFromPath(filePath: string, fallback: ExportFormat = 'PNG'): ExportFormat {
  const ext = (filePath.split('.').pop() || '').toUpperCase();
  return ['PNG', 'JPG', 'SVG', 'EPS'].includes(ext) ? ext as ExportFormat : fallback;
}

function compactSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function projectFontLabel(project: any): string {
  const family = compactSpaces(String(project?.family || ''));
  const source = String(project?.source_ttf || project?.sourceTtf || '');
  const fileName = source ? source.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '' : '';
  const sourceName = compactSpaces(fileName);
  const pool = compactSpaces([sourceName, family].filter(Boolean).join(' '));
  const chinese = compactSpaces((pool.match(/[\u3400-\u9FFF\uF900-\uFAFF]+/g) || []).join(''));
  const latinFromSource = compactSpaces((sourceName.match(/[A-Za-z][A-Za-z0-9._ -]*/g) || []).join(' '));
  const latinFromFamily = compactSpaces((family.match(/[A-Za-z][A-Za-z0-9._ -]*/g) || []).join(' '));
  const english = latinFromSource || latinFromFamily;
  const label = compactSpaces([chinese, english].filter(Boolean).join(' '));
  return label || family || sourceName || '未命名字体';
}

function defaultProjectMetadata(project: any) {
  const family = compactSpaces(String(project?.family || 'Zoomla Font'));
  const ascii = family.replace(/[^A-Za-z0-9-]/g, '') || 'ZoomlaFont';
  const upm = Number(project?.upm) || 1024;
  const ascent = Number(project?.ascent) || 880;
  const descent = Number(project?.descent) || -144;
  return {
    schema: 1,
    names: {
      familyEn: ascii,
      familyZh: family,
      styleEn: 'Regular',
      styleZh: '常规',
      fullNameEn: `${ascii} Regular`,
      fullNameZh: `${family} 常规`,
      postScriptName: `${ascii}-Regular`,
      version: 'Version 1.000',
      uniqueId: `${ascii};${new Date().toISOString().slice(0, 10)}`,
    },
    legal: {
      copyrightEn: '',
      copyrightZh: '',
      trademarkEn: '',
      trademarkZh: '',
      manufacturerEn: '',
      manufacturerZh: '',
      designerEn: '',
      designerZh: '',
      descriptionEn: 'This font was created using ZoomlaXizhi.',
      descriptionZh: '此字体由逐浪字库工具创建。',
      vendorUrl: '',
      designerUrl: '',
      licenseEn: '',
      licenseZh: '',
      licenseUrl: '',
      sampleTextEn: 'Zoomla Font',
      sampleTextZh: '汉字之美逐浪而来',
      vendorId: 'Z01',
    },
    metrics: {
      unitsPerEm: upm,
      ascender: ascent,
      descender: descent,
      lineGap: 0,
      winAscent: Math.max(0, ascent),
      winDescent: Math.max(0, -descent),
      xHeight: Math.round(upm * 0.48),
      capHeight: Math.round(upm * 0.7),
      italicAngle: 0,
      underlinePosition: -Math.round(upm * 0.1),
      underlineThickness: Math.max(1, Math.round(upm * 0.05)),
    },
    publish: {
      colorOffsetX: 0,
      colorOffsetY: 0,
    },
    axes: [],
    masters: [{ name: 'Regular', includeMetrics: true }],
    instances: [{ name: 'Regular', coordinates: {} }],
    notes: '',
  };
}

function mergeMetadata(project: any) {
  return {
    ...defaultProjectMetadata(project),
    ...(project?.font_metadata || {}),
    names: { ...defaultProjectMetadata(project).names, ...(project?.font_metadata?.names || {}) },
    legal: { ...defaultProjectMetadata(project).legal, ...(project?.font_metadata?.legal || {}) },
    metrics: { ...defaultProjectMetadata(project).metrics, ...(project?.font_metadata?.metrics || {}) },
    publish: { ...defaultProjectMetadata(project).publish, ...(project?.font_metadata?.publish || {}) },
    axes: project?.font_metadata?.axes || defaultProjectMetadata(project).axes,
    masters: project?.font_metadata?.masters || defaultProjectMetadata(project).masters,
    instances: project?.font_metadata?.instances || defaultProjectMetadata(project).instances,
  };
}

export const DesignStudio: React.FC<DesignStudioProps> = ({ showToast, onOpenSettings, openProjectPath }) => {
  const [project, setProject] = useState<any>(null);
  const [projectPath, setProjectPath] = useState('');
  const [records, setRecords] = useState<any[]>([]);
  const [recordsCollapsed, setRecordsCollapsed] = useState(false);
  const [glyphCodeFilter, setGlyphCodeFilter] = useState<GlyphCodeFilter>('all');
  const [jumpText, setJumpText] = useState('');
  const [findTip, setFindTip] = useState('');
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [dragTabId, setDragTabId] = useState<number | null>(null);
  const [tabDrag, setTabDrag] = useState<{ id: number; startX: number; startY: number; moved: boolean; originRect?: { left: number; top: number; width: number; height: number } } | null>(null);
  const [floatResize, setFloatResize] = useState<{ id: number; edge: FloatingResizeEdge; startX: number; startY: number; rect: { left: number; top: number; width: number; height: number } } | null>(null);
  const tabDockRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [glyphFullScreen, setGlyphFullScreen] = useState(false);
  const [previewSize, setPreviewSize] = useState(56);
  const [glyphPage, setGlyphPage] = useState(1);
  const [glyphPageSize, setGlyphPageSize] = useState(2000);
  const [glyphGridLoading, setGlyphGridLoading] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState<number[]>([]);
  const [glyphColorPanelOpen, setGlyphColorPanelOpen] = useState(false);
  const [glyphPaintMode, setGlyphPaintMode] = useState(false);
  const [glyphActiveColor, setGlyphActiveColor] = useState('#111111');
  const [selectionBox, setSelectionBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [glyphMenu, setGlyphMenu] = useState<{ x: number; y: number; code: number } | null>(null);
  const [glyphPropertyDock, setGlyphPropertyDock] = useState<GlyphPropertyDock | null>(null);
  const [glyphPropertyDrag, setGlyphPropertyDrag] = useState<{ startX: number; startY: number; left: number; top: number } | null>(null);
  const [glyphPropertyDrafts, setGlyphPropertyDrafts] = useState({ advance: '', code: '', glyphName: '', left: '', right: '' });
  const [glyphPropertyTip, setGlyphPropertyTip] = useState('');
  const [glyphUndo, setGlyphUndo] = useState<GlyphListHistory[]>([]);
  const [glyphRedo, setGlyphRedo] = useState<GlyphListHistory[]>([]);
  const [batchPanelOpen, setBatchPanelOpen] = useState(false);
  const [batchImportScale, setBatchImportScale] = useState(100);
  const [batchScope, setBatchScope] = useState<BatchScope>('all');
  const [batchHeightValue, setBatchHeightValue] = useState('');
  const [batchWidthValue, setBatchWidthValue] = useState('');
  const [batchHeightScaleElements, setBatchHeightScaleElements] = useState(false);
  const [batchWidthScaleElements, setBatchWidthScaleElements] = useState(false);
  const [batchDeformScope, setBatchDeformScope] = useState<BatchScope>('selected');
  const [batchDeformMode, setBatchDeformMode] = useState<BatchDeformMode>('variant');
  const [batchDeformPercent, setBatchDeformPercent] = useState(10);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0, message: '' });
  const [batchConfirm, setBatchConfirm] = useState<{ title: string; message: string; run: () => void } | null>(null);
  const [recordMenu, setRecordMenu] = useState<{ x: number; y: number; record: any } | null>(null);
  const [addDialog, setAddDialog] = useState<{ anchor: number; mode: 'beforeCodes' | 'afterCodes' | 'beforeCount' | 'afterCount'; value: string } | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const [pendingDeleteCodes, setPendingDeleteCodes] = useState<number[] | null>(null);
  const [publishDialog, setPublishDialog] = useState<{ fontType: string; colorMode: string; outputPath: string; colorOffsetX: number; colorOffsetY: number }>({ fontType: 'ttf', colorMode: 'compatible', outputPath: '', colorOffsetX: 0, colorOffsetY: 0 });
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishProgress, setPublishProgress] = useState(0);
  const [publishStatus, setPublishStatus] = useState('');
  const [publishOpenDir, setPublishOpenDir] = useState(true);
  const [metadataDialogOpen, setMetadataDialogOpen] = useState(false);
  const [metadataMaximized, setMetadataMaximized] = useState(false);
  const [metadataTab, setMetadataTab] = useState<MetadataTab>('font');
  const [metadataDraft, setMetadataDraft] = useState<any>(null);
  const [refFont, setRefFont] = useState('微软雅黑');
  const [refFontMode, setRefFontMode] = useState('empty');
  const findRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollCodeRef = useRef<number | null>(null);
  const lastSelectedCodeRef = useRef<number | null>(null);
  const tabIdCounter = useRef(0);
  const editorRefs = useRef<Map<number, any>>(new Map());
  const dirtyRefs = useRef<Map<number, boolean>>(new Map());
  const cleanRefs = useRef<Map<number, string>>(new Map());

  const loadRecords = async () => setRecords(await window.electronAPI.dbGetProdRecords());

  useEffect(() => {
    loadRecords();
    window.electronAPI.dbGetSetting('ui.designRecordsCollapsed', 'false').then(value => setRecordsCollapsed(value === 'true'));
  }, []);

  const toggleRecordsCollapsed = async () => {
    const next = !recordsCollapsed;
    setRecordsCollapsed(next);
    await window.electronAPI.dbSetSetting('ui.designRecordsCollapsed', String(next));
  };

  useEffect(() => {
    Promise.all([
      window.electronAPI.dbGetSetting('refFont', '微软雅黑'),
      window.electronAPI.dbGetSetting('refFontMode', 'empty'),
    ]).then(([font, mode]) => {
      setRefFont(font);
      setRefFontMode(mode);
    }).catch(() => {});
  }, []);

  // 打开或打开工程时清除 tabs
  useEffect(() => {
    setEditorTabs([]);
    setActiveTabId(null);
    editorRefs.current.clear();
    dirtyRefs.current.clear();
    cleanRefs.current.clear();
  }, [projectPath]);

  const closeProject = () => {
    setProject(null);
    setProjectPath('');
    setSelectedCodes([]);
    setGlyphMenu(null);
    setRecordMenu(null);
    setGlyphFullScreen(false);
    setGlyphPage(1);
  };

  const projectFontFace = useMemo(() => project?.fontDataUrl ? `ZoomlaDesign_${Math.abs(String(projectPath).split('').reduce((sum, char) => ((sum << 5) - sum + char.charCodeAt(0)) | 0, 0))}` : '', [project?.fontDataUrl, projectPath]);

  useEffect(() => {
    if (!project?.fontDataUrl || !projectFontFace) return;
    const style = document.createElement('style');
    style.textContent = `@font-face{font-family:"${projectFontFace}";src:url("${project.fontDataUrl}");}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [project?.fontDataUrl, projectFontFace]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab' || editorTabs.length < 1) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      event.preventDefault();
      const tabIds = [null, ...editorTabs.map(tab => tab.id)];
      const currentIndex = Math.max(0, tabIds.findIndex(id => id === activeTabId));
      const delta = event.shiftKey ? -1 : 1;
      const nextIndex = (currentIndex + delta + tabIds.length) % tabIds.length;
      setActiveTabId(tabIds[nextIndex]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId, editorTabs]);

  const filteredCodes = useMemo(() => {
    const source = (project?.codes || []) as number[];
    return source.filter(code => {
      if (glyphCodeFilter === 'simplified') return isSimplifiedCode(code);
      if (glyphCodeFilter === 'traditional') return isTraditionalCode(code);
      if (glyphCodeFilter === 'cjk') return isCjkCode(code);
      if (glyphCodeFilter === 'empty') return !hasGlyphContours(project?.glyphs?.[String(code)] as GlyphData | undefined);
      return true;
    });
  }, [project, glyphCodeFilter]);

  const pageSize = glyphPageSize;
  const pageCount = Math.max(1, Math.ceil(filteredCodes.length / pageSize));
  const safeGlyphPage = Math.min(glyphPage, pageCount);
  const codes = useMemo(() => filteredCodes.slice((safeGlyphPage - 1) * pageSize, safeGlyphPage * pageSize), [filteredCodes, safeGlyphPage, pageSize]);
  const editorCodes = useMemo(() => ((project?.codes || []) as number[]).filter(code => Number.isFinite(code)), [project?.codes]);
  const batchRecommendedMetrics = useMemo(() => {
    const glyphs = Object.values(project?.glyphs || {}) as GlyphData[];
    const bounds = glyphs.map(glyph => contourBounds(glyph?.contours || [])).filter(Boolean) as NonNullable<ReturnType<typeof contourBounds>>[];
    return {
      height: commonRoundedMetric(bounds.map(item => item.maxY - item.minY)),
      width: commonRoundedMetric(bounds.map(item => item.maxX - item.minX)),
    };
  }, [project?.glyphs]);

  const batchTargetCodes = useCallback((scope: BatchScope) => {
    const source = ((project?.codes || []) as number[]).filter(code => Number.isFinite(code));
    if (scope === 'selected') return Array.from(new Set(selectedCodes)).filter(code => source.includes(code));
    if (scope === 'cjk') return source.filter(isCjkCode);
    return source;
  }, [project?.codes, selectedCodes]);

  useEffect(() => {
    if (batchRecommendedMetrics.height && !batchHeightValue) setBatchHeightValue(String(batchRecommendedMetrics.height));
    if (batchRecommendedMetrics.width && !batchWidthValue) setBatchWidthValue(String(batchRecommendedMetrics.width));
  }, [batchRecommendedMetrics.height, batchRecommendedMetrics.width, batchHeightValue, batchWidthValue]);

  useEffect(() => {
    setGlyphPage(1);
  }, [projectPath, glyphCodeFilter, glyphPageSize]);

  useEffect(() => {
    if (!project) return;
    setGlyphGridLoading(true);
    const timer = window.setTimeout(() => setGlyphGridLoading(false), Math.min(900, Math.max(180, codes.length / 4)));
    return () => window.clearTimeout(timer);
  }, [project, previewSize, glyphPageSize, safeGlyphPage, glyphCodeFilter, codes.length]);

  useEffect(() => {
    const code = pendingScrollCodeRef.current;
    if (code == null || !codes.includes(code)) return;
    const timer = window.setTimeout(() => {
      const node = gridRef.current?.querySelector<HTMLElement>(`[data-glyph-code="${code}"]`);
      if (node) {
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
        pendingScrollCodeRef.current = null;
      }
    }, 40);
    return () => window.clearTimeout(timer);
  }, [codes, selectedCodes]);

  const PREVIEW_PRESETS = [12, 18, 24, 36, 48, 56, 72, 96, 120, 150, 200, 300];

  // Ctrl + 鼠标滚轮 自由缩放字形预览大小
  useEffect(() => {
    return;
    /*
    const grid = gridRef.current;
    if (!grid) return;
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setPreviewSize(prev => {
        const step = Math.max(1, Math.round(prev * 0.08));
        const next = e.deltaY < 0 ? prev + step : prev - step;
        return Math.min(300, Math.max(12, next));
      });
    };
    grid.addEventListener('wheel', handleWheel, { passive: false });
    return () => grid.removeEventListener('wheel', handleWheel);
    */
  }, []);

  const resizeGlyphPreview = useCallback((deltaY: number) => {
    setPreviewSize(prev => {
      const step = Math.max(1, Math.round(prev * 0.08));
      const next = deltaY < 0 ? prev + step : prev - step;
      return Math.min(300, Math.max(12, next));
    });
  }, []);

  const handleGlyphGridWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    resizeGlyphPreview(event.deltaY);
  }, [resizeGlyphPreview]);

  const glyphStats = useMemo(() => {
    const source = (project?.codes || []) as number[];
    const designed = source.filter(code => hasGlyphContours(project?.glyphs?.[String(code)] as GlyphData | undefined)).length;
    return {
      total: source.length,
      simplified: source.filter(isSimplifiedCode).length,
      traditional: source.filter(isTraditionalCode).length,
      cjk: source.filter(isCjkCode).length,
      designed,
      empty: Math.max(0, source.length - designed),
    };
  }, [project]);

  const glyphPropertyData = useMemo(() => {
    if (!project || !glyphPropertyDock) return null;
    const fallbackAdvance = Number(project.upm) || 1024;
    const source = sourceGlyphProfile(project, glyphPropertyDock.code);
    const sourceAdvance = Number(source.advance);
    const sourceBounds = source.bounds && typeof source.bounds === 'object'
      ? source.bounds
      : Number.isFinite(Number((source as any).xMin)) && Number.isFinite(Number((source as any).xMax))
        ? {
          xMin: Number((source as any).xMin),
          yMin: Number((source as any).yMin) || 0,
          xMax: Number((source as any).xMax),
          yMax: Number((source as any).yMax) || 0,
        }
        : undefined;
    const rawGlyph = project.glyphs?.[String(glyphPropertyDock.code)] || {};
    const glyph = normalizeGlyphData(rawGlyph, Number.isFinite(sourceAdvance) && sourceAdvance >= 0 ? sourceAdvance : fallbackAdvance);
    const contourBox = contourBounds(glyph.contours || []);
    const glyphSourceBounds = glyph.sourceBounds && typeof glyph.sourceBounds === 'object' ? glyph.sourceBounds : undefined;
    const rawBounds = contourBox
      ? { xMin: contourBox.minX, yMin: contourBox.minY, xMax: contourBox.maxX, yMax: contourBox.maxY }
      : glyphSourceBounds || sourceBounds || null;
    const bounds = rawBounds && Number.isFinite(Number(rawBounds.xMin)) && Number.isFinite(Number(rawBounds.xMax))
      ? { xMin: Number(rawBounds.xMin), yMin: Number(rawBounds.yMin) || 0, xMax: Number(rawBounds.xMax), yMax: Number(rawBounds.yMax) || 0 }
      : null;
    const advance = Number.isFinite(Number(rawGlyph.advance))
      ? Number(rawGlyph.advance)
      : Number.isFinite(sourceAdvance) && sourceAdvance >= 0
        ? sourceAdvance
        : fallbackAdvance;
    return {
      code: glyphPropertyDock.code,
      glyph: {
        ...glyph,
        advance,
        sourceAdvance: Number.isFinite(sourceAdvance) && sourceAdvance >= 0 ? sourceAdvance : glyph.sourceAdvance,
        sourceLsb: Number.isFinite(Number(source.lsb)) ? Number(source.lsb) : glyph.sourceLsb,
        sourceBounds: glyphSourceBounds || sourceBounds,
      },
      advance,
      bounds,
      leftBearing: bounds ? Math.round(bounds.xMin) : 0,
      rightBearing: bounds ? Math.round(advance - bounds.xMax) : 0,
      hasBounds: Boolean(bounds),
      glyphName: glyph.glyphName || defaultGlyphName(glyphPropertyDock.code),
    };
  }, [glyphPropertyDock, project]);

  useEffect(() => {
    if (!glyphPropertyData) return;
    setGlyphPropertyDrafts({
      advance: String(glyphPropertyData.advance),
      code: codeLabel(glyphPropertyData.code),
      glyphName: glyphPropertyData.glyphName,
      left: glyphPropertyData.hasBounds ? String(glyphPropertyData.leftBearing) : '',
      right: glyphPropertyData.hasBounds ? String(glyphPropertyData.rightBearing) : '',
    });
    setGlyphPropertyTip('');
  }, [glyphPropertyData?.code, glyphPropertyData?.advance, glyphPropertyData?.glyphName, glyphPropertyData?.leftBearing, glyphPropertyData?.rightBearing]);

  useEffect(() => {
    if (!glyphPropertyDrag || !glyphPropertyDock) return;
    const onMove = (event: MouseEvent) => {
      const nextLeft = clamp(glyphPropertyDrag.left + event.clientX - glyphPropertyDrag.startX, 8, Math.max(8, window.innerWidth - 260));
      const nextTop = clamp(glyphPropertyDrag.top + event.clientY - glyphPropertyDrag.startY, 120, Math.max(120, window.innerHeight - 220));
      setGlyphPropertyDock(prev => prev ? { ...prev, left: nextLeft, top: nextTop } : prev);
    };
    const onUp = () => setGlyphPropertyDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [glyphPropertyDrag, glyphPropertyDock]);

  // 当前活跃 tab 的信息
  const activeTab = useMemo(() => editorTabs.find(t => t.id === activeTabId) || null, [editorTabs, activeTabId]);

  const createProject = async () => {
    const font = await window.electronAPI.openFile({ properties: ['openFile'], filters: [{ name: 'Font files', extensions: ['ttf', 'otf'] }] });
    if (!font) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.createDesignProject(font);
      if (result.success) {
        setProject(result.project);
        setProjectPath(result.path);
        setGlyphUndo([]);
        setGlyphRedo([]);
        await loadRecords();
        showToast('工程已创建', 'success');
      } else showToast(result.error || '创建工程失败', 'error');
    } catch (error: any) { showToast(error.message, 'error'); } finally { setBusy(false); }
  };

  const openProject = async (path?: string) => {
    const file = path || await window.electronAPI.openFile({ properties: ['openFile'], filters: [{ name: 'Zoomla design project', extensions: ['z01'] }] });
    if (!file) return;
    if (path && !(await window.electronAPI.fsExists(file))) {
      showToast(`目标资源不存在或已被移动/删除：${file}`, 'error');
      await loadRecords();
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.openDesignProject(file);
      if (result.success) {
        setProject(result.project);
        setProjectPath(result.path);
        setGlyphUndo([]);
        setGlyphRedo([]);
        await loadRecords();
        showToast('工程已打开', 'success');
      } else showToast(result.error || '打开工程失败', 'error');
    } catch (error: any) { showToast(error.message, 'error'); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!openProjectPath || openProjectPath === projectPath) return;
    void openProject(openProjectPath);
  }, [openProjectPath]);

  const locateRecordPath = async (target: string) => {
    if (!target) {
      showToast('目标资源路径为空，无法定位。', 'error');
      return;
    }
    if (!(await window.electronAPI.fsExists(target))) {
      showToast(`目标资源不存在或已被移动/删除：${target}`, 'error');
      await loadRecords();
      return;
    }
    await window.electronAPI.showItemInFolder(target);
  };

  const deleteRecord = async (id: number) => {
    await window.electronAPI.dbDeleteProdRecord(id);
    setRecordMenu(null);
    await loadRecords();
    showToast('记录已删除', 'success');
  };

  const saveRecordProjectAs = async (record: any) => {
    const source = String(record?.output_file || '');
    setRecordMenu(null);
    if (!source.toLowerCase().endsWith('.z01')) {
      showToast('只有 .z01 工程支持另存为。', 'error');
      return;
    }
    if (!(await window.electronAPI.fsExists(source))) {
      showToast(`目标资源不存在或已被移动/删除：${source}`, 'error');
      await loadRecords();
      return;
    }
    const target = await window.electronAPI.saveFile({
      title: '工程另存为',
      defaultPath: source,
      filters: [{ name: '逐浪造字项目', extensions: ['z01'] }],
    });
    if (!target) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.saveDesignProjectAs(source, target);
      if (result.success) {
        setProject(result.project);
        setProjectPath(result.path);
        setGlyphUndo([]);
        setGlyphRedo([]);
        await loadRecords();
        showToast('工程已另存为', 'success');
      } else {
        showToast(result.error || '工程另存为失败', 'error');
      }
    } catch (error: any) {
      showToast(error?.message || '工程另存为失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  // 打开或切换到指定 code 的 tab
  const editGlyph = async (code: number) => {
    if (!projectPath) return;
    // 检查是否已有该 code 的 tab
    const existing = editorTabs.find(t => t.code === code);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.getProjectGlyph(projectPath, code);
      if (result.success) {
        const glyph = normalizeGlyphData(result.glyph, Number(project?.upm) || 1024);
        const id = ++tabIdCounter.current;
        const newTab: EditorTab = { id, code, glyphData: glyph };
        editorRefs.current.set(id, glyph);
        dirtyRefs.current.set(id, false);
        cleanRefs.current.set(id, serializeGlyphData(glyph));
        setEditorTabs(prev => [...prev, newTab]);
        setActiveTabId(id);
      } else showToast(result.error || '读取字形失败', 'error');
    } catch (error: any) { showToast(error.message, 'error'); } finally { setBusy(false); }
  };

  // 关闭一个 tab
  const closeTab = async (tabId: number) => {
    const tab = editorTabs.find(t => t.id === tabId);
    if (!tab) return;
    if (dirtyRefs.current.get(tabId)) {
      setPendingCloseTab(tabId);
      return;
    }
    editorRefs.current.delete(tabId);
    dirtyRefs.current.delete(tabId);
    cleanRefs.current.delete(tabId);
    const nextTabs = editorTabs.filter(t => t.id !== tabId);
    setEditorTabs(nextTabs);
    if (activeTabId === tabId) {
      // 切换到相邻 tab 或回到网格
      if (nextTabs.length > 0) {
        const idx = editorTabs.findIndex(t => t.id === tabId);
        const next = nextTabs[Math.min(idx, nextTabs.length - 1)];
        setActiveTabId(next.id);
      } else {
        setActiveTabId(null);
      }
    }
  };

  // 返回设计台主界面（不关闭 tabs）
  const returnToGrid = () => setActiveTabId(null);

  const moveTab = (targetId: number) => {
    if (dragTabId === null || dragTabId === targetId) return;
    setEditorTabs(prev => {
      const from = prev.findIndex(tab => tab.id === dragTabId);
      const to = prev.findIndex(tab => tab.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  useEffect(() => {
    if (!tabDrag) return;
    const onMove = (event: MouseEvent) => {
      const dx = event.clientX - tabDrag.startX;
      const dy = event.clientY - tabDrag.startY;
      if (Math.hypot(dx, dy) > 12 && !tabDrag.moved) setTabDrag({ ...tabDrag, moved: true });
      if (tabDrag.originRect) {
        setEditorTabs(prev => prev.map(tab => tab.id === tabDrag.id ? {
          ...tab,
          floatRect: {
            ...tabDrag.originRect!,
            left: clamp(tabDrag.originRect!.left + dx, 8, Math.max(8, window.innerWidth - tabDrag.originRect!.width - 8)),
            top: clamp(tabDrag.originRect!.top + dy, 120, Math.max(120, window.innerHeight - tabDrag.originRect!.height - 8)),
          },
        } : tab));
      }
    };
    const onUp = (event: MouseEvent) => {
      const dockRect = tabDockRef.current?.getBoundingClientRect();
      const inDock = dockRect
        ? event.clientX >= dockRect.left && event.clientX <= dockRect.right && event.clientY >= dockRect.top - 24 && event.clientY <= dockRect.bottom + 76
        : false;
      setEditorTabs(prev => prev.map(tab => {
        if (tab.id !== tabDrag.id) return tab;
        if (inDock) {
          setActiveTabId(tabDrag.id);
          return { ...tab, floating: false };
        }
        if (tabDrag.originRect) return tab;
        if (!tabDrag.moved) return tab;
        const width = Math.min(1100, Math.max(760, window.innerWidth * 0.62));
        const height = Math.min(780, Math.max(520, window.innerHeight * 0.7));
        return {
          ...tab,
          floating: true,
          floatRect: {
            left: clamp(event.clientX - 180, 8, Math.max(8, window.innerWidth - width - 8)),
            top: clamp(event.clientY - 28, 120, Math.max(120, window.innerHeight - height - 8)),
            width,
            height,
          },
        };
      }));
      setTabDrag(null);
      setDragTabId(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [tabDrag]);

  useEffect(() => {
    if (!floatResize) return;
    const minWidth = 720;
    const minHeight = 500;
    const edgeMargin = 8;
    const topMargin = 120;
    const onMove = (event: MouseEvent) => {
      const dx = event.clientX - floatResize.startX;
      const dy = event.clientY - floatResize.startY;
      const viewportWidth = window.innerWidth || 1280;
      const viewportHeight = window.innerHeight || 720;
      let { left, top, width, height } = floatResize.rect;

      if (floatResize.edge.includes('e')) {
        width = clamp(floatResize.rect.width + dx, minWidth, Math.max(minWidth, viewportWidth - left - edgeMargin));
      }
      if (floatResize.edge.includes('s')) {
        height = clamp(floatResize.rect.height + dy, minHeight, Math.max(minHeight, viewportHeight - top - edgeMargin));
      }
      if (floatResize.edge.includes('w')) {
        const maxLeft = floatResize.rect.left + floatResize.rect.width - minWidth;
        left = clamp(floatResize.rect.left + dx, edgeMargin, maxLeft);
        width = floatResize.rect.width + floatResize.rect.left - left;
      }
      if (floatResize.edge.includes('n')) {
        const maxTop = floatResize.rect.top + floatResize.rect.height - minHeight;
        top = clamp(floatResize.rect.top + dy, topMargin, maxTop);
        height = floatResize.rect.height + floatResize.rect.top - top;
      }

      setEditorTabs(prev => prev.map(tab => tab.id === floatResize.id ? {
        ...tab,
        floatRect: { left, top, width, height },
      } : tab));
    };
    const onUp = () => setFloatResize(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [floatResize]);

  const discardAndCloseTab = async (tabId: number) => {
    dirtyRefs.current.set(tabId, false);
    setPendingCloseTab(null);
    await closeTab(tabId);
  };

  const saveAndCloseTab = async (tabId: number) => {
    const tab = editorTabs.find(t => t.id === tabId);
    const data = editorRefs.current.get(tabId);
    if (!tab || !data) {
      setPendingCloseTab(null);
      return;
    }
    const success = await saveGlyph(tab.code, data);
    if (!success) return;
    dirtyRefs.current.set(tabId, false);
    cleanRefs.current.set(tabId, serializeGlyphData(data));
    setPendingCloseTab(null);
    await closeTab(tabId);
  };

  const saveGlyph = async (code: number, data: any) => {
    if (!projectPath) return false;
    try {
      const result = await window.electronAPI.saveProjectGlyph(projectPath, code, data);
      if (result.success) {
        setProject((prev: any) => ({ ...prev, glyphs: projectGlyphsWithSavedGlyph(prev?.glyphs || {}, code, data) }));
        // 更新对应 tab 的 dirty 标志和 data
        const tab = editorTabs.find(t => t.code === code);
        if (tab) {
          dirtyRefs.current.set(tab.id, false);
          editorRefs.current.set(tab.id, data);
          cleanRefs.current.set(tab.id, serializeGlyphData(data));
        }
        return true;
      }
      showToast(result.error || '保存失败', 'error');
    } catch (error: any) {
      showToast(error?.message || '保存失败', 'error');
    }
    return false;
  };

  const currentGlyphHistory = useCallback((): GlyphListHistory | null => {
    if (!project) return null;
    return {
      codes: [...((project.codes || []) as number[])],
      glyphs: JSON.parse(JSON.stringify(project.glyphs || {})),
      selectedCodes: [...selectedCodes],
    };
  }, [project, selectedCodes]);

  const pushGlyphHistory = useCallback(() => {
    const snapshot = currentGlyphHistory();
    if (!snapshot) return;
    setGlyphUndo(prev => [...prev.slice(-9), snapshot]);
    setGlyphRedo([]);
  }, [currentGlyphHistory]);

  const saveGlyphFromListProperties = useCallback(async (code: number, data: GlyphData, history = true) => {
    if (!projectPath) return false;
    if (history) pushGlyphHistory();
    const success = await saveGlyph(code, data);
    if (success) {
      setSelectedCodes([code]);
      lastSelectedCodeRef.current = code;
    }
    return success;
  }, [projectPath, pushGlyphHistory, saveGlyph]);

  const restoreGlyphHistory = async (snapshot: GlyphListHistory) => {
    if (!projectPath || !project) return false;
    setBusy(true);
    try {
      const currentCodes = new Set((project.codes || []) as number[]);
      const nextCodes = new Set(snapshot.codes);
      const removed = Array.from(currentCodes).filter(code => !nextCodes.has(code));
      const result = await window.electronAPI.updateProjectCodes(projectPath, snapshot.codes, removed);
      if (!result.success) {
        showToast(result.error || '恢复字形历史失败', 'error');
        return false;
      }
      for (const [codeText, glyph] of Object.entries(snapshot.glyphs || {})) {
        const code = Number(codeText);
        if (!snapshot.codes.includes(code)) continue;
        const saved = await window.electronAPI.saveProjectGlyph(projectPath, code, glyph);
        if (!saved.success) {
          showToast(saved.error || `恢复 U+${code.toString(16).toUpperCase()} 失败`, 'error');
          return false;
        }
      }
      setProject((prev: any) => ({ ...prev, codes: snapshot.codes, glyphs: snapshot.glyphs }));
      setSelectedCodes(snapshot.selectedCodes.filter(code => snapshot.codes.includes(code)));
      setGlyphMenu(null);
      return true;
    } catch (error: any) {
      showToast(error?.message || '恢复字形历史失败', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const undoGlyphList = async () => {
    const last = glyphUndo[glyphUndo.length - 1];
    const current = currentGlyphHistory();
    if (!last || !current) return;
    if (await restoreGlyphHistory(last)) {
      setGlyphRedo(prev => [...prev.slice(-9), current]);
      setGlyphUndo(prev => prev.slice(0, -1));
    }
  };

  const redoGlyphList = async () => {
    const last = glyphRedo[glyphRedo.length - 1];
    const current = currentGlyphHistory();
    if (!last || !current) return;
    if (await restoreGlyphHistory(last)) {
      setGlyphUndo(prev => [...prev.slice(-9), current]);
      setGlyphRedo(prev => prev.slice(0, -1));
    }
  };

  const updateCodes = async (nextCodes: number[], removed: number[] = []) => {
    if (!projectPath) return false;
    try {
      const result = await window.electronAPI.updateProjectCodes(projectPath, nextCodes, removed);
      if (!result.success) {
        showToast(result.error || '更新工程字符失败', 'error');
        return false;
      }
      setProject((prev: any) => ({
        ...prev,
        codes: result.codes,
        glyphs: Object.fromEntries(Object.entries(prev?.glyphs || {}).filter(([key]) => !removed.includes(Number(key)))),
      }));
      return true;
    } catch (error: any) {
      showToast(error?.message || '更新工程字符失败', 'error');
      return false;
    }
  };

  const deleteCodes = async (targets = selectedCodes) => {
    const unique = Array.from(new Set(targets)).filter(code => project?.codes?.includes(code));
    if (!unique.length) return;
    setGlyphMenu(null);
    setPendingDeleteCodes(unique);
  };

  const confirmDeleteCodes = async () => {
    const unique = Array.from(new Set(pendingDeleteCodes || [])).filter(code => project?.codes?.includes(code));
    if (!unique.length) {
      setPendingDeleteCodes(null);
      return;
    }
    pushGlyphHistory();
    const remove = new Set(unique);
    const nextCodes = (project.codes as number[]).filter(code => !remove.has(code));
    if (await updateCodes(nextCodes, unique)) {
      setSelectedCodes([]);
      lastSelectedCodeRef.current = null;
      setGlyphMenu(null);
      setPendingDeleteCodes(null);
      showToast(`已删除 ${unique.length} 个字符`, 'success');
    }
  };

  const paintGlyphCodes = async (targets: number[], color = glyphActiveColor) => {
    if (!projectPath || !project) return;
    const unique = Array.from(new Set(targets)).filter(code => project.codes?.includes(code));
    if (!unique.length) return;
    pushGlyphHistory();
    setBusy(true);
    let updated = 0;
    try {
      for (const code of unique) {
        const source = project.glyphs?.[String(code)]
          ? normalizeGlyphData(project.glyphs[String(code)], Number(project.upm) || 1024)
          : normalizeGlyphData((await window.electronAPI.getProjectGlyph(projectPath, code)).glyph, Number(project.upm) || 1024);
        if (!source.contours?.length) continue;
        const next = { ...source, contourColors: source.contours.map(() => color) };
        const result = await window.electronAPI.saveProjectGlyph(projectPath, code, next);
        if (result.success) {
          updated += 1;
          setProject((prev: any) => ({ ...prev, glyphs: projectGlyphsWithSavedGlyph(prev?.glyphs || {}, code, next) }));
          const tab = editorTabs.find(item => item.code === code);
          if (tab) {
            editorRefs.current.set(tab.id, next);
            dirtyRefs.current.set(tab.id, false);
            cleanRefs.current.set(tab.id, serializeGlyphData(next));
          }
        } else {
          showToast(result.error || `U+${code.toString(16).toUpperCase()} 着色失败`, 'error');
        }
      }
      showToast(updated ? `已着色 ${updated} 个字符` : '没有可着色的字形轮廓', updated ? 'success' : 'info');
    } catch (error: any) {
      showToast(error?.message || '字符着色失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const exportOneProjectGlyph = async (code: number, data?: any) => {
    if (!projectPath) return;
    if (data) {
      const saved = await saveGlyph(code, data);
      if (!saved) return;
    }
    const defaultName = `${charFilename(code)}.png`;
    const outputPath = await window.electronAPI.saveFile({
      title: '导出当前字形',
      defaultPath: defaultName,
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPG 图片', extensions: ['jpg', 'jpeg'] },
        { name: 'SVG 矢量', extensions: ['svg'] },
        { name: 'EPS 矢量', extensions: ['eps'] },
      ],
    });
    if (!outputPath) return;
    const format = exportFormatFromPath(outputPath, 'PNG');
    const result = await window.electronAPI.exportProjectGlyph({ projectPath, code, format, size: 1000, outputPath });
    showToast(result.success ? `已导出：${outputPath}` : result.message || '导出失败', result.success ? 'success' : 'error');
  };

  const exportSelectedProjectGlyphs = async () => {
    const targets = Array.from(new Set(selectedCodes)).filter(code => project?.codes?.includes(code));
    if (!projectPath || !targets.length) {
      showToast('请先选择要导出的字形', 'info');
      return;
    }
    if (targets.length === 1) {
      await exportOneProjectGlyph(targets[0]);
      return;
    }
    const dir = await window.electronAPI.openDirectory({ title: '选择导出目录' });
    if (!dir) return;
    const format = (window.prompt('导出格式：png / jpg / svg / eps', 'png') || 'png').trim().toUpperCase();
    const safeFormat: ExportFormat = ['PNG', 'JPG', 'SVG', 'EPS'].includes(format) ? format as ExportFormat : 'PNG';
    let success = 0;
    for (const code of targets) {
      const outputPath = await window.electronAPI.pathJoin(dir, `${charFilename(code)}.${safeFormat.toLowerCase()}`);
      const result = await window.electronAPI.exportProjectGlyph({ projectPath, code, format: safeFormat, size: 1000, outputPath });
      if (result.success) success += 1;
    }
    showToast(`已导出 ${success}/${targets.length} 个字形`, success ? 'success' : 'error');
  };

  const importGlyphFilesToList = async () => {
    const selected = Array.from(new Set(selectedCodes)).filter(code => project?.codes?.includes(code));
    if (!projectPath || !project || !selected.length) {
      showToast('请先选择导入起始字形', 'info');
      return;
    }
    const files = await window.electronAPI.openFiles({
      title: '选择要导入的字形素材',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '字形素材', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'svg', 'eps'] }],
    });
    if (!files.length) return;
    const sourceCodes = (project.codes || []) as number[];
    const startIndex = sourceCodes.indexOf(selected[0]);
    if (startIndex < 0) return;
    const targets = sourceCodes.slice(startIndex, startIndex + files.length);
    if (!targets.length) return;
    const clearFirst = window.confirm(`将从 ${String.fromCodePoint(selected[0])} 开始导入 ${files.length} 个素材，覆盖 ${targets.length} 个字符。\n\n是否先清空原字形？选择“取消”则在原字形上追加。`);
    pushGlyphHistory();
    setBusy(true);
    let imported = 0;
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const code = targets[index];
        const source = project.glyphs?.[String(code)]
          ? normalizeGlyphData(project.glyphs[String(code)], Number(project.upm) || 1024)
          : normalizeGlyphData((await window.electronAPI.getProjectGlyph(projectPath, code)).glyph, Number(project.upm) || 1024);
        const result = await window.electronAPI.importGlyphAsset({
          input: files[index],
          upm: Number(project.upm) || 1024,
          ascent: Number(project.ascent) || 880,
          descent: Number(project.descent) || -144,
          advance: Number(source.advance) || Number(project.upm) || 1024,
        });
        if (!result.success) continue;
        const nextContours = result.contours.map(contour => contour.map(point => ({ x: point.x, y: point.y, on: point.on !== false })));
        const next = {
          ...source,
          contours: clearFirst ? nextContours : [...(source.contours || []), ...nextContours],
          contourColors: clearFirst
            ? nextContours.map(() => glyphActiveColor)
            : [...(source.contourColors || []), ...nextContours.map(() => glyphActiveColor)],
        };
        const saved = await window.electronAPI.saveProjectGlyph(projectPath, code, next);
        if (saved.success) {
          imported += 1;
          setProject((prev: any) => ({ ...prev, glyphs: projectGlyphsWithSavedGlyph(prev?.glyphs || {}, code, next) }));
        }
      }
      setSelectedCodes(targets);
      lastSelectedCodeRef.current = targets[targets.length - 1] ?? null;
      showToast(`已导入 ${imported}/${targets.length} 个字形素材`, imported ? 'success' : 'error');
    } finally {
      setBusy(false);
    }
  };

  const loadProjectGlyphData = async (code: number): Promise<GlyphData> => {
    const fallbackAdvance = Number(project?.upm) || 1024;
    if (project?.glyphs?.[String(code)]) return normalizeGlyphData(project.glyphs[String(code)], fallbackAdvance);
    const result = await window.electronAPI.getProjectGlyph(projectPath, code);
    return normalizeGlyphData(result.glyph, fallbackAdvance);
  };

  const saveBatchGlyph = async (code: number, data: GlyphData) => {
    const saved = await window.electronAPI.saveProjectGlyph(projectPath, code, data);
    if (!saved.success) throw new Error(saved.error || `保存 ${codeLabel(code)} 失败`);
    setProject((prev: any) => ({ ...prev, glyphs: projectGlyphsWithSavedGlyph(prev?.glyphs || {}, code, data) }));
    const tab = editorTabs.find(item => item.code === code);
    if (tab) {
      editorRefs.current.set(tab.id, data);
      dirtyRefs.current.set(tab.id, false);
      cleanRefs.current.set(tab.id, serializeGlyphData(data));
    }
  };

  const executeBatchOperation = async (title: string, targets: number[], handler: (code: number, index: number) => Promise<boolean>) => {
    if (!projectPath || !project) return;
    if (!targets.length) {
      showToast('没有可处理的字符', 'info');
      return;
    }
    pushGlyphHistory();
    setBatchBusy(true);
    setBatchProgress({ current: 0, total: targets.length, message: title });
    let changed = 0;
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const code = targets[index];
        setBatchProgress({ current: index + 1, total: targets.length, message: `${title} ${codeLabel(code)}` });
        if (await handler(code, index)) changed += 1;
      }
      showToast(`${title}完成：${changed}/${targets.length}`, changed ? 'success' : 'info');
    } catch (error: any) {
      showToast(error?.message || `${title}失败`, 'error');
    } finally {
      setBatchBusy(false);
    }
  };

  const runBatchOperation = (title: string, targets: number[], handler: (code: number, index: number) => Promise<boolean>) => {
    if (!targets.length) {
      showToast('没有可处理的字符', 'info');
      return;
    }
    setBatchConfirm({
      title,
      message: `${title}为不可撤销操作，是否继续？`,
      run: () => { void executeBatchOperation(title, targets, handler); },
    });
  };

  const runSmartBatchImport = async () => {
    if (!projectPath || !project) return;
    const files = await window.electronAPI.openFiles({
      title: '选择要智能导入的字形素材',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '字形素材', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'svg', 'eps'] }],
    });
    if (!files.length) return;
    const codeSet = new Set((project.codes || []) as number[]);
    const matched = files
      .map(file => ({ file, code: codeFromAssetName(file) }))
      .filter((item): item is { file: string; code: number } => item.code !== null && codeSet.has(item.code));
    if (!matched.length) {
      showToast('未找到可匹配的文件名，请使用字符或 Unicode 码命名文件', 'info');
      return;
    }
    const scale = Math.max(1, Number(batchImportScale) || 100) / 100;
    runBatchOperation('智能导入', matched.map(item => item.code), async (code, index) => {
      const source = await loadProjectGlyphData(code);
      const item = matched[index];
      const result = await window.electronAPI.importGlyphAsset({
        input: item.file,
        upm: Number(project.upm) || 1024,
        ascent: Number(project.ascent) || 880,
        descent: Number(project.descent) || -144,
        advance: Number(source.advance) || Number(project.upm) || 1024,
      });
      if (!result.success || !result.contours?.length) return false;
      let nextContours = result.contours.map(contour => contour.map(point => ({ x: point.x, y: point.y, on: point.on !== false })));
      if (Math.abs(scale - 1) > 0.001) {
        nextContours = (scaleGlyphContours({ ...source, contours: nextContours }, scale, scale).contours || nextContours)
          .map(contour => contour.map(point => ({ x: point.x, y: point.y, on: point.on !== false })));
      }
      const next = {
        ...source,
        contours: nextContours,
        contourColors: nextContours.map(() => glyphActiveColor),
      };
      await saveBatchGlyph(code, next);
      return true;
    });
  };

  const runBatchHeight = async () => {
    const targetHeight = Math.max(1, Math.round(Number(batchHeightValue) || batchRecommendedMetrics.height || Number(project?.upm) || 1024));
    const currentAscent = Number(project?.ascent) || 880;
    const currentDescent = Number(project?.descent) || -144;
    const currentHeight = Math.max(1, currentAscent - currentDescent);
    const nextAscent = Math.round(targetHeight * (currentAscent / currentHeight));
    const nextDescent = nextAscent - targetHeight;
    const baseMetadata = project?.metadata || defaultProjectMetadata(project);
    const nextMetadata = {
      ...baseMetadata,
      metrics: {
        ...(baseMetadata.metrics || {}),
        ascender: nextAscent,
        descender: nextDescent,
        hheaAscent: nextAscent,
        hheaDescent: nextDescent,
        winAscent: Math.max(0, nextAscent),
        winDescent: Math.max(0, -nextDescent),
      },
    };
    const metadataResult = await window.electronAPI.updateProjectMetadata(projectPath, nextMetadata);
    if (!metadataResult.success) {
      showToast(metadataResult.error || '更新工程字高失败', 'error');
      return;
    }
    setProject((prev: any) => ({ ...prev, metadata: nextMetadata, ascent: nextAscent, descent: nextDescent }));
    runBatchOperation('字高处理', batchTargetCodes(batchScope), async code => {
      const glyph = await loadProjectGlyphData(code);
      const bounds = contourBounds(glyph.contours || []);
      if (!bounds && batchHeightScaleElements) return false;
      if (!batchHeightScaleElements) {
        await saveBatchGlyph(code, { ...glyph, targetHeight });
        return true;
      }
      if (!bounds) return false;
      const current = bounds.maxY - bounds.minY;
      if (current <= 0) return false;
      await saveBatchGlyph(code, { ...scaleGlyphContours(glyph, 1, targetHeight / current), targetHeight });
      return true;
    });
  };

  const runBatchWidth = async () => {
    const targetWidth = Math.max(1, Math.round(Number(batchWidthValue) || batchRecommendedMetrics.width || Number(project?.upm) || 1024));
    runBatchOperation('字宽处理', batchTargetCodes(batchScope), async code => {
      const glyph = await loadProjectGlyphData(code);
      const bounds = contourBounds(glyph.contours || []);
      let next = { ...glyph };
      if (batchWidthScaleElements) {
        if (!bounds) return false;
        const current = bounds.maxX - bounds.minX;
        if (current <= 0) return false;
        next = scaleGlyphContours(glyph, targetWidth / current, 1);
      }
      next.advance = Math.max(1, Math.round(targetWidth));
      next.advanceModified = true;
      await saveBatchGlyph(code, next);
      return true;
    });
  };

  const runBatchDeform = async () => {
    const percent = Math.max(0, Number(batchDeformPercent) || 0) / 100;
    const mode = batchDeformMode;
    runBatchOperation('字体变形', batchTargetCodes(batchDeformScope), async code => {
      const glyph = await loadProjectGlyphData(code);
      if (!glyph.contours?.length) return false;
      const sx = mode === 'thin' ? Math.max(0.05, 1 - percent) : mode === 'bold' ? 1 + percent : 1 + percent;
      const sy = mode === 'variant' ? Math.max(0.05, 1 - percent * 0.5) : 1;
      await saveBatchGlyph(code, scaleGlyphContours(glyph, sx, sy));
      return true;
    });
  };

  const clickGlyphCell = async (code: number, event?: React.MouseEvent) => {
    if (glyphPropertyDock) {
      setGlyphPropertyDock(prev => prev ? { ...prev, code } : prev);
    }
    if (glyphPaintMode) {
      const targets = selectedCodes.includes(code) && selectedCodes.length > 1 ? selectedCodes : [code];
      setSelectedCodes(targets);
      await paintGlyphCodes(targets);
      return;
    }
    setGlyphMenu(null);
    if (event?.shiftKey && lastSelectedCodeRef.current != null) {
      const anchorIndex = filteredCodes.indexOf(lastSelectedCodeRef.current);
      const targetIndex = filteredCodes.indexOf(code);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        setSelectedCodes(filteredCodes.slice(start, end + 1));
      } else {
        setSelectedCodes([code]);
        lastSelectedCodeRef.current = code;
      }
      return;
    }
    if (event?.ctrlKey || event?.metaKey) {
      setSelectedCodes(prev => {
        const exists = prev.includes(code);
        const next = exists ? prev.filter(item => item !== code) : [...prev, code];
        return next.length ? next : [code];
      });
      lastSelectedCodeRef.current = code;
      return;
    }
    setSelectedCodes([code]);
    lastSelectedCodeRef.current = code;
  };

  const openGlyphTargets = async (code: number) => {
    const targets = Array.from(new Set(selectedCodes.includes(code) ? selectedCodes : [code]))
      .filter(item => project?.codes?.includes(item));
    if (targets.length > 10) {
      showToast('同时打开字符数不支持10个', 'error');
      setGlyphMenu(null);
      return;
    }
    setGlyphMenu(null);
    setSelectedCodes(targets);
    lastSelectedCodeRef.current = targets[targets.length - 1] ?? null;
    for (const target of targets) {
      await editGlyph(target);
    }
  };

  const emptyGlyphDataForCode = (code: number): GlyphData => {
    const raw = (project?.glyphs || {})[String(code)] || {};
    const source = sourceGlyphProfile(project, code);
    const fallbackAdvance = Number(project?.upm) || 1024;
    const rawAdvance = Number(raw.advance);
    const sourceAdvance = Number(source.advance);
    const advance = Number.isFinite(rawAdvance) && rawAdvance >= 0
      ? rawAdvance
      : Number.isFinite(sourceAdvance) && sourceAdvance >= 0
        ? sourceAdvance
        : fallbackAdvance;
    const rawSourceAdvance = Number(raw.sourceAdvance);
    const rawSourceLsb = Number(raw.sourceLsb);
    return {
      ...raw,
      advance,
      sourceAdvance: Number.isFinite(rawSourceAdvance) && rawSourceAdvance >= 0
        ? rawSourceAdvance
        : Number.isFinite(sourceAdvance) && sourceAdvance >= 0
          ? sourceAdvance
          : advance,
      sourceLsb: Number.isFinite(rawSourceLsb) ? rawSourceLsb : Number(source.lsb) || 0,
      sourceBounds: raw.sourceBounds || source.bounds,
      contours: [],
      contourColors: [],
    };
  };

  const clearGlyphContoursFromList = async (targetsInput: number[]) => {
    if (!projectPath || !project) return;
    const targets = Array.from(new Set(targetsInput)).filter(code => project.codes?.includes(code));
    if (!targets.length) return;
    setGlyphMenu(null);
    pushGlyphHistory();
    setBusy(true);
    try {
      for (const code of targets) {
        const saved = await saveGlyph(code, emptyGlyphDataForCode(code));
        if (!saved) return;
      }
      setSelectedCodes(targets);
      lastSelectedCodeRef.current = targets[targets.length - 1] ?? null;
      showToast(targets.length > 1 ? `已清空 ${targets.length} 个字形` : '已清空字形', 'success');
    } finally {
      setBusy(false);
    }
  };

  const submitAddCharacters = async () => {
    if (!addDialog || !project?.codes?.length) return;
    const existing = new Set<number>(project.codes);
    const before = addDialog.mode.startsWith('before');
    let additions: number[] = [];
    if (addDialog.mode.endsWith('Codes')) {
      additions = parseCodes(addDialog.value).filter(code => !existing.has(code));
    } else {
      const count = Math.max(0, Math.min(10000, Number.parseInt(addDialog.value, 10) || 0));
      let candidate = addDialog.anchor + (before ? -1 : 1);
      while (additions.length < count && candidate >= 0 && candidate <= 0x10FFFF) {
        if (!(candidate >= 0xD800 && candidate <= 0xDFFF) && !existing.has(candidate)) additions.push(candidate);
        candidate += before ? -1 : 1;
      }
      if (before) additions.reverse();
    }
    additions = Array.from(new Set(additions));
    if (!additions.length) {
      showToast('没有可添加的 Unicode 字符，已有字符已自动跳过', 'info');
      return;
    }
    const nextCodes = [...project.codes] as number[];
    const anchorIndex = nextCodes.indexOf(addDialog.anchor);
    nextCodes.splice(anchorIndex + (before ? 0 : 1), 0, ...additions);
    pushGlyphHistory();
    if (await updateCodes(nextCodes)) {
      setAddDialog(null);
      setSelectedCodes(additions);
      lastSelectedCodeRef.current = additions[additions.length - 1] ?? null;
      showToast(`已添加 ${additions.length} 个字符`, 'success');
    }
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (activeTabId === null && !addDialog && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'z') {
        const target = event.target as HTMLElement | null;
        if (target?.matches('input, textarea, select')) return;
        event.preventDefault();
        void redoGlyphList();
        return;
      }
      if (activeTabId === null && !addDialog && event.ctrlKey && event.key.toLowerCase() === 'z') {
        const target = event.target as HTMLElement | null;
        if (target?.matches('input, textarea, select')) return;
        event.preventDefault();
        void undoGlyphList();
        return;
      }
      if (activeTabId !== null || addDialog || !selectedCodes.length || event.key !== 'Delete') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select')) return;
      event.preventDefault();
      void deleteCodes();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId, addDialog, selectedCodes, project, projectPath, glyphUndo, glyphRedo]);

  const beginBoxSelection = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    setGlyphMenu(null);
    setSelectedCodes([]);
    setSelectionBox({ x1: event.clientX, y1: event.clientY, x2: event.clientX, y2: event.clientY });
  };

  const moveBoxSelection = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!selectionBox) return;
    const next = { ...selectionBox, x2: event.clientX, y2: event.clientY };
    setSelectionBox(next);
    const left = Math.min(next.x1, next.x2);
    const right = Math.max(next.x1, next.x2);
    const top = Math.min(next.y1, next.y2);
    const bottom = Math.max(next.y1, next.y2);
    const hits = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-glyph-code]') || []).filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
    }).map(node => Number(node.dataset.glyphCode));
    setSelectedCodes(hits);
    lastSelectedCodeRef.current = hits[hits.length - 1] ?? lastSelectedCodeRef.current;
  };

  const jumpToCode = (value = jumpText) => {
    const code = parseCode(value);
    if (code == null || !project?.codes?.includes(code)) {
      setFindTip('无此字');
      return;
    }
    const sourceCodes = (project.codes || []) as number[];
    const index = sourceCodes.indexOf(code);
    if (index < 0) return;
    if (!filteredCodes.includes(code)) setGlyphCodeFilter('all');
    pendingScrollCodeRef.current = code;
    setFindTip('');
    setSelectionBox(null);
    setGlyphPage(Math.floor(index / pageSize) + 1);
    setSelectedCodes([code]);
    lastSelectedCodeRef.current = code;
  };

  const navigateGlyph = async (delta: number, currentData: any) => {
    if (!activeTab || editorCodes.length === 0) return;
    const index = editorCodes.indexOf(activeTab.code);
    if (index < 0) return;
    const nextIndex = Math.max(0, Math.min(editorCodes.length - 1, index + delta));
    if (nextIndex === index) return;
    if (dirtyRefs.current.get(activeTab.id)) {
      const saved = await saveGlyph(activeTab.code, currentData);
      if (!saved) return;
    }
    const nextCode = editorCodes[nextIndex];
    const existing = editorTabs.find(t => t.code === nextCode);
    setBusy(true);
    try {
      let nextData = existing ? editorRefs.current.get(existing.id) || existing.glyphData : null;
      if (!nextData) {
        const result = await window.electronAPI.getProjectGlyph(projectPath, nextCode);
        if (!result.success) {
          showToast(result.error || '读取字形失败', 'error');
          return;
        }
        nextData = normalizeGlyphData(result.glyph, Number(project?.upm) || 1024);
      }
      const nextSerialized = existing
        ? cleanRefs.current.get(existing.id) || serializeGlyphData(nextData)
        : serializeGlyphData(nextData);
      const nextDirty = existing ? Boolean(dirtyRefs.current.get(existing.id)) : false;

      editorRefs.current.set(activeTab.id, nextData);
      cleanRefs.current.set(activeTab.id, nextSerialized);
      dirtyRefs.current.set(activeTab.id, nextDirty);
      if (existing && existing.id !== activeTab.id) {
        editorRefs.current.delete(existing.id);
        cleanRefs.current.delete(existing.id);
        dirtyRefs.current.delete(existing.id);
      }
      setEditorTabs(prev => prev
        .filter(tab => tab.id === activeTab.id || tab.code !== nextCode)
        .map(tab => tab.id === activeTab.id ? { ...tab, code: nextCode, glyphData: nextData } : tab));
    } catch (error: any) {
      showToast(error?.message || '切换字形失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const jumpFromEditor = async (targetCode: number, currentData: any) => {
    if (!project?.codes?.includes(targetCode)) {
      showToast('工程中没有找到该字符', 'error');
      return;
    }
    if (!activeTab || !projectPath) return;
    if (targetCode === activeTab.code) {
      setSelectedCodes([targetCode]);
      return;
    }
    const currentTabId = activeTab.id;
    if (currentData) {
      const saved = await saveGlyph(activeTab.code, currentData);
      if (!saved) return;
    }
    setBusy(true);
    try {
      const existing = editorTabs.find(t => t.code === targetCode && t.id !== currentTabId);
      let targetData = existing ? editorRefs.current.get(existing.id) || existing.glyphData : null;
      if (!targetData) {
        const result = await window.electronAPI.getProjectGlyph(projectPath, targetCode);
        if (!result.success) {
          showToast(result.error || '璇诲彇瀛楀舰澶辫触', 'error');
          return;
        }
        targetData = normalizeGlyphData(result.glyph, Number(project?.upm) || 1024);
      }
      const targetClean = existing
        ? cleanRefs.current.get(existing.id) || serializeGlyphData(targetData)
        : serializeGlyphData(targetData);
      const targetDirty = existing ? Boolean(dirtyRefs.current.get(existing.id)) : false;

      editorRefs.current.set(currentTabId, targetData);
      cleanRefs.current.set(currentTabId, targetClean);
      dirtyRefs.current.set(currentTabId, targetDirty);
      if (existing) {
        editorRefs.current.delete(existing.id);
        cleanRefs.current.delete(existing.id);
        dirtyRefs.current.delete(existing.id);
      }
      setEditorTabs(prev => prev
        .filter(tab => tab.id === currentTabId || tab.code !== targetCode)
        .map(tab => tab.id === currentTabId ? { ...tab, code: targetCode, glyphData: targetData } : tab));
      setActiveTabId(currentTabId);
      setSelectedCodes([targetCode]);
      setFindTip('');
      setJumpText('');
    } catch (error: any) {
      showToast(error?.message || '鎵惧瓧鍒囨崲澶辫触', 'error');
    } finally {
      setBusy(false);
    }
  };

  // 编辑器数据变更时同步到 ref 并标记 dirty
  const handleEditorChange = useCallback((data: any) => {
    if (activeTabId === null) return;
    editorRefs.current.set(activeTabId, data);
    dirtyRefs.current.set(activeTabId, serializeGlyphData(data) !== cleanRefs.current.get(activeTabId));
  }, [activeTabId]);

  // 编辑器保存成功后的回调
  const handleEditorSave = useCallback(async (code: number, data: any) => {
    const success = await saveGlyph(code, data);
    if (success && activeTabId !== null) {
      dirtyRefs.current.set(activeTabId, false);
      cleanRefs.current.set(activeTabId, serializeGlyphData(data));
    }
    return success;
  }, [saveGlyph, activeTabId]);

  const handleEditorChangeForTab = useCallback((tabId: number, data: any) => {
    editorRefs.current.set(tabId, data);
    dirtyRefs.current.set(tabId, serializeGlyphData(data) !== cleanRefs.current.get(tabId));
  }, []);

  const handleEditorSaveForTab = useCallback(async (tabId: number, code: number, data: any) => {
    const success = await saveGlyph(code, data);
    if (success) {
      dirtyRefs.current.set(tabId, false);
      cleanRefs.current.set(tabId, serializeGlyphData(data));
    }
    return success;
  }, [saveGlyph]);

  const changeGlyphCodeForTab = useCallback(async (tabId: number, fromCode: number, toCode: number, data: any) => {
    if (!projectPath || !project) return false;
    if ((project.codes || []).includes(toCode)) {
      showToast('字码点不可重复', 'error');
      return false;
    }
    const sourceCodes = (project.codes || []) as number[];
    const fromIndex = sourceCodes.indexOf(fromCode);
    if (fromIndex < 0) return false;
    pushGlyphHistory();
    const nextCodes = [...sourceCodes];
    nextCodes[fromIndex] = toCode;
    const updatedCodes = await updateCodes(nextCodes, [fromCode]);
    if (!updatedCodes) return false;
    const saved = await window.electronAPI.saveProjectGlyph(projectPath, toCode, data);
    if (!saved.success) {
      showToast(saved.error || '保存字形失败', 'error');
      return false;
    }
    setProject((prev: any) => ({
      ...prev,
      codes: nextCodes,
      glyphs: projectGlyphsWithSavedGlyph(prev?.glyphs || {}, toCode, data),
    }));
    setEditorTabs(prev => prev.map(tab => tab.id === tabId ? { ...tab, code: toCode, glyphData: data } : tab));
    editorRefs.current.set(tabId, data);
    cleanRefs.current.set(tabId, serializeGlyphData(data));
    dirtyRefs.current.set(tabId, false);
    setSelectedCodes([toCode]);
    return true;
  }, [project, projectPath, pushGlyphHistory, updateCodes, showToast]);

  const updateGlyphPropertyDraft = (key: keyof typeof glyphPropertyDrafts, value: string) => {
    setGlyphPropertyDrafts(prev => ({ ...prev, [key]: value }));
  };

  const commitGlyphPropertyAdvance = async () => {
    if (!glyphPropertyData) return;
    const next = Math.max(0, Math.round(Number(glyphPropertyDrafts.advance) || 0));
    if (next === glyphPropertyData.advance) {
      setGlyphPropertyDrafts(prev => ({ ...prev, advance: String(glyphPropertyData.advance) }));
      return;
    }
    const data = { ...glyphPropertyData.glyph, advance: next, advanceModified: true };
    await saveGlyphFromListProperties(glyphPropertyData.code, data);
  };

  const commitGlyphPropertyCode = async () => {
    if (!glyphPropertyData || !projectPath || !project) return;
    const nextCode = parseCode(glyphPropertyDrafts.code);
    if (nextCode == null || nextCode < 0 || nextCode > 0x10FFFF || (nextCode >= 0xD800 && nextCode <= 0xDFFF)) {
      setGlyphPropertyTip('字码点无效');
      setGlyphPropertyDrafts(prev => ({ ...prev, code: '' }));
      return;
    }
    if (nextCode === glyphPropertyData.code) {
      setGlyphPropertyDrafts(prev => ({ ...prev, code: codeLabel(glyphPropertyData.code) }));
      return;
    }
    if ((project.codes || []).includes(nextCode)) {
      setGlyphPropertyTip('字码点不可重复');
      setGlyphPropertyDrafts(prev => ({ ...prev, code: '' }));
      return;
    }
    const codes = [...((project.codes || []) as number[])];
    const index = codes.indexOf(glyphPropertyData.code);
    if (index < 0) return;
    pushGlyphHistory();
    codes[index] = nextCode;
    const updated = await updateCodes(codes, [glyphPropertyData.code]);
    if (!updated) return;
    const saved = await window.electronAPI.saveProjectGlyph(projectPath, nextCode, glyphPropertyData.glyph);
    if (!saved.success) {
      showToast(saved.error || '保存字形失败', 'error');
      return;
    }
    setProject((prev: any) => ({
      ...prev,
      codes,
      glyphs: projectGlyphsWithSavedGlyph(prev?.glyphs || {}, nextCode, glyphPropertyData.glyph),
    }));
    setSelectedCodes([nextCode]);
    lastSelectedCodeRef.current = nextCode;
    setGlyphPropertyDock(prev => prev ? { ...prev, code: nextCode } : prev);
    setGlyphPropertyTip('');
  };

  const commitGlyphPropertyName = async () => {
    if (!glyphPropertyData || !project) return;
    const usedNames = Object.entries(project.glyphs || {})
      .filter(([codeText]) => Number(codeText) !== glyphPropertyData.code)
      .map(([, glyph]: [string, any]) => String(glyph?.glyphName || '').trim())
      .filter(Boolean);
    const nextName = uniqueGlyphName(glyphPropertyDrafts.glyphName, usedNames);
    const data = { ...glyphPropertyData.glyph, glyphName: nextName };
    await saveGlyphFromListProperties(glyphPropertyData.code, data);
  };

  const shiftGlyphPropertyContours = async (dx: number) => {
    if (!glyphPropertyData || !glyphPropertyData.glyph.contours?.length || Math.abs(dx) < 1) return;
    const data = {
      ...glyphPropertyData.glyph,
      contours: glyphPropertyData.glyph.contours.map(contour => contour.map(point => ({ ...point, x: Math.round((Number(point.x) || 0) + dx) }))),
    };
    await saveGlyphFromListProperties(glyphPropertyData.code, data);
  };

  const commitGlyphPropertyLeft = async () => {
    if (!glyphPropertyData) return;
    if (!glyphPropertyData.hasBounds && glyphPropertyDrafts.left.trim() === '') return;
    const next = Math.round(Number(glyphPropertyDrafts.left) || 0);
    await shiftGlyphPropertyContours(next - glyphPropertyData.leftBearing);
  };

  const commitGlyphPropertyRight = async () => {
    if (!glyphPropertyData) return;
    if (!glyphPropertyData.hasBounds && glyphPropertyDrafts.right.trim() === '') return;
    const next = Math.round(Number(glyphPropertyDrafts.right) || 0);
    await shiftGlyphPropertyContours(glyphPropertyData.rightBearing - next);
  };

  const openGlyphProperties = (code: number, x?: number, y?: number) => {
    const left = clamp((x ?? window.innerWidth - 320) - 20, 8, Math.max(8, window.innerWidth - 260));
    const top = clamp((y ?? 180) - 20, 120, Math.max(120, window.innerHeight - 220));
    setGlyphMenu(null);
    setGlyphPropertyDock({ code, left, top });
    setSelectedCodes([code]);
    lastSelectedCodeRef.current = code;
  };

  const dockFloatingTab = (tabId: number) => {
    setEditorTabs(prev => prev.map(tab => tab.id === tabId ? { ...tab, floating: false } : tab));
    setActiveTabId(tabId);
  };

  const publish = async () => {
    if (!projectPath) { showToast('请先创建或打开工程', 'error'); return; }
    const [fontType, colorMode, exportDir] = await Promise.all([
      window.electronAPI.dbGetSetting('publishFontType', 'ttf'),
      window.electronAPI.dbGetSetting('publishColorMode', 'compatible'),
      window.electronAPI.dbGetSetting('exportDir', ''),
    ]);
    const meta = mergeMetadata(project);
    const offsetX = Number(meta.publish?.colorOffsetX);
    const offsetY = Number(meta.publish?.colorOffsetY);
    // 从源 TTF 路径生成默认输出文件名
    const source = project?.source_ttf || project?.sourceTtf || projectPath;
    const lastDot = source.lastIndexOf('.');
    const sourceStem = lastDot > source.lastIndexOf('/') && lastDot > source.lastIndexOf('\\') ? source.slice(0, lastDot) : source;
    const baseName = sourceStem.slice(Math.max(sourceStem.lastIndexOf('/'), sourceStem.lastIndexOf('\\')) + 1);
    const ext = fontType || 'ttf';
    const defaultFileName = `${baseName}_new.${ext}`;
    const defaultPath = exportDir ? `${exportDir.replace(/[/\\]$/, '')}/${defaultFileName}` : '';
    setPublishDialog({ fontType: fontType || 'ttf', colorMode: normalizeColorMode(colorMode), outputPath: defaultPath, colorOffsetX: Number.isFinite(offsetX) ? offsetX : 0, colorOffsetY: Number.isFinite(offsetY) ? offsetY : 0 });
    setPublishDialogOpen(true);
  };

  const openMetadataDialog = () => {
    if (!projectPath || !project) {
      showToast('请先创建或打开工程', 'error');
      return;
    }
    setMetadataDraft(mergeMetadata(project));
    setMetadataTab('font');
    setMetadataMaximized(false);
    setMetadataDialogOpen(true);
  };

  const patchMetadata = (section: string, key: string, value: any) => {
    setMetadataDraft((prev: any) => ({ ...prev, [section]: { ...(prev?.[section] || {}), [key]: value } }));
  };

  const saveProjectMetadata = async () => {
    if (!projectPath || !metadataDraft) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.updateProjectMetadata(projectPath, metadataDraft);
      if (result.success) {
        setProject(result.project);
        setMetadataDialogOpen(false);
        showToast('工程属性已保存', 'success');
      } else {
        showToast(result.error || '工程属性保存失败', 'error');
      }
    } catch (error: any) {
      showToast(error?.message || '工程属性保存失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmPublish = async () => {
    if (!projectPath) { showToast('请先创建或打开工程', 'error'); return; }
    let outputPath = publishDialog.outputPath;
    if (!outputPath) {
      const selected = await window.electronAPI.saveFile({
        title: '选择字体保存位置',
        defaultPath: publishDialog.outputPath || undefined,
        filters: [{ name: '字体文件', extensions: [publishDialog.fontType] }],
      });
      if (!selected) return;
      outputPath = selected;
      setPublishDialog(prev => ({ ...prev, outputPath }));
    }
    // 记录本次导出目录到设置
    const dir = outputPath.slice(0, Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\')));
    if (dir) await window.electronAPI.dbSetSetting('exportDir', dir);
    if (!outputPath) return;
    setPublishBusy(true);
    setPublishProgress(12);
    setPublishStatus('正在准备工程与发布属性...');
    const timer = window.setInterval(() => {
      setPublishProgress(value => {
        if (value >= 88) return value;
        if (value < 45) return value + 5;
        if (value < 72) return value + 3;
        return value + 1;
      });
    }, 240);
    try {
      setPublishStatus('正在生成字形与字体数据表...');
      const colorMode = normalizeColorMode(publishDialog.colorMode);
      const result = await window.electronAPI.publishFont(projectPath, outputPath, {
        fontType: publishDialog.fontType,
        colorMode,
        colorOffsetX: publishDialog.colorOffsetX,
        colorOffsetY: publishDialog.colorOffsetY,
      });
      if (result.success) {
        setPublishStatus('字体发布完成');
        setPublishProgress(100);
        await loadRecords();
        if (publishOpenDir && dir) {
          const openResult = await window.electronAPI.openPath(dir);
          if (!openResult.success) showToast(openResult.error || `无法打开目录：${dir}`, 'error');
        }
        showToast(`字体发布成功-本次发布共更新${result.glyphCount}个字符。`, 'success');
        await new Promise(resolve => window.setTimeout(resolve, 450));
        setPublishDialogOpen(false);
      } else {
        setPublishStatus('发布失败');
        showToast(result.error || '发布失败', 'error');
      }
    } catch (error: any) {
      setPublishStatus('发布失败');
      showToast(error.message, 'error');
    } finally {
      window.clearInterval(timer);
      setPublishBusy(false);
      setPublishProgress(0);
      setPublishStatus('');
    }
  };

  const isEditorActive = Boolean(activeTab);
  const currentGlyphData = activeTab ? (editorRefs.current.get(activeTab.id) || activeTab.glyphData) : null;
  useEffect(() => {
    if (isEditorActive) setGlyphPropertyDock(null);
  }, [isEditorActive]);
  const usedGlyphNames = useMemo(() => Object.values(project?.glyphs || {})
    .map((glyph: any) => String(glyph?.glyphName || '').trim())
    .filter(Boolean), [project?.glyphs]);
  const renderEditorTabs = () => editorTabs.length > 0 ? (
    <div ref={tabDockRef} style={styles.tabBar}>
      <div style={styles.tabList}>
        <button
          style={isEditorActive ? styles.tabReturn : styles.tabReturnActive}
          onClick={returnToGrid}
          title="返回所有字符"
        >
          <i className="ri-layout-grid-fill" />
          <span>所有字符</span>
        </button>
        {editorTabs.filter(tab => !tab.floating).map(tab => {
          const isActive = tab.id === activeTabId;
          const char = String.fromCodePoint(tab.code);
          const dirty = dirtyRefs.current.get(tab.id);
          const hex = tab.code.toString(16).toUpperCase().padStart(4, '0');
          return (
            <button
              key={tab.id}
              style={isActive ? styles.tabActive : styles.tab}
              onClick={() => setActiveTabId(tab.id)}
              onMouseDown={event => {
                if ((event.target as HTMLElement).closest('[data-tab-close="true"]')) return;
                setActiveTabId(tab.id);
                setDragTabId(tab.id);
                setTabDrag({ id: tab.id, startX: event.clientX, startY: event.clientY, moved: false });
              }}
              onMouseEnter={() => { if (dragTabId !== null) moveTab(tab.id); }}
              title={`${char} U+${hex}${dirty ? ' (unsaved)' : ''}`}
            >
              <span style={styles.tabChar}>{char}</span>
              <span style={isActive ? styles.tabCodeActive : styles.tabCode}>U+{hex}</span>
              {dirty && <span style={styles.tabDirty}>*</span>}
              <span
                data-tab-close="true"
                style={styles.tabClose}
                onClick={event => { event.stopPropagation(); void closeTab(tab.id); }}
                title="关闭"
              >x</span>
            </button>
          );
        })}
        {editorTabs.filter(tab => tab.floating).map(tab => {
          const char = String.fromCodePoint(tab.code);
          const dirty = dirtyRefs.current.get(tab.id);
          const hex = tab.code.toString(16).toUpperCase().padStart(4, '0');
          return (
            <button
              key={`float-${tab.id}`}
              style={styles.tabFloatingBadge}
              onClick={() => setActiveTabId(tab.id)}
              onMouseDown={event => {
                if ((event.target as HTMLElement).closest('[data-tab-close="true"]')) return;
                setActiveTabId(tab.id);
                setDragTabId(tab.id);
                setTabDrag({ id: tab.id, startX: event.clientX, startY: event.clientY, moved: false });
              }}
              title={`悬浮窗口：${char} U+${hex}`}
            >
              <i className="ri-window-line" />
              <span>{char}</span>
              <span style={styles.tabCode}>U+{hex}</span>
              {dirty && <span style={styles.tabDirty}>*</span>}
              <span data-tab-close="true" style={styles.tabClose} onClick={event => { event.stopPropagation(); void closeTab(tab.id); }}>x</span>
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  return (
    <div style={styles.container} onClick={() => { setRecordMenu(null); setGlyphMenu(null); }}>
      {!isEditorActive && <section style={styles.projectBar}>
        <div style={styles.controls}>
          <PathTools value={projectPath} placeholder="创建或打开 .z01 工程" onBrowse={() => openProject()} />
          <button style={styles.actionButton} onClick={createProject} disabled={busy}>新工程</button>
          {projectPath && <button style={styles.primaryButton} onClick={publish} disabled={busy}>发布字体</button>}
          {projectPath && <button style={styles.secondaryButton} onClick={openMetadataDialog} disabled={busy}>属性</button>}
        </div>
        {project && <div style={styles.projectInfo}>{project.family} | 字符 {project.codes?.length || 0} | 已设计 {glyphStats.designed}</div>}
      </section>}

      {/* Tab bar：只在有 tabs 时显示 */}
      {false && editorTabs.length > 0 && (
        <div style={styles.tabBar}>
          <div style={styles.tabList}>
            {/* 返回设计台按钮 */}
            <button
              style={isEditorActive ? styles.tabReturn : styles.tabReturnActive}
              onClick={returnToGrid}
              title="返回设计台"
            >
              <i className="ri-layout-grid-fill" />
              <span>工程字形</span>
            </button>
            {editorTabs.map(tab => {
              const isActive = tab.id === activeTabId;
              const char = String.fromCodePoint(tab.code);
              const dirty = dirtyRefs.current.get(tab.id);
              const hex = tab.code.toString(16).toUpperCase().padStart(4, '0');
              return (
                <button
                  key={tab.id}
                  style={isActive ? styles.tabActive : styles.tab}
                  draggable
                  onClick={() => setActiveTabId(tab.id)}
                  onDragStart={() => setDragTabId(tab.id)}
                  onDragOver={event => { event.preventDefault(); moveTab(tab.id); }}
                  onDragEnd={() => setDragTabId(null)}
                  title={`${char} U+${tab.code.toString(16).toUpperCase().padStart(4, '0')}${dirty ? ' (未保存)' : ''}`}
                >
                  <span style={styles.tabChar}>{char}</span>
                  <span style={isActive ? styles.tabCodeActive : styles.tabCode}>U+{hex}</span>
                  {dirty && <span style={styles.tabDirty}>●</span>}
                  <span
                    style={styles.tabClose}
                    onClick={event => { event.stopPropagation(); void closeTab(tab.id); }}
                    title="关闭"
                  >×</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 编辑器区域 或 字形网格 */}
      {activeTab && currentGlyphData ? (
        <div style={styles.editorArea}>
          <GlyphEditor
            key={`${activeTab.id}-${activeTab.code}`}
            code={activeTab.code}
            codes={editorCodes}
            initialGlyph={currentGlyphData}
            metrics={{ upm: project?.upm || 1024, ascent: project?.ascent || 880, descent: project?.descent || -144 }}
            family={project?.family || ''}
            refFont={refFont}
            refFontMode={refFontMode}
            previewFontFace={projectFontFace}
            tabsSlot={renderEditorTabs()}
            onClose={(options) => {
              const code = activeTab.code;
              const data = editorRefs.current.get(activeTab.id);
              if (!options?.skipAutoSave && code !== null && data) void saveGlyph(code, data);
              closeTab(activeTab.id);
            }}
            onSave={(code, data) => handleEditorSaveForTab(activeTab.id, code, data)}
            onChangeCode={(nextCode, data) => changeGlyphCodeForTab(activeTab.id, activeTab.code, nextCode, data)}
            usedGlyphNames={usedGlyphNames}
            onExport={exportOneProjectGlyph}
            onNavigate={(delta, data) => { setActiveTabId(activeTab.id); return navigateGlyph(delta, data); }}
            onJump={(code, data) => { setActiveTabId(activeTab.id); return jumpFromEditor(code, data); }}
            onChange={(data) => handleEditorChangeForTab(activeTab.id, data)}
          />
        </div>
      ) : project ? (
        <section style={glyphFullScreen ? styles.glyphPanelFull : styles.glyphPanel}>
          <LoadingOverlay visible={busy} />
          <div style={styles.glyphToolbar}>
              <h3 style={styles.subTitle}>工程字形</h3>
              {project && <span style={styles.glyphSummary}>- {projectFontLabel(project)}</span>}
              {/* {project && <span style={styles.glyphSummary}>- {projectFontLabel(project)} {glyphStats.total}字</span>} */}
              <select value={glyphCodeFilter} onChange={event => setGlyphCodeFilter(event.target.value as GlyphCodeFilter)} style={styles.statSelect}>
                <option value="all">全部字符 {glyphStats.total}</option>
                <option value="simplified">简体中文编码 {glyphStats.simplified}</option>
                <option value="traditional">繁体中文编码 {glyphStats.traditional}</option>
                <option value="cjk">CJK字符部数 {glyphStats.cjk}</option>
                <option value="empty">空字符 {glyphStats.empty}</option>
              </select>
            {/* <label style={styles.inlineLabel}>预览大小</label> */}
            <select value={previewSize} onChange={event => setPreviewSize(Number(event.target.value))} style={styles.statSelect}>
              {PREVIEW_PRESETS.map(value => <option key={value} value={value}>{value}px</option>)}
              {!PREVIEW_PRESETS.includes(previewSize) && <option value={previewSize}>{previewSize}px</option>}
            </select>
            <button title="撤销 Ctrl+Z" disabled={!glyphUndo.length || busy} style={!glyphUndo.length || busy ? styles.iconButtonDisabled : styles.iconButton} onClick={() => void undoGlyphList()}><i className="ri-arrow-go-back-line" /></button>
            <button title="反撤销 Ctrl+Shift+Z" disabled={!glyphRedo.length || busy} style={!glyphRedo.length || busy ? styles.iconButtonDisabled : styles.iconButton} onClick={() => void redoGlyphList()}><i className="ri-arrow-go-forward-line" /></button>
            <button title="导入字形素材" disabled={!selectedCodes.length || busy} style={!selectedCodes.length || busy ? styles.iconButtonDisabled : styles.iconButton} onClick={() => void importGlyphFilesToList()}><i className="ri-import-fill" /></button>
            <button title="导出选中字形" disabled={!selectedCodes.length || busy} style={!selectedCodes.length || busy ? styles.iconButtonDisabled : styles.iconButton} onClick={() => void exportSelectedProjectGlyphs()}><i className="ri-export-fill" /></button>
            <button title="色盘" style={glyphColorPanelOpen ? styles.activeIconButton : styles.iconButton} onClick={() => setGlyphColorPanelOpen(value => { if (value) setGlyphPaintMode(false); return !value; })}>🎨</button>    
            <button title="批整理" disabled={busy || batchBusy} style={busy || batchBusy ? styles.iconButtonDisabled : styles.iconButton} onClick={() => setBatchPanelOpen(true)}><i className="ri-sparkling-fill" /></button>
           {glyphColorPanelOpen && <button title="着色器" style={glyphPaintMode ? styles.activeIconButton : styles.iconButton} onClick={() => setGlyphPaintMode(value => !value)}>🔫</button>}
            {glyphColorPanelOpen && <div style={styles.glyphColorStrip}>
              {['#111111', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#5e35b1', '#8e24aa', '#6d4c41', '#ffffff', '#9e9e9e'].map(color => (
                <button key={color} title={color} style={{ ...styles.colorSwatchSmall, background: color, outline: glyphActiveColor === color ? `2px solid ${COLORS.ACCENT}` : 'none' }} onClick={() => setGlyphActiveColor(color)} />
              ))}
              <input type="color" value={glyphActiveColor} onChange={event => setGlyphActiveColor(event.target.value)} style={styles.colorInputSmall} />
            </div>}                    
            <span style={styles.findGroup}>
              <input ref={findRef} value={findTip || jumpText} onChange={event => { setFindTip(''); setJumpText(event.target.value); }} onFocus={() => findTip && setFindTip('')} onKeyDown={event => { if (event.key === 'Enter') jumpToCode(); }} placeholder="" style={{ ...styles.findInput, ...(findTip ? styles.findInputTip : {}) }} />
              <button style={styles.findButton} onClick={() => jumpToCode()}>找字</button>
            </span>
 
            <label style={styles.inlineLabel}>每页</label>
            <select value={glyphPageSize} onChange={event => setGlyphPageSize(Number(event.target.value))} style={styles.statSelect}>
              {[500, 1000, 2000, 3000, 5000, 10000].map(value => <option key={value} value={value}>{value} 字</option>)}
            </select>
            <button style={styles.secondaryButton} disabled={safeGlyphPage <= 1} onClick={() => setGlyphPage(page => Math.max(1, page - 1))}>上一页</button>
            <span style={styles.pageText}>{safeGlyphPage}/{pageCount}</span>
            <button style={styles.secondaryButton} disabled={safeGlyphPage >= pageCount} onClick={() => setGlyphPage(page => Math.min(pageCount, page + 1))}>下一页</button>
            {/* <span style={styles.countText}>{codes.length} / {filteredCodes.length}，总数 {project?.codes?.length || 0}</span> */}
            <span style={styles.countText}>{codes.length} / {filteredCodes.length}</span>
            <button
              style={styles.fullScreenButton}
              onClick={() => setGlyphFullScreen(value => !value)}
              title={glyphFullScreen ? '退出全屏' : '全屏'}
            >
              <i className="ri-expand-diagonal-fill" />
            </button>
            <button
              style={styles.fullScreenButton}
              onClick={closeProject}
              title="关闭工程"
            >
              <i className="ri-close-line" />
            </button>
          </div>
          {!isEditorActive && renderEditorTabs()}
          <div ref={gridRef} style={{ ...(glyphFullScreen ? styles.gridFull : styles.grid), gridTemplateColumns: `repeat(auto-fill, minmax(${previewSize + 42}px, ${previewSize + 42}px))` }} onWheel={handleGlyphGridWheel} onMouseDown={beginBoxSelection} onMouseMove={moveBoxSelection} onMouseUp={() => setSelectionBox(null)} onMouseLeave={() => selectionBox && setSelectionBox(null)} onContextMenu={event => { if (event.target === event.currentTarget) { event.preventDefault(); setGlyphMenu(null); } }}>
            <LoadingOverlay visible={glyphGridLoading} />
            {codes.map(code => {
              const glyph = project?.glyphs?.[String(code)] as GlyphData | undefined;
              const path = glyphSvgPath(glyph, project?.upm, project?.ascent, project?.descent);
              const colorGroups = glyphSvgColorGroups(glyph, project?.upm, project?.ascent, project?.descent);
              const designed = hasGlyphContours(glyph);
              const savedEmpty = hasProjectGlyphRecord(project?.glyphs, code) && !designed;
              const selected = selectedCodes.includes(code);
              const isOpen = editorTabs.some(t => t.code === code);
              return (
                <button data-glyph-code={code} key={code} style={{ ...(designed ? styles.glyphCellDone : styles.glyphCell), ...(selected ? styles.glyphCellSelected : {}), ...(isOpen ? styles.glyphCellOpen : {}), ...(glyphPaintMode ? styles.glyphCellPaintMode : {}), width: previewSize + 42, height: previewSize + 34, position: 'relative' }} onMouseDown={event => event.stopPropagation()} onClick={event => void clickGlyphCell(code, event)} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); void openGlyphTargets(code); }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!selected) { setSelectedCodes([code]); lastSelectedCodeRef.current = code; } setGlyphMenu({ x: event.clientX, y: event.clientY, code }); }}>
                  {designed && <span style={styles.glyphDesignedDot} aria-hidden="true" />}
                  {refFontMode !== 'empty' && (
                    <span style={{ ...styles.refChar, width: previewSize, height: previewSize, fontSize: Math.max(14, previewSize * 0.72), fontFamily: `"${refFont}", serif`, zIndex: refFontMode === 'overlay' ? 2 : 0 }} aria-hidden="true">{String.fromCodePoint(code)}</span>
                  )}
                  {path ? <svg width={previewSize} height={previewSize} viewBox="0 0 82 82" style={{ position: 'relative', zIndex: 1 }}>
                      {colorGroups.length ? colorGroups.map(item => <path key={item.color} d={item.data} fill={item.color} fillRule="nonzero" />) : <path d={path} fill="black" fillRule="evenodd" />}
                    </svg>
                    : savedEmpty ? (
                      <span style={{ ...styles.char, width: previewSize, height: previewSize, fontSize: Math.max(14, previewSize * 0.72), position: 'relative', zIndex: 1 }} aria-hidden="true" />
                    )
                    : (
                      <span style={{ ...styles.char, width: previewSize, height: previewSize, fontSize: Math.max(14, previewSize * 0.72), fontFamily: projectFontFace ? `"${projectFontFace}", serif` : `"${refFont}", serif`, color: '#111111', position: 'relative', zIndex: 1 }}>{String.fromCodePoint(code)}</span>
                    )}
                  <span style={{ ...styles.code, position: 'relative', zIndex: 1 }}>U+{code.toString(16).toUpperCase().padStart(4, '0')}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {editorTabs.filter(tab => tab.floating).map(tab => {
        const glyphData = editorRefs.current.get(tab.id) || tab.glyphData;
        const rect = tab.floatRect || { left: 80, top: 90, width: 980, height: 680 };
        const char = String.fromCodePoint(tab.code);
        const hex = tab.code.toString(16).toUpperCase().padStart(4, '0');
        return (
          <div key={`floating-editor-${tab.id}`} style={{ ...styles.floatingEditor, left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
            <div
              style={tab.id === activeTabId ? styles.floatingTitleActive : styles.floatingTitle}
              onMouseDown={event => {
                event.preventDefault();
                event.stopPropagation();
                setActiveTabId(tab.id);
                setDragTabId(tab.id);
                setTabDrag({ id: tab.id, startX: event.clientX, startY: event.clientY, moved: false, originRect: rect });
              }}
              title="拖到标签合并区可自动停靠"
            >
              <i className="ri-drag-move-2-fill" />
              <span style={styles.floatingTitleText}>{char} U+{hex}</span>
              <span style={styles.floatingActions}>
                {false && <button style={styles.floatingActionButton} title="停靠回选项卡" onMouseDown={event => event.stopPropagation()} onClick={() => dockFloatingTab(tab.id)}><i className="ri-layout-top-line" /></button>}
                <button style={styles.floatingActionButton} title="关闭" onMouseDown={event => event.stopPropagation()} onClick={() => void closeTab(tab.id)}><i className="ri-close-line" /></button>
              </span>
            </div>
            <div style={styles.floatingEditorBody}>
            <GlyphEditor
              key={`${tab.id}-${tab.code}-floating`}
              code={tab.code}
              codes={editorCodes}
              initialGlyph={glyphData}
              metrics={{ upm: project?.upm || 1024, ascent: project?.ascent || 880, descent: project?.descent || -144 }}
              family={project?.family || ''}
                refFont={refFont}
                refFontMode={refFontMode}
                previewFontFace={projectFontFace}
                floatingCompact
                onClose={(options) => {
                const data = editorRefs.current.get(tab.id);
                if (!options?.skipAutoSave && data) void saveGlyph(tab.code, data);
                closeTab(tab.id);
              }}
              onSave={(code, data) => handleEditorSaveForTab(tab.id, code, data)}
              onChangeCode={(nextCode, data) => changeGlyphCodeForTab(tab.id, tab.code, nextCode, data)}
              usedGlyphNames={usedGlyphNames}
              onExport={exportOneProjectGlyph}
              onNavigate={(delta, data) => { setActiveTabId(tab.id); return navigateGlyph(delta, data); }}
              onJump={(code, data) => { setActiveTabId(tab.id); return jumpFromEditor(code, data); }}
              onChange={(data) => handleEditorChangeForTab(tab.id, data)}
            />
            </div>
            {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as FloatingResizeEdge[]).map(edge => (
              <div
                key={`${tab.id}-${edge}`}
                style={{ ...styles.floatResizeHandle, ...floatResizeHandleStyle(edge) }}
                onMouseDown={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveTabId(tab.id);
                  setFloatResize({ id: tab.id, edge, startX: event.clientX, startY: event.clientY, rect });
                }}
              />
            ))}
          </div>
        );
      })}

      {!isEditorActive && (
      <section style={recordsCollapsed ? styles.recentPanelCollapsed : styles.recentPanel}>
        <h3 style={styles.subTitle}>最近工程/产物</h3>
        <button type="button" title={recordsCollapsed ? '展开' : '折叠'} style={styles.collapseButtonInTitle} onClick={toggleRecordsCollapsed}><i className={recordsCollapsed ? 'ri-arrow-up-wide-fill' : 'ri-arrow-down-wide-fill'} /></button>
        {!recordsCollapsed && <div style={styles.records}>
          {records.slice(0, 30).map(record => {
            const outputFile = String(record.output_file || '');
            const isProject = outputFile.toLowerCase().endsWith('.z01');
            return <div key={record.id} style={styles.recordRow}>
              <button style={styles.recordOpen} disabled={!isProject} onDoubleClick={() => isProject && openProject(outputFile)} onContextMenu={event => { event.preventDefault(); setRecordMenu({ x: event.clientX, y: event.clientY, record }); }} title={outputFile}><span style={styles.recordTime}>{record.timestamp}</span><span style={styles.recordPath}>{outputFile}</span></button>
              <button style={styles.locateButton} onClick={() => void locateRecordPath(outputFile)}>定位目录</button>
            </div>;
          })}
        </div>}
      </section>
      )}

      {batchPanelOpen && (
        <div style={styles.batchBackdrop} onClick={event => event.stopPropagation()}>
          <section style={styles.batchPanel}>
            <header style={styles.batchHeader}>
              <div>
                <h2 style={styles.batchTitle}>批整理</h2>
                <p style={styles.batchSubtitle}>对工程字形进行批量化处理</p>
              </div>
              <button style={styles.iconClose} title="关闭" disabled={batchBusy} onClick={() => !batchBusy && setBatchPanelOpen(false)}><i className="ri-close-line" /></button>
            </header>
            <div style={styles.batchBody}>
              <section style={styles.batchCard}>
                <div style={styles.batchCardHead}>
                  <div style={styles.batchCardIntro}>
                    <h3 style={styles.batchCardTitle}>智能导入</h3>
                    <p style={styles.batchHint}>根据目标源的文件名批量导入 | 建议文件分辨率相同，文件名可以是字码或者字符本身，如：永.eps、6C38.eps 均合法。</p>
                  </div>
                  <button style={batchBusy ? styles.iconButtonDisabled : styles.batchActionButton} disabled={batchBusy} onClick={() => void runSmartBatchImport()}>选择文件并导入</button>
                </div>
                <div style={styles.batchControls}>
                <label style={styles.batchField}>导入缩放比
                  <input type="number" min={1} max={500} step={1} value={batchImportScale} style={styles.batchInput} onChange={event => setBatchImportScale(Number(event.target.value) || 100)} />
                  <span style={styles.batchUnit}>%</span>
                </label>
                </div>
              </section>

              <section style={styles.batchCard}>
                <div style={styles.batchCardHead}>
                  <div style={styles.batchCardIntro}>
                    <h3 style={styles.batchCardTitle}>字高处理</h3>
                    <p style={styles.batchHint}>当前推荐字高：{batchRecommendedMetrics.height || '暂无'}</p>
                  </div>
                  <button style={batchBusy ? styles.iconButtonDisabled : styles.batchActionButton} disabled={batchBusy} onClick={() => void runBatchHeight()}>处理字高</button>
                </div>
                <div style={styles.batchControls}>
                <select value={batchScope} style={styles.batchSelect} onChange={event => setBatchScope(event.target.value as BatchScope)}>
                  <option value="all">所有字符</option>
                  <option value="cjk">所有CJK字符</option>
                  <option value="selected">仅选字符</option>
                </select>
                <label style={styles.batchField}>目标字高
                  <input type="number" min={1} step={1} value={batchHeightValue} style={styles.batchInput} onChange={event => setBatchHeightValue(event.target.value)} />
                </label>
                <label style={styles.batchCheckLabel}><input type="checkbox" checked={batchHeightScaleElements} onChange={event => setBatchHeightScaleElements(event.target.checked)} />字符元素同步变换</label>
                </div>
              </section>

              <section style={styles.batchCard}>
                <div style={styles.batchCardHead}>
                  <div style={styles.batchCardIntro}>
                    <h3 style={styles.batchCardTitle}>字宽处理</h3>
                    <p style={styles.batchHint}>当前推荐字宽：{batchRecommendedMetrics.width || '暂无'}</p>
                  </div>
                  <button style={batchBusy ? styles.iconButtonDisabled : styles.batchActionButton} disabled={batchBusy} onClick={() => void runBatchWidth()}>处理字宽</button>
                </div>
                <div style={styles.batchControls}>
                <select value={batchScope} style={styles.batchSelect} onChange={event => setBatchScope(event.target.value as BatchScope)}>
                  <option value="all">所有字符</option>
                  <option value="cjk">所有CJK字符</option>
                  <option value="selected">仅选字符</option>
                </select>
                <label style={styles.batchField}>目标字宽
                  <input type="number" min={1} step={1} value={batchWidthValue} style={styles.batchInput} onChange={event => setBatchWidthValue(event.target.value)} />
                </label>
                <label style={styles.batchCheckLabel}><input type="checkbox" checked={batchWidthScaleElements} onChange={event => setBatchWidthScaleElements(event.target.checked)} />字符元素同步变换</label>
                </div>
              </section>

              <section style={styles.batchCard}>
                <div style={styles.batchCardHead}>
                  <div style={styles.batchCardIntro}>
                    <h3 style={styles.batchCardTitle}>字体变形</h3>
                    <p style={styles.batchHint}>对字符形态进行批量变异、变细、加粗处理。</p>
                  </div>
                  <button style={batchBusy ? styles.iconButtonDisabled : styles.batchActionButton} disabled={batchBusy} onClick={() => void runBatchDeform()}>执行变形</button>
                </div>
                <div style={styles.batchControls}>
                  <select value={batchDeformScope} style={styles.batchSelect} onChange={event => setBatchDeformScope(event.target.value as BatchScope)}>
                    <option value="all">所有字符</option>
                    <option value="cjk">所有CJK字符</option>
                    <option value="selected">仅选字符</option>
                  </select>
                  <select value={batchDeformMode} style={styles.batchSelect} onChange={event => setBatchDeformMode(event.target.value as BatchDeformMode)}>
                    <option value="variant">变异</option>
                    <option value="thin">变细</option>
                    <option value="bold">加粗</option>
                  </select>
                  <label style={styles.batchField}>阀值
                    <input type="number" min={0} max={100} step={1} value={batchDeformPercent} style={styles.batchInput} onChange={event => setBatchDeformPercent(Number(event.target.value) || 0)} />
                    <span style={styles.batchUnit}>%</span>
                  </label>
                </div>
              </section>
            </div>
            <footer style={styles.batchFooter}>
              {batchProgress.total > 0 && (
                <div style={styles.batchProgressPanel}>
                  <span>{batchProgress.message}</span>
                  <span>{batchProgress.current}/{batchProgress.total}</span>
                  <div style={styles.batchProgressTrack}><div style={{ ...styles.batchProgressBar, width: `${Math.round((batchProgress.current / Math.max(1, batchProgress.total)) * 100)}%` }} /></div>
                </div>
              )}
              <button style={styles.secondaryButton} disabled={batchBusy} onClick={() => setBatchPanelOpen(false)}>关闭</button>
            </footer>
          </section>
        </div>
      )}

      {batchConfirm && (
        <div style={styles.batchConfirmBackdrop} onClick={event => event.stopPropagation()}>
          <div style={styles.batchConfirmDialog}>
            <div style={styles.confirmIcon}><i className="ri-alert-line" /></div>
            <div style={styles.confirmContent}>
              <div style={styles.confirmTitle}>{batchConfirm.title}</div>
              <div style={styles.confirmText}>{batchConfirm.message}</div>
            </div>
            <div style={styles.confirmActions}>
              <button style={styles.secondaryButton} onClick={() => setBatchConfirm(null)}>取消</button>
              <button
                style={styles.batchDangerButton}
                autoFocus
                onClick={() => {
                  const action = batchConfirm.run;
                  setBatchConfirm(null);
                  action();
                }}
              >继续</button>
            </div>
          </div>
        </div>
      )}

      {selectionBox && <div style={{ ...styles.selectionBox, left: Math.min(selectionBox.x1, selectionBox.x2), top: Math.min(selectionBox.y1, selectionBox.y2), width: Math.abs(selectionBox.x2 - selectionBox.x1), height: Math.abs(selectionBox.y2 - selectionBox.y1) }} />}
      {glyphMenu && <div style={{ ...styles.contextMenu, left: glyphMenu.x, top: glyphMenu.y }} onClick={event => event.stopPropagation()}>
        <button style={styles.contextMenuItem} onClick={() => void openGlyphTargets(glyphMenu.code)}>打开字符{selectedCodes.length > 1 && selectedCodes.includes(glyphMenu.code) ? `（${selectedCodes.length}）` : ''}</button>
        <button style={styles.contextMenuItem} onClick={() => { setGlyphMenu(null); void exportSelectedProjectGlyphs(); }}>导出字符{selectedCodes.length > 1 && selectedCodes.includes(glyphMenu.code) ? `（${selectedCodes.length}）` : ''}</button>
        <button style={styles.contextMenuItem} onClick={() => { setSelectedCodes([]); setGlyphMenu(null); }}>清除所选</button>
        <button style={styles.contextMenuItem} onClick={() => void clearGlyphContoursFromList(selectedCodes.includes(glyphMenu.code) ? selectedCodes : [glyphMenu.code])}>清空字形{selectedCodes.length > 1 && selectedCodes.includes(glyphMenu.code) ? `（${selectedCodes.length}）` : ''}</button>
        <button style={styles.contextMenuItem} onClick={() => void deleteCodes(selectedCodes.includes(glyphMenu.code) ? selectedCodes : [glyphMenu.code])}>删除字符{selectedCodes.length > 1 && selectedCodes.includes(glyphMenu.code) ? `（${selectedCodes.length}）` : ''}</button>
        <button style={styles.contextMenuItem} onClick={() => { setAddDialog({ anchor: glyphMenu.code, mode: 'beforeCodes', value: '' }); setGlyphMenu(null); }}>添加字符...</button>
        <button style={styles.contextMenuItem} onClick={() => openGlyphProperties(glyphMenu.code, glyphMenu.x, glyphMenu.y)}>属性</button>
      </div>}
      {glyphPropertyDock && glyphPropertyData && (
        <div style={{ ...styles.glyphPropertyDock, left: glyphPropertyDock.left, top: glyphPropertyDock.top }} onClick={event => event.stopPropagation()}>
          <div
            style={styles.glyphPropertyDockTitle}
            onMouseDown={event => {
              event.preventDefault();
              setGlyphPropertyDrag({ startX: event.clientX, startY: event.clientY, left: glyphPropertyDock.left, top: glyphPropertyDock.top });
            }}
          >
            <span>属性 {String.fromCodePoint(glyphPropertyDock.code)} {codeLabel(glyphPropertyDock.code)}</span>
            <button style={styles.glyphPropertyClose} title="关闭" onMouseDown={event => event.stopPropagation()} onClick={() => setGlyphPropertyDock(null)}>
              <i className="ri-close-line" />
            </button>
          </div>
          <div style={styles.glyphPropertyBody}>
            <div style={styles.glyphPropertyPreview}>{String.fromCodePoint(glyphPropertyDock.code)}</div>
            <div style={styles.glyphPropertyStack}>
              <label style={styles.glyphPropertyLabel}>字宽</label>
              <input type="number" min={0} step={1} value={glyphPropertyDrafts.advance} style={styles.glyphPropertyInput} onChange={event => updateGlyphPropertyDraft('advance', event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void commitGlyphPropertyAdvance(); if (event.key === 'Escape') updateGlyphPropertyDraft('advance', String(glyphPropertyData.advance)); }} onBlur={() => void commitGlyphPropertyAdvance()} />
              <label style={styles.glyphPropertyLabel}>字码点</label>
              <input value={glyphPropertyDrafts.code} style={styles.glyphPropertyInput} onChange={event => updateGlyphPropertyDraft('code', event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void commitGlyphPropertyCode(); if (event.key === 'Escape') updateGlyphPropertyDraft('code', codeLabel(glyphPropertyDock.code)); }} onBlur={() => void commitGlyphPropertyCode()} />
              {glyphPropertyTip && <div style={styles.glyphPropertyTip}>{glyphPropertyTip}</div>}
              <label style={styles.glyphPropertyLabel}>字符名</label>
              <input value={glyphPropertyDrafts.glyphName} style={styles.glyphPropertyInput} onChange={event => updateGlyphPropertyDraft('glyphName', event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void commitGlyphPropertyName(); if (event.key === 'Escape') updateGlyphPropertyDraft('glyphName', glyphPropertyData.glyphName); }} onBlur={() => void commitGlyphPropertyName()} />
              <label style={styles.glyphPropertyLabel}>元素离左</label>
              <input type="number" step={1} value={glyphPropertyDrafts.left} style={styles.glyphPropertyInput} onChange={event => updateGlyphPropertyDraft('left', event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void commitGlyphPropertyLeft(); if (event.key === 'Escape') updateGlyphPropertyDraft('left', String(glyphPropertyData.leftBearing)); }} onBlur={() => void commitGlyphPropertyLeft()} />
              <label style={{ ...styles.glyphPropertyLabel, ...styles.glyphPropertyLast }}>元素离右</label>
              <input type="number" step={1} value={glyphPropertyDrafts.right} style={{ ...styles.glyphPropertyInput, ...styles.glyphPropertyLast }} onChange={event => updateGlyphPropertyDraft('right', event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void commitGlyphPropertyRight(); if (event.key === 'Escape') updateGlyphPropertyDraft('right', String(glyphPropertyData.rightBearing)); }} onBlur={() => void commitGlyphPropertyRight()} />
            </div>
          </div>
        </div>
      )}
      {recordMenu && <div style={{ ...styles.contextMenu, left: recordMenu.x, top: recordMenu.y }} onClick={event => event.stopPropagation()}>
        <button style={styles.contextMenuItem} onClick={() => { const outputFile = String(recordMenu.record.output_file || ''); setRecordMenu(null); if (outputFile.toLowerCase().endsWith('.z01')) void openProject(outputFile); }}>打开工程</button>
        <button style={styles.contextMenuItem} onClick={() => void saveRecordProjectAs(recordMenu.record)}>另存为</button>
        <button style={styles.contextMenuItem} onClick={() => void deleteRecord(recordMenu.record.id)}>删除记录</button>
      </div>}
      {addDialog && <div style={styles.modalBackdrop}>
        <div style={styles.addDialog} onClick={event => event.stopPropagation()}>
          <h3 style={styles.dialogTitle}>添加字符</h3>
          <div style={styles.anchorInfo}>基准字符：U+{addDialog.anchor.toString(16).toUpperCase().padStart(4, '0')} {String.fromCodePoint(addDialog.anchor)}</div>
          <label style={styles.dialogLabel}>添加方式</label>
          <select style={styles.dialogInput} value={addDialog.mode} onChange={event => setAddDialog({ ...addDialog, mode: event.target.value as typeof addDialog.mode, value: '' })}>
            <option value="beforeCodes">在本字符前添加指定 Unicode</option>
            <option value="afterCodes">在本字符后添加指定 Unicode</option>
            <option value="beforeCount">在本字符前按 Unicode 顺序添加指定个数</option>
            <option value="afterCount">在本字符后按 Unicode 顺序添加指定个数</option>
          </select>
          <label style={styles.dialogLabel}>{addDialog.mode.endsWith('Codes') ? 'Unicode 码或字符（可输入多个）' : '添加个数'}</label>
          {addDialog.mode.endsWith('Codes')
            ? <textarea autoFocus style={styles.dialogTextarea} value={addDialog.value} onChange={event => setAddDialog({ ...addDialog, value: event.target.value })} placeholder="例如：U+4E00 U+4E01，或直接输入字符" />
            : <input autoFocus type="number" min={1} max={10000} style={styles.dialogInput} value={addDialog.value} onChange={event => setAddDialog({ ...addDialog, value: event.target.value })} placeholder="请输入数量" />}
          <div style={styles.dialogHint}>已存在的 Unicode 会自动跳过，不影响其它字符创建。</div>
          <div style={styles.dialogActions}><button style={styles.secondaryButton} onClick={() => setAddDialog(null)}>取消</button><button style={styles.primaryButton} onClick={() => void submitAddCharacters()}>添加</button></div>
        </div>
      </div>}
      {pendingDeleteCodes && (() => {
        const label = pendingDeleteCodes.length === 1
          ? `U+${pendingDeleteCodes[0].toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(pendingDeleteCodes[0])}`
          : `${pendingDeleteCodes.length} 个字符`;
        return (
          <div style={styles.modalBackdrop} onClick={() => setPendingDeleteCodes(null)}>
            <div style={styles.confirmDialog} onClick={event => event.stopPropagation()}>
              <div style={styles.confirmIcon}><i className="ri-delete-bin-6-line" /></div>
              <div style={styles.confirmContent}>
                <div style={styles.confirmTitle}>删除字符？</div>
                <div style={styles.confirmText}>确定删除 {label}？此操作不可恢复，相关字形设计数据也会被删除。</div>
              </div>
              <div style={styles.confirmActions}>
                <button style={styles.secondaryButton} onClick={() => setPendingDeleteCodes(null)}>取消</button>
                <button style={styles.dangerButton} autoFocus onClick={() => void confirmDeleteCodes()}>删除</button>
              </div>
            </div>
          </div>
        );
      })()}
      {pendingCloseTab !== null && (() => {
        const tab = editorTabs.find(item => item.id === pendingCloseTab);
        if (!tab) return null;
        const hex = tab.code.toString(16).toUpperCase().padStart(4, '0');
        return (
          <div style={styles.modalBackdrop} onClick={() => setPendingCloseTab(null)}>
            <div style={styles.confirmDialog} onClick={event => event.stopPropagation()}>
              <div style={styles.confirmIcon}><i className="ri-save-3-line" /></div>
              <div style={styles.confirmContent}>
                <div style={styles.confirmTitle}>保存字形修改？</div>
                <div style={styles.confirmText}>字形 {String.fromCodePoint(tab.code)} U+{hex} 有未保存的设计修改。关闭前可以保存，也可以放弃本次修改。</div>
              </div>
              <div style={styles.confirmActions}>
                <button style={styles.secondaryButton} onClick={() => setPendingCloseTab(null)}>取消</button>
                <button style={styles.dangerButton} onClick={() => void discardAndCloseTab(tab.id)}>不保存关闭</button>
                <button style={styles.primaryButton} autoFocus onClick={() => void saveAndCloseTab(tab.id)}>保存并关闭</button>
              </div>
            </div>
          </div>
        );
      })()}
      {publishDialogOpen && (
        <div style={styles.modalBackdrop} onClick={() => { if (!publishBusy) setPublishDialogOpen(false); }}>
          <div style={styles.publishDialog} onClick={event => event.stopPropagation()}>
            <div style={styles.publishTitleRow}>
              <h3 style={styles.dialogTitle}>发布字体</h3>
              <button
                style={styles.publishSettingsButton}
                disabled={publishBusy}
                title="打开设置"
                onClick={() => { setPublishDialogOpen(false); openMetadataDialog(); }}
              >
                <i className="ri-settings-fill" />
              </button>
            </div>
            <div style={styles.publishSummary}>
              <button type="button" style={styles.publishTextButton} disabled={publishBusy} onClick={() => { setPublishDialogOpen(false); onOpenSettings?.('publish'); }}>默认字体类型：{publishDialog.fontType.toUpperCase()}</button>
              <button type="button" style={styles.publishTextButton} disabled={publishBusy} onClick={() => { setPublishDialogOpen(false); onOpenSettings?.('publish'); }}>当前色彩模式：{colorModeLabel(publishDialog.colorMode)}</button>
              <span>彩色字体位置偏移：X {publishDialog.colorOffsetX}% / Y {publishDialog.colorOffsetY}%</span>
            </div>
            {/* <label style={{ color: COLORS.TEXT, fontSize: 13 }}>发布路径</label> */}
            <div style={styles.row}>
              <input disabled={publishBusy} value={publishDialog.outputPath} onChange={event => setPublishDialog({ ...publishDialog, outputPath: event.target.value })} style={{ ...styles.dialogInput, flex: 1,fontSize: 13 }} />
              <button style={styles.secondaryButton} disabled={publishBusy} onClick={async () => {
                const file = await window.electronAPI.saveFile({
                  title: '选择字体保存位置',
                  defaultPath: publishDialog.outputPath || undefined,
                  filters: [{ name: '字体文件', extensions: [publishDialog.fontType] }],
                });
                if (file) setPublishDialog({ ...publishDialog, outputPath: file });
              }}>选择位置</button>
            </div>
            <label style={styles.publishCheckLabel}>
              <input type="checkbox" checked={publishOpenDir} onChange={e => setPublishOpenDir(e.target.checked)} disabled={publishBusy} />
              <span>发布成功后打开目标文件夹</span>
            </label>
            {publishBusy && (
              <div style={styles.publishProgressPanel}>
                <div style={styles.publishProgressText}><span>{publishStatus || '正在发布字体...'}</span><strong>{Math.round(publishProgress)}%</strong></div>
                <div style={styles.publishProgressTrack}><div style={{ ...styles.publishProgressBar, width: `${publishProgress}%` }} /></div>
              </div>
            )}
            <div style={styles.dialogActions}>
              <button style={styles.secondaryButton} disabled={publishBusy} onClick={() => setPublishDialogOpen(false)}>取消</button>
              <button style={styles.primaryButton} disabled={publishBusy} onClick={() => void confirmPublish()}>{publishBusy ? '发布中...' : '确认发布'}</button>
            </div>
          </div>
        </div>
      )}
      {metadataDialogOpen && metadataDraft && (
        <div style={styles.modalBackdrop}>
          <div style={metadataMaximized ? styles.metadataDialogMax : styles.metadataDialog} onClick={event => event.stopPropagation()}>
            <div style={styles.metadataHeader}>
              <h3 style={styles.dialogTitle}>工程属性</h3>
              <div style={styles.metadataHeaderActions}>
                <button style={styles.iconClose} title={metadataMaximized ? '还原' : '放大'} onClick={() => setMetadataMaximized(value => !value)}>
                  <i className={metadataMaximized ? 'ri-contract-left-right-line' : 'ri-expand-diagonal-fill'} />
                </button>
                <button style={styles.iconClose} title="关闭" onClick={() => setMetadataDialogOpen(false)}>
                  <i className="ri-close-line" />
                </button>
              </div>
            </div>
            <div style={styles.metadataTabs}>
              {[
                ['font', '基本属性'],
                ['metrics', '宽高与度量'],
                ['extended', '扩展信息'],
                ['variation', '轴 / 母版 / 实例'],
                ['supplement', '补充设定'],
              ].map(([key, label]) => (
                <button key={key} style={metadataTab === key ? styles.metadataTabActive : styles.metadataTab} onClick={() => setMetadataTab(key as MetadataTab)}>{label}</button>
              ))}
            </div>
            <div style={styles.metadataBody}>
              {metadataTab === 'font' && (
                <>
                  <div style={styles.metadataGroup}>
                    <h4 style={styles.groupTitle}>常规</h4>
                    <div style={styles.metadataGrid}>
                      <MetaInput label="英文字体名称" value={metadataDraft.names.familyEn} onChange={value => patchMetadata('names', 'familyEn', value)} />
                      <MetaInput label="中文字体名称" value={metadataDraft.names.familyZh} onChange={value => patchMetadata('names', 'familyZh', value)} />
                      <MetaInput label="英文样式" value={metadataDraft.names.styleEn} onChange={value => patchMetadata('names', 'styleEn', value)} />
                      <MetaInput label="中文样式" value={metadataDraft.names.styleZh} onChange={value => patchMetadata('names', 'styleZh', value)} />
                      <MetaInput label="英文全名" value={metadataDraft.names.fullNameEn} onChange={value => patchMetadata('names', 'fullNameEn', value)} />
                      <MetaInput label="中文全名" value={metadataDraft.names.fullNameZh} onChange={value => patchMetadata('names', 'fullNameZh', value)} />
                      <MetaInput label="PostScript 名称" value={metadataDraft.names.postScriptName} onChange={value => patchMetadata('names', 'postScriptName', value)} />
                      <MetaInput label="版本" value={metadataDraft.names.version} onChange={value => patchMetadata('names', 'version', value)} />
                      <MetaInput label="唯一标识" value={metadataDraft.names.uniqueId} onChange={value => patchMetadata('names', 'uniqueId', value)} />
                    </div>
                  </div>
                  <div style={styles.metadataGroup}>
                    <h4 style={styles.groupTitle}>法律</h4>
                    <div style={styles.metadataGrid}>
                      <MetaInput label="版权声明（中文）" value={metadataDraft.legal.copyrightZh} onChange={value => patchMetadata('legal', 'copyrightZh', value)} />
                      <MetaInput label="Copyright" value={metadataDraft.legal.copyrightEn} onChange={value => patchMetadata('legal', 'copyrightEn', value)} />
                      <MetaInput label="商标（中文）" value={metadataDraft.legal.trademarkZh} onChange={value => patchMetadata('legal', 'trademarkZh', value)} />
                      <MetaInput label="Trademark" value={metadataDraft.legal.trademarkEn} onChange={value => patchMetadata('legal', 'trademarkEn', value)} />
                      <MetaInput label="厂商 ID" value={metadataDraft.legal.vendorId} onChange={value => patchMetadata('legal', 'vendorId', value.slice(0, 4))} />
                    </div>
                  </div>
                </>
              )}
              {metadataTab === 'metrics' && (
                <div style={styles.metadataGroup}>
                  <h4 style={styles.groupTitle}>水平与垂直布局</h4>
                  <div style={styles.metricGrid}>
                    {[
                      ['unitsPerEm', '每格宽度 / UPM'],
                      ['ascender', '上行值'],
                      ['descender', '下行值'],
                      ['lineGap', '行间距'],
                      ['winAscent', 'Windows 上行'],
                      ['winDescent', 'Windows 下行'],
                      ['xHeight', '小写高度'],
                      ['capHeight', '大写高度'],
                      ['italicAngle', '倾斜角度'],
                      ['underlinePosition', '下划线位置'],
                      ['underlineThickness', '下划线厚度'],
                    ].map(([key, label]) => (
                      <MetaInput key={key} type="number" label={label} value={metadataDraft.metrics[key] ?? 0} onChange={value => patchMetadata('metrics', key, Number(value))} />
                    ))}
                  </div>
                </div>
              )}
              {metadataTab === 'extended' && (
                <div style={styles.metadataGroup}>
                  <h4 style={styles.groupTitle}>厂商、设计师、许可与示例文本</h4>
                  <div style={styles.metadataGrid}>
                    <MetaInput label="厂商（中文）" value={metadataDraft.legal.manufacturerZh} onChange={value => patchMetadata('legal', 'manufacturerZh', value)} />
                    <MetaInput label="Manufacturer" value={metadataDraft.legal.manufacturerEn} onChange={value => patchMetadata('legal', 'manufacturerEn', value)} />
                    <MetaInput label="设计师（中文）" value={metadataDraft.legal.designerZh} onChange={value => patchMetadata('legal', 'designerZh', value)} />
                    <MetaInput label="Designer" value={metadataDraft.legal.designerEn} onChange={value => patchMetadata('legal', 'designerEn', value)} />
                    <MetaInput label="厂商网站" value={metadataDraft.legal.vendorUrl} onChange={value => patchMetadata('legal', 'vendorUrl', value)} />
                    <MetaInput label="设计师网站" value={metadataDraft.legal.designerUrl} onChange={value => patchMetadata('legal', 'designerUrl', value)} />
                    <MetaInput label="许可协议（中文）" value={metadataDraft.legal.licenseZh} onChange={value => patchMetadata('legal', 'licenseZh', value)} />
                    <MetaInput label="License" value={metadataDraft.legal.licenseEn} onChange={value => patchMetadata('legal', 'licenseEn', value)} />
                    <MetaInput label="许可协议网站" value={metadataDraft.legal.licenseUrl} onChange={value => patchMetadata('legal', 'licenseUrl', value)} />
                    <MetaInput label="示例文本（中文）" value={metadataDraft.legal.sampleTextZh} onChange={value => patchMetadata('legal', 'sampleTextZh', value)} />
                    <MetaInput label="Sample Text" value={metadataDraft.legal.sampleTextEn} onChange={value => patchMetadata('legal', 'sampleTextEn', value)} />
                  </div>
                  <label style={styles.metaFieldWide}><span style={styles.metaLabel}>描述（中文）</span><textarea style={styles.metaTextarea} value={metadataDraft.legal.descriptionZh} onChange={event => patchMetadata('legal', 'descriptionZh', event.target.value)} /></label>
                  <label style={styles.metaFieldWide}><span style={styles.metaLabel}>Description</span><textarea style={styles.metaTextarea} value={metadataDraft.legal.descriptionEn} onChange={event => patchMetadata('legal', 'descriptionEn', event.target.value)} /></label>
                </div>
              )}
              {metadataTab === 'variation' && (
                <div style={styles.metadataGroup}>
                  <h4 style={styles.groupTitle}>变量字体预留</h4>
                  <div style={styles.metadataHint}>轴、母版、实例数据会保存到 .z01 工程包。本版发布引擎仍输出静态 glyf 字体，后续变量字体发布将直接读取这些结构。</div>
                  <label style={styles.metaFieldWide}><span style={styles.metaLabel}>轴定义 JSON</span><textarea style={styles.jsonTextarea} value={JSON.stringify(metadataDraft.axes || [], null, 2)} onChange={event => { try { setMetadataDraft({ ...metadataDraft, axes: JSON.parse(event.target.value) }); } catch {} }} /></label>
                  <label style={styles.metaFieldWide}><span style={styles.metaLabel}>母版 JSON</span><textarea style={styles.jsonTextarea} value={JSON.stringify(metadataDraft.masters || [], null, 2)} onChange={event => { try { setMetadataDraft({ ...metadataDraft, masters: JSON.parse(event.target.value) }); } catch {} }} /></label>
                  <label style={styles.metaFieldWide}><span style={styles.metaLabel}>实例 JSON</span><textarea style={styles.jsonTextarea} value={JSON.stringify(metadataDraft.instances || [], null, 2)} onChange={event => { try { setMetadataDraft({ ...metadataDraft, instances: JSON.parse(event.target.value) }); } catch {} }} /></label>
                </div>
              )}
              {metadataTab === 'supplement' && (
                <div style={styles.metadataGroup}>
                  <h4 style={styles.groupTitle}>彩色字体发布</h4>
                  <div style={styles.metadataGrid}>
                    <MetaInput type="number" label="彩色字体 X 轴偏移（% UPM）" value={metadataDraft.publish?.colorOffsetX ?? 0} onChange={value => patchMetadata('publish', 'colorOffsetX', Number(value))} />
                    <MetaInput type="number" label="彩色字体 Y 轴偏移（% 字体框高度）" value={metadataDraft.publish?.colorOffsetY ?? 0} onChange={value => patchMetadata('publish', 'colorOffsetY', Number(value))} />
                  </div>
                  <div style={styles.metadataHint}>此偏移随 .z01 工程保存，用于个别字体工程发布彩色字体时的最终微调。默认 0,0 表示彩色图层与黑白字形共享同一坐标原点和字宽。</div>
                </div>
              )}
            </div>
            <div style={styles.metadataFooter}>
              <button style={styles.secondaryButton} onClick={() => setMetadataDialogOpen(false)}>取消</button>
              <button style={styles.primaryButton} onClick={() => void saveProjectMetadata()}>保存工程属性</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const MetaInput: React.FC<{ label: string; value: any; type?: string; onChange: (value: string) => void }> = ({ label, value, type = 'text', onChange }) => (
  <label style={styles.metaField}>
    <span style={styles.metaLabel}>{label}</span>
    <input type={type} value={value ?? ''} onChange={event => onChange(event.target.value)} style={styles.metaInput} />
  </label>
);

function floatResizeHandleStyle(edge: FloatingResizeEdge): React.CSSProperties {
  const hit = 8;
  const corner = 14;
  const common: React.CSSProperties = { cursor: `${edge}-resize` };
  if (edge === 'n') return { ...common, left: corner, right: corner, top: -hit / 2, height: hit };
  if (edge === 's') return { ...common, left: corner, right: corner, bottom: -hit / 2, height: hit };
  if (edge === 'e') return { ...common, top: corner, bottom: corner, right: -hit / 2, width: hit };
  if (edge === 'w') return { ...common, top: corner, bottom: corner, left: -hit / 2, width: hit };
  if (edge === 'ne') return { ...common, top: -hit / 2, right: -hit / 2, width: corner, height: corner };
  if (edge === 'nw') return { ...common, top: -hit / 2, left: -hit / 2, width: corner, height: corner };
  if (edge === 'se') return { ...common, bottom: -hit / 2, right: -hit / 2, width: corner, height: corner };
  return { ...common, bottom: -hit / 2, left: -hit / 2, width: corner, height: corner };
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: '100%', maxWidth: 'none', height: '100%', minHeight: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 0 },
  card: { backgroundColor: COLORS.CARD, borderRadius: 8, padding: 20, marginBottom: 16, boxShadow: `0 2px 8px ${COLORS.BORDER}` },
  projectBar: { backgroundColor: COLORS.CARD, borderRadius: 0, padding: '10px 14px 8px', borderBottom: `1px solid ${COLORS.BORDER}`, flexShrink: 0 },
  // Tab bar
  tabBar: { display: 'flex', width: '100%', minHeight: 32, backgroundColor: '#fff', borderBottom: `1px solid ${COLORS.BORDER}`, borderRadius: 0, padding: 0, margin: 0, flexShrink: 0, overflow: 'hidden' },
  tabList: { display: 'flex', gap: 0, overflow: 'auto', alignItems: 'flex-end', justifyContent: 'flex-start', width: '100%' },
  tabReturn: { minHeight: 32, padding: '6px 14px', border: '1px solid #b9cbe0', borderLeft: 0, borderTop: 0, borderBottom: 0, borderRadius: 0, background: '#eef4fb', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, lineHeight: 1, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0 },
  tabReturnActive: { minHeight: 32, padding: '6px 14px', border: `1px solid ${COLORS.ACCENT}`, borderLeft: 0, borderTop: 0, borderBottom: 0, borderRadius: 0, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, fontWeight: 600, lineHeight: 1, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0 },
  tab: { minHeight: 32, padding: '6px 8px 6px 12px', border: '1px solid #b9cbe0', borderTop: 0, borderBottom: 0, borderRadius: 0, background: '#eef4fb', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: -1 },
  tabActive: { minHeight: 32, padding: '6px 8px 6px 12px', border: `1px solid ${COLORS.ACCENT}`, borderTop: 0, borderBottom: 0, borderRadius: 0, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: -1, position: 'relative', zIndex: 1 },
  tabFloatingBadge: { minHeight: 32, padding: '6px 8px 6px 12px', border: '1px dashed #8aa4c2', borderTop: 0, borderBottom: 0, borderRadius: 0, background: '#f8fbff', color: COLORS.TEXT, cursor: 'grab', fontFamily: UI_FONT, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: -1 },
  tabChar: { fontSize: 16, lineHeight: 1 },
  tabCode: { fontSize: 11, color: COLORS.TEXT_LIGHT },
  tabCodeActive: { fontSize: 11, color: 'rgba(255,255,255,.82)' },
  tabDirty: { fontSize: 10, color: COLORS.ACCENT },
  tabClose: { marginLeft: 4, padding: '1px 5px', borderRadius: 3, fontSize: 14, lineHeight: 1, cursor: 'pointer', color: COLORS.TEXT_LIGHT },
  // Editor area
  editorArea: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', backgroundColor: COLORS.CARD, borderRadius: 0, overflow: 'hidden', position: 'relative', isolation: 'isolate' },
  floatingEditor: { position: 'fixed', zIndex: 2600, minWidth: 720, minHeight: 500, background: '#fff', border: `1px solid ${COLORS.ACCENT}`, boxShadow: '0 18px 54px rgba(20,36,60,.32)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  floatingEditorBody: { position: 'relative', flex: 1, minHeight: 0, width: '100%', overflow: 'hidden', background: '#fff' },
  floatingTitle: { height: 34, flexShrink: 0, padding: '0 10px', background: '#eef4fb', color: COLORS.TEXT, cursor: 'grab', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8, fontFamily: UI_FONT, fontSize: 13, fontWeight: 600, userSelect: 'none', borderBottom: `1px solid ${COLORS.BORDER}` },
  floatingTitleActive: { height: 34, flexShrink: 0, padding: '0 10px', background: COLORS.ACCENT, color: '#fff', cursor: 'grab', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8, fontFamily: UI_FONT, fontSize: 13, fontWeight: 600, userSelect: 'none', borderBottom: `1px solid ${COLORS.ACCENT}` },
  floatingTitleText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  floatingActions: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 2 },
  floatingActionButton: { width: 28, height: 28, padding: 0, border: 0, borderRadius: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 },
  floatResizeHandle: { position: 'absolute', zIndex: 4, background: 'transparent' },
  // Glyph panel
  glyphPanel: { minHeight: 180, flex: 1, backgroundColor: COLORS.CARD, borderRadius: 0, padding: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' },
  recentPanel: { height: 150, minHeight: 110, backgroundColor: COLORS.CARD, borderRadius: 6, padding: '10px 14px', boxShadow: `0 1px 5px ${COLORS.BORDER}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0, position: 'relative' },
  recentPanelCollapsed: { height: 48, minHeight: 48, backgroundColor: COLORS.CARD, borderRadius: 6, padding: '10px 14px', boxShadow: `0 1px 5px ${COLORS.BORDER}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0, position: 'relative' },
  glyphPanelFull: { position: 'fixed', left: 12, right: 12, top: 124, bottom: 12, zIndex: 900, backgroundColor: COLORS.CARD, borderRadius: 8, padding: 20, boxShadow: '0 16px 48px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column' },
  panelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  subTitle: { fontSize: 16, color: COLORS.TEXT, margin: 0, minHeight: 26, paddingRight:0 },
  collapseButtonInTitle: { position: 'absolute', right: 14, top: 9, width: 26, height: 24, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 },
  glyphToolbar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  titleLine: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' },
  glyphSummary: { color: COLORS.TEXT_LIGHT, fontSize: 13, },
  statSelect: { padding: '0px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, fontFamily: UI_FONT, fontSize: 13 },
  controls: { display: 'flex', gap: 12, alignItems: 'center' },
  controlsCompact: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  inlineLabel: { fontSize: 13, color: COLORS.TEXT_LIGHT },
  input: { padding: '8px 12px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT, fontSize: 14 },
  findGroup: { display: 'inline-flex', alignItems: 'stretch', width: 100, height: 28, border: '1px solid #aeb6c1', borderRadius: 999, overflow: 'hidden', background: '#fff', flexShrink: 0 },
  findInput: { width: 50, minWidth: 0, padding: '7px 10px', border: 0, outline: 'none', fontFamily: UI_FONT, fontSize: 13 },
  findInputTip: { color: '#8c96a3', background: '#f7f8fa' },
  findButton: { width: 50, border: 0, borderLeft: '1px solid #aeb6c1', background: '#eef1f4', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  actionButton: { padding: '9px 18px', backgroundColor: COLORS.GREEN, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  primaryButton: { padding: '9px 18px', backgroundColor: COLORS.ACCENT, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  secondaryButton: { padding: '4px 4px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  iconButton: { width: 30, height: 30, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  activeIconButton: { width: 30, height: 30, border: `1px solid ${COLORS.ACCENT}`, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  iconButtonDisabled: { width: 30, height: 30, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#f3f5f7', color: '#aeb6c1', cursor: 'not-allowed', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  glyphColorStrip: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 6px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#f7fbff' },
  colorSwatchSmall: { width: 22, height: 22, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, cursor: 'pointer' },
  colorInputSmall: { width: 28, height: 24, padding: 0, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', cursor: 'pointer' },
  fullScreenButton: { width: 30, height: 30, padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, flexShrink: 0, position: 'relative', zIndex: 2 },
  dangerButton: { padding: '8px 14px', border: '1px solid #e2b9b9', borderRadius: 4, background: '#fff5f5', color: '#b42318', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  projectInfo: { marginTop: 5, color: COLORS.TEXT_LIGHT, fontSize: 12, lineHeight: 1.4 },
  grid: { flex: 1, minHeight: 0, display: 'grid', gap: 8, overflow: 'auto', alignItems: 'start', alignContent: 'start', position: 'relative' },
  gridFull: { flex: 1, minHeight: 0, display: 'grid', gap: 8, overflow: 'auto', paddingRight: 4, alignContent: 'start', alignItems: 'start', position: 'relative' },
  countText: { marginLeft: 'auto', color: COLORS.TEXT_LIGHT, fontSize: 13, whiteSpace: 'nowrap' },
  pageText: { color: COLORS.TEXT_LIGHT, fontSize: 13, minWidth:12, textAlign: 'center' },
  glyphCell: { height: 86, border: `1px solid ${COLORS.BORDER}`, background: '#fff', borderRadius: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
  glyphCellDone: { height: 86, border: `2px solid ${COLORS.ACCENT}`, background: COLORS.SELECT, borderRadius: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
  glyphCellSelected: { outline: `3px solid ${COLORS.ACCENT}`, outlineOffset: -2, background: '#cfe4ff' },
  glyphCellOpen: { boxShadow: '0 0 0 2px #ffa940' },
  glyphCellPaintMode: { cursor: 'crosshair' },
  glyphDesignedDot: { position: 'absolute', left: 7, top: 7, zIndex: 3, width: 8, height: 8, borderRadius: 999, background: '#e53935', boxShadow: '0 0 0 1px rgba(255,255,255,.92), 0 1px 3px rgba(0,0,0,.22)', pointerEvents: 'none' },
  char: { lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  refChar: { lineHeight: 1, position: 'absolute', inset: 0, margin: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', color: 'rgba(0,0,0,0.10)', pointerEvents: 'none' },
  code: { fontSize: 11, color: COLORS.TEXT_LIGHT },
  records: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'auto' },
  recordRow: { display: 'grid', gridTemplateColumns: '1fr 92px', gap: 8, alignItems: 'center' },
  recordOpen: { display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr)', gap: 8, padding: 6, border: 0, borderRadius: 4, background: COLORS.SELECT, color: COLORS.TEXT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT, minWidth: 0 },
  recordTime: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  recordPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  locateButton: { padding: '6px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT },
  selectionBox: { position: 'fixed', zIndex: 1800, pointerEvents: 'none', background: 'rgba(43,135,240,.16)', border: `1px solid ${COLORS.ACCENT}` },
  contextMenu: { position: 'fixed', zIndex: 1900, minWidth: 140, padding: 5, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 5, boxShadow: '0 8px 24px rgba(0,0,0,.2)', display: 'flex', flexDirection: 'column' },
  contextMenuItem: { padding: '8px 10px', border: 0, background: '#fff', color: COLORS.TEXT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT },
  glyphPropertyDock: { position: 'fixed', zIndex: 1950, width: 248, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, boxShadow: '0 12px 32px rgba(20,36,60,.22)', overflow: 'hidden' },
  glyphPropertyDockTitle: { height: 30, padding: '0 8px', background: '#D9EAFF', color: COLORS.TEXT, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, cursor: 'move', userSelect: 'none' },
  glyphPropertyClose: { width: 24, height: 24, border: 0, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 },
  glyphPropertyBody: { padding: 10, display: 'flex', flexDirection: 'column', gap: 10, background: '#fff' },
  glyphPropertyPreview: { height: 62, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLORS.TEXT, fontSize: 38, background: '#f7f9fc' },
  glyphPropertyStack: { display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: 0, border: '1px solid #aeb6c1', borderRadius: 4, overflow: 'hidden', background: '#eef1f4' },
  glyphPropertyLabel: { minHeight: 32, padding: '0 8px', borderRight: '1px solid #aeb6c1', borderBottom: '1px solid #cfd6df', background: '#eef1f4', color: COLORS.TEXT_LIGHT, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', boxSizing: 'border-box' },
  glyphPropertyInput: { width: '100%', minWidth: 0, height: 32, boxSizing: 'border-box', padding: '0 8px', border: 0, borderBottom: '1px solid #cfd6df', outline: 'none', background: '#f7f8fa', color: COLORS.TEXT, fontFamily: UI_FONT, fontSize: 13 },
  glyphPropertyTip: { gridColumn: '1 / -1', padding: '5px 8px', borderBottom: '1px solid #cfd6df', background: '#fff7f6', color: '#b42318', fontSize: 12, lineHeight: 1.3 },
  glyphPropertyLast: { borderBottom: 0 },
  modalBackdrop: { position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  addDialog: { width: 480, padding: 20, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, boxShadow: '0 18px 50px rgba(0,0,0,.28)', display: 'flex', flexDirection: 'column', gap: 9 },
  publishDialog: { width: 540, padding: 20, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 8, boxShadow: '0 18px 50px rgba(0,0,0,.28)', display: 'flex', flexDirection: 'column', gap: 10 },
  publishTitleRow: { display: 'flex', alignItems: 'center', gap: 8 },
  publishSettingsButton: { width: 30, height: 30, padding: 0, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT_LIGHT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 },
  publishCheckLabel: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: COLORS.TEXT, fontFamily: UI_FONT, cursor: 'pointer', userSelect: 'none', padding: '4px 0' },
  publishProgressPanel: { padding: '10px 0 2px', display: 'flex', flexDirection: 'column', gap: 7 },
  publishProgressText: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: COLORS.TEXT, fontSize: 13 },
  publishProgressTrack: { width: '100%', height: 8, overflow: 'hidden', borderRadius: 4, background: '#e2e9f2', border: `1px solid ${COLORS.BORDER}` },
  publishProgressBar: { height: '100%', borderRadius: 4, background: COLORS.ACCENT, transition: 'width 180ms ease' },
  batchBackdrop: { position: 'fixed', inset: 0, zIndex: 2050, background: 'rgba(17,31,48,.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  batchPanel: { width: 980, maxWidth: 'calc(100vw - 48px)', height: '82vh', maxHeight: 760, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 8, boxShadow: '0 24px 70px rgba(20,36,60,.34)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  batchHeader: { height: 58, padding: '0 16px', borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f4f8fd', flexShrink: 0 },
  batchTitle: { margin: 0, fontSize: 20, color: COLORS.TEXT },
  batchSubtitle: { margin: '3px 0 0', color: COLORS.TEXT_LIGHT, fontSize: 12 },
  batchBody: { flex: 1, minHeight: 0, overflow: 'auto', padding: 16, background: '#eaf1f8', display: 'flex', flexDirection: 'column', gap: 12 },
  batchCard: { minHeight: 112, padding: 14, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 12 },
  batchCardHead: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start', gap: 14 },
  batchCardIntro: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 },
  batchCardTitle: { margin: 0, color: COLORS.TEXT, fontSize: 16 },
  batchHint: { margin: 0, color: COLORS.TEXT_LIGHT, fontSize: 13, lineHeight: 1.6 },
  batchField: { display: 'inline-flex', alignItems: 'center', gap: 8, color: COLORS.TEXT, fontSize: 13 },
  batchInput: { width: 82, height: 30, padding: '0 8px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, color: COLORS.TEXT, background: '#fff', fontFamily: UI_FONT },
  batchUnit: { color: COLORS.TEXT_LIGHT, fontSize: 13 },
  batchSelect: { height: 30, padding: '0 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, color: COLORS.TEXT, background: '#fff', fontFamily: UI_FONT },
  batchInline: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  batchControls: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  batchCheckLabel: { display: 'inline-flex', alignItems: 'center', gap: 7, color: COLORS.TEXT, fontSize: 13, userSelect: 'none' },
  batchActionButton: { height: 32, padding: '0 16px', border: '1px solid #9fc5ee', borderRadius: 4, background: '#e7f2ff', color: COLORS.ACCENT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' },
  batchFooter: { minHeight: 58, padding: '10px 16px', borderTop: `1px solid ${COLORS.BORDER}`, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16, flexShrink: 0 },
  batchProgressPanel: { flex: 1, minWidth: 0, marginRight: 'auto', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '5px 10px', color: COLORS.TEXT_LIGHT, fontSize: 13 },
  batchProgressTrack: { gridColumn: '1 / -1', height: 8, borderRadius: 4, overflow: 'hidden', background: '#e2e9f2', border: `1px solid ${COLORS.BORDER}` },
  batchProgressBar: { height: '100%', borderRadius: 4, background: COLORS.ACCENT, transition: 'width 160ms ease' },
  batchConfirmBackdrop: { position: 'fixed', inset: 0, zIndex: 2600, background: 'rgba(17,31,48,.32)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  batchConfirmDialog: { width: 460, background: '#fff', borderRadius: 8, padding: 22, boxShadow: '0 20px 64px rgba(20,36,60,.34)', border: `1px solid ${COLORS.BORDER}`, display: 'grid', gridTemplateColumns: '42px 1fr', gap: 14 },
  batchDangerButton: { padding: '8px 16px', border: '1px solid #e2b9b9', borderRadius: 4, background: '#fff5f5', color: '#b42318', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  metadataDialog: { width: 920, maxWidth: '94vw', height: '86vh', background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 8, boxShadow: '0 18px 54px rgba(20,36,60,.30)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  metadataDialogMax: { position: 'fixed', left: 12, right: 12, top: 124, bottom: 12, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 0, boxShadow: '0 18px 54px rgba(20,36,60,.30)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  metadataHeader: { height: 48, padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${COLORS.BORDER}` },
  metadataHeaderActions: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  iconClose: { width: 30, height: 30, border: 0, borderRadius: 4, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  metadataTabs: { display: 'flex', gap: 0, background: '#f5f8fc', borderBottom: `1px solid ${COLORS.BORDER}`, flexShrink: 0 },
  metadataTab: { padding: '10px 16px', border: 0, borderRight: `1px solid ${COLORS.BORDER}`, background: '#f5f8fc', color: COLORS.TEXT_LIGHT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  metadataTabActive: { padding: '10px 16px', border: 0, borderRight: `1px solid ${COLORS.BORDER}`, background: '#fff', color: COLORS.ACCENT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, fontWeight: 600 },
  metadataBody: { flex: 1, minHeight: 0, overflow: 'auto', padding: 16, background: '#eaf1f8', display: 'flex', flexDirection: 'column', gap: 14 },
  metadataGroup: { background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  groupTitle: { margin: 0, fontSize: 15, color: COLORS.TEXT },
  metadataGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 },
  metricGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 },
  metaField: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
  metaFieldWide: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
  metaLabel: { fontSize: 12, color: COLORS.TEXT_LIGHT },
  metaInput: { height: 34, padding: '7px 9px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, color: COLORS.TEXT, background: '#fff', fontFamily: UI_FONT, fontSize: 13, minWidth: 0 },
  metaTextarea: { minHeight: 78, padding: 9, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, color: COLORS.TEXT, background: '#fff', fontFamily: UI_FONT, fontSize: 13, resize: 'vertical' },
  jsonTextarea: { minHeight: 110, padding: 9, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, color: COLORS.TEXT, background: '#fff', fontFamily: 'Consolas, monospace', fontSize: 12, resize: 'vertical' },
  metadataHint: { padding: 10, background: '#f7fbff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 5, color: COLORS.TEXT_LIGHT, fontSize: 13, lineHeight: 1.6 },
  metadataFooter: { padding: 12, borderTop: `1px solid ${COLORS.BORDER}`, background: '#fff', display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0 },
  publishSummary: { display: 'flex', flexDirection: 'column', gap: 7, padding: 12, background: '#f0f6ff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 5, color: COLORS.TEXT, fontSize: 13 },
  publishTextButton: { padding: 0, border: 0, background: 'transparent', color: COLORS.ACCENT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  linkButton: { padding: 0, border: 0, background: 'transparent', color: COLORS.ACCENT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  confirmDialog: { width: 430, background: '#fff', borderRadius: 8, padding: 22, boxShadow: '0 18px 54px rgba(20,36,60,.28)', border: `1px solid ${COLORS.BORDER}`, display: 'grid', gridTemplateColumns: '42px 1fr', gap: 14 },
  confirmIcon: { width: 42, height: 42, borderRadius: 8, background: '#eaf4ff', color: COLORS.ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 },
  confirmContent: { minWidth: 0 },
  confirmTitle: { color: COLORS.TEXT, fontSize: 18, fontWeight: 600, marginBottom: 8 },
  confirmText: { color: COLORS.TEXT_LIGHT, fontSize: 13, lineHeight: 1.7 },
  confirmActions: { gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 8 },
  dialogTitle: { margin: 0, color: COLORS.TEXT, fontSize: 18 },
  anchorInfo: { color: COLORS.TEXT_LIGHT, fontSize: 13, marginBottom: 4 },
  dialogLabel: { color: COLORS.TEXT, fontSize: 13 },
  dialogInput: { padding: '9px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT },
  dialogTextarea: { minHeight: 100, padding: 10, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, resize: 'vertical', fontFamily: UI_FONT },
  dialogHint: { color: COLORS.TEXT_LIGHT, fontSize: 12 },
  dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
};

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import zlib from 'zlib';
import fontkit from 'fontkit';
import iconv from 'iconv-lite';
import { FONT_METRICS } from '../../shared/constants';
import { FontMetrics } from '../../shared/types';
import { runLegacy } from './legacyBridge';

export type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'EPS';

const APP_NAME = 'ZoomlaXizhi';

function getFont(font: fontkit.Font | fontkit.FontCollection): fontkit.Font {
  return 'fonts' in font ? (font as fontkit.FontCollection).fonts[0]! : font as fontkit.Font;
}

function defaultMetrics(): FontMetrics {
  return {
    upm: FONT_METRICS.UPM,
    ascent: FONT_METRICS.ASCENT,
    descent: FONT_METRICS.DESCENT,
    family: 'Unknown',
  };
}

function readFont(fontPath: string): fontkit.Font {
  return getFont(fontkit.create(fs.readFileSync(fontPath)));
}

function readUInt16BE(buffer: Buffer, offset: number): number {
  return offset >= 0 && offset + 2 <= buffer.length ? buffer.readUInt16BE(offset) : 0;
}

function readUInt32BE(buffer: Buffer, offset: number): number {
  return offset >= 0 && offset + 4 <= buffer.length ? buffer.readUInt32BE(offset) : 0;
}

function cleanNameValue(value: string): string {
  return value
    .replace(/\0/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function looksBrokenName(value: string): boolean {
  if (!value) return true;
  const replacementCount = (value.match(/\uFFFD/g) || []).length;
  if (replacementCount) return true;
  const visible = value.replace(/\s/g, '');
  if (!visible) return true;
  const mojibakeCount = (value.match(/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß]/g) || []).length;
  return mojibakeCount >= Math.max(2, Math.ceil(visible.length * 0.25));
}

function hasCjk(value: string): boolean {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(value);
}

function decodeNameValues(buffer: Buffer, platformId: number, encodingId: number, languageId: number): string[] {
  if (platformId === 0 || platformId === 3) {
    const chars: number[] = [];
    for (let index = 0; index + 1 < buffer.length; index += 2) {
      chars.push(buffer.readUInt16BE(index));
    }
    return [cleanNameValue(String.fromCharCode(...chars))];
  }
  if (platformId === 1) {
    const values = [cleanNameValue(buffer.toString('latin1'))];
    if (languageId === 19 || languageId === 33 || encodingId === 25) values.unshift(cleanNameValue(iconv.decode(buffer, 'gbk')));
    if (languageId === 19 || languageId === 34 || encodingId === 2) values.unshift(cleanNameValue(iconv.decode(buffer, 'big5')));
    return Array.from(new Set(values.filter(Boolean)));
  }
  return [cleanNameValue(buffer.toString('utf8'))];
}

function firstSfntOffset(buffer: Buffer): number {
  if (buffer.subarray(0, 4).toString('ascii') !== 'ttcf') return 0;
  return readUInt32BE(buffer, 12);
}

function readWoffNameTable(buffer: Buffer): Buffer | null {
  if (buffer.subarray(0, 4).toString('ascii') !== 'wOFF') return null;
  const numTables = readUInt16BE(buffer, 12);
  for (let index = 0; index < numTables; index += 1) {
    const record = 44 + index * 20;
    const tag = buffer.subarray(record, record + 4).toString('ascii');
    if (tag !== 'name') continue;
    const offset = readUInt32BE(buffer, record + 4);
    const compLength = readUInt32BE(buffer, record + 8);
    const origLength = readUInt32BE(buffer, record + 12);
    if (!offset || !compLength || offset + compLength > buffer.length) return null;
    const data = buffer.subarray(offset, offset + compLength);
    if (compLength === origLength) return Buffer.from(data);
    try {
      return zlib.inflateSync(data);
    } catch {
      return null;
    }
  }
  return null;
}

function readSfntNameTableData(buffer: Buffer): Buffer | null {
  const woffName = readWoffNameTable(buffer);
  if (woffName) return woffName;
  if (buffer.subarray(0, 4).toString('ascii') === 'wOF2') return null;

  const base = firstSfntOffset(buffer);
  const numTables = readUInt16BE(buffer, base + 4);
  for (let index = 0; index < numTables; index += 1) {
    const record = base + 12 + index * 16;
    const tag = buffer.subarray(record, record + 4).toString('ascii');
    if (tag !== 'name') continue;
    const nameOffset = readUInt32BE(buffer, record + 8);
    const nameLength = readUInt32BE(buffer, record + 12);
    if (!nameOffset || !nameLength || nameOffset + nameLength > buffer.length) return null;
    return Buffer.from(buffer.subarray(nameOffset, nameOffset + nameLength));
  }
  return null;
}

function readSfntNameTable(buffer: Buffer): { chineseName: string; englishName: string; version: string } {
  const nameTable = readSfntNameTableData(buffer);
  if (!nameTable) {
    return { chineseName: '', englishName: '', version: '' };
  }

  const count = readUInt16BE(nameTable, 2);
  const stringBase = readUInt16BE(nameTable, 4);
  const values: Array<{ nameId: number; languageId: number; platformId: number; encodingId: number; value: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12;
    const platformId = readUInt16BE(nameTable, record);
    const encodingId = readUInt16BE(nameTable, record + 2);
    const languageId = readUInt16BE(nameTable, record + 4);
    const nameId = readUInt16BE(nameTable, record + 6);
    const length = readUInt16BE(nameTable, record + 8);
    const offset = readUInt16BE(nameTable, record + 10);
    const start = stringBase + offset;
    if (!length || start < 0 || start + length > nameTable.length) continue;
    for (const value of decodeNameValues(nameTable.subarray(start, start + length), platformId, encodingId, languageId)) {
      if (value && !looksBrokenName(value)) values.push({ nameId, languageId, platformId, encodingId, value });
    }
  }

  const byName = (nameIds: number[], languageIds: number[], predicate?: (value: string) => boolean, allowMac = false) => {
    const candidates = values.filter(item => nameIds.includes(item.nameId) && (allowMac || item.platformId === 0 || item.platformId === 3));
    for (const languageId of languageIds) {
      const found = candidates.find(item => item.languageId === languageId && (!predicate || predicate(item.value)));
      if (found) return found.value;
    }
    const found = candidates.find(item => !predicate || predicate(item.value));
    return found?.value || '';
  };

  return {
    chineseName: byName([4, 1], [0x0804, 0x0004, 0x0c04, 0x0404, 0x1004], hasCjk)
      || byName([4, 1], [19, 33, 34], hasCjk, true)
      || byName([4, 1], [0x0804, 0x0004, 0x0c04, 0x0404, 0x1004], undefined, true),
    englishName: byName([4, 1, 6], [0x0409, 0x0000], value => !hasCjk(value)),
    version: byName([5], [0x0409, 0x0000, 0x0804]),
  };
}

function readMetrics(font: fontkit.Font): FontMetrics {
  const anyFont = font as any;
  return {
    upm: anyFont.unitsPerEm || FONT_METRICS.UPM,
    ascent: anyFont.ascent || FONT_METRICS.ASCENT,
    descent: anyFont.descent || FONT_METRICS.DESCENT,
    family: anyFont.familyName || anyFont.fullName || 'Unknown',
  };
}

export function charFilename(code: number): string {
  const illegal = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const ch = String.fromCodePoint(code);
  if (illegal.has(ch) || code < 0x20 || ch.trim() === '') {
    return `uni${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return ch;
}

export function parseStemToCode(stem: string): number | null {
  if ([...stem].length === 1) {
    return stem.codePointAt(0) ?? null;
  }
  const match = /^(?:uni|u)([0-9A-Fa-f]{4,6})$/.exec(stem);
  return match ? parseInt(match[1], 16) : null;
}

export function analyzeFont(fontPath: string): {
  success: boolean;
  metrics: FontMetrics;
  codes: number[];
  cmap: Map<number, string>;
  glyphCount: number;
  error?: string;
} {
  try {
    if (!fs.existsSync(fontPath)) {
      return { success: false, metrics: defaultMetrics(), codes: [], cmap: new Map(), glyphCount: 0, error: 'Font file does not exist' };
    }
    const font = readFont(fontPath);
    const characterSet = ((font as any).characterSet || []) as number[];
    const cmap = characterSet.reduce((map: Map<number, string>, code: number) => {
      if (code >= 0x20) {
        map.set(code, `U+${code.toString(16).toUpperCase()}`);
      }
      return map;
    }, new Map<number, string>());
    const codes = [...cmap.keys()].sort((a, b) => a - b);
    const fontDataUrl = `data:font/${path.extname(fontPath).toLowerCase().includes('otf') ? 'otf' : 'ttf'};base64,${fs.readFileSync(fontPath).toString('base64')}`;
    return { success: true, metrics: { ...readMetrics(font), fontDataUrl } as any, codes, cmap, glyphCount: (font as any).numGlyphs || codes.length };
  } catch (error: any) {
    return { success: false, metrics: defaultMetrics(), codes: [], cmap: new Map(), glyphCount: 0, error: error.message };
  }
}

export function readFontInfo(fontPath: string): {
  success: boolean;
  chineseName: string;
  englishName: string;
  family: string;
  version: string;
  characterCount: number;
  glyphCount: number;
  unitsPerEm: number;
  colorFont: boolean;
  error?: string;
} {
  try {
    if (!fs.existsSync(fontPath)) {
      return { success: false, chineseName: '', englishName: '', family: '', version: '', characterCount: 0, glyphCount: 0, unitsPerEm: 0, colorFont: false, error: 'Font file does not exist' };
    }
    const buffer = fs.readFileSync(fontPath);
    const nameInfo = readSfntNameTable(buffer);
    const font = getFont(fontkit.create(buffer));
    const anyFont = font as any;
    const characterSet = (anyFont.characterSet || []) as number[];
    const unitsPerEm = Number(anyFont.unitsPerEm || FONT_METRICS.UPM);
    const fontkitFamily = cleanNameValue(String(anyFont.familyName || ''));
    const fontkitFullName = cleanNameValue(String(anyFont.fullName || ''));
    const fontkitPostscriptName = cleanNameValue(String(anyFont.postscriptName || ''));
    const safeFontkitFamily = looksBrokenName(fontkitFamily) ? '' : fontkitFamily;
    const safeFontkitFullName = looksBrokenName(fontkitFullName) ? '' : fontkitFullName;
    const safeFontkitPostscriptName = looksBrokenName(fontkitPostscriptName) ? '' : fontkitPostscriptName;
    const family = nameInfo.chineseName || safeFontkitFamily || safeFontkitFullName || nameInfo.englishName || '';
    // 检测彩色字体（复用已读取的 buffer）
    let colorFont = false;
    const sfTag = buffer.subarray(0, 4).toString('ascii');
    const base = sfTag === 'ttcf' ? buffer.readUInt32BE(12) : 0;
    colorFont = scanSfntTables(buffer, base);
    return {
      success: true,
      chineseName: nameInfo.chineseName || family,
      englishName: nameInfo.englishName || safeFontkitFullName || safeFontkitPostscriptName || safeFontkitFamily || family || '',
      family,
      version: nameInfo.version || cleanNameValue(String(anyFont.version || anyFont.versionString || '')),
      characterCount: characterSet.length,
      glyphCount: Number(anyFont.numGlyphs || anyFont.glyphCount || characterSet.length || 0),
      unitsPerEm,
      colorFont,
    };
  } catch (error: any) {
    return { success: false, chineseName: '', englishName: '', family: '', version: '', characterCount: 0, glyphCount: 0, unitsPerEm: 0, colorFont: false, error: error.message };
  }
}

export function exportGlyphBitmap(
  fontPath: string,
  code: number,
  size: number,
  fmt: 'PNG' | 'JPG',
  outPath: string,
): boolean {
  try {
    runLegacy([
      'export-bitmap',
      '--font', fontPath,
      '--code', String(code),
      '--size', String(size),
      '--format', fmt,
      '--output', outPath,
    ]);
    return true;
  } catch (error) {
    console.error('Glyph bitmap export failed:', error);
    return false;
  }
}

function glyphSvgPath(font: fontkit.Font, code: number): { d: string; advance: number; metrics: FontMetrics; commands: Array<{ command: string; args: number[] }> } | null {
  const glyph = (font as any).glyphForCodePoint(code);
  if (!glyph) {
    return null;
  }
  return {
    d: glyph.path.toSVG(),
    advance: glyph.advanceWidth || (font as any).unitsPerEm,
    metrics: readMetrics(font),
    commands: glyph.path.commands || [],
  };
}

export function exportGlyphSvg(fontPath: string, code: number, size: number, outPath: string): boolean {
  try {
    const font = readFont(fontPath);
    const glyph = glyphSvgPath(font, code);
    if (!glyph) {
      return false;
    }
    const scale = 0.8 * size / glyph.metrics.upm;
    const tx = size / 2 - scale * glyph.advance / 2;
    const ty = size / 2 + scale * (glyph.metrics.ascent + glyph.metrics.descent) / 2;
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})" d="${glyph.d}" fill="black"/>
</svg>
`;
    fs.writeFileSync(outPath, svg, 'utf8');
    return true;
  } catch (error) {
    console.error('Glyph SVG export failed:', error);
    return false;
  }
}

export function exportGlyphEps(fontPath: string, code: number, size: number, outPath: string): boolean {
  try {
    const font = readFont(fontPath);
    const glyph = glyphSvgPath(font, code);
    if (!glyph) {
      return false;
    }
    const scale = 0.8 * size / glyph.metrics.upm;
    const tx = size / 2 - scale * glyph.advance / 2;
    const bottom = (size - (glyph.metrics.ascent - glyph.metrics.descent) * scale) / 2;
    const fmt = (value: number) => Number(value.toFixed(3)).toString();
    const xy = (x: number, y: number) => `${fmt(tx + x * scale)} ${fmt(bottom + (y - glyph.metrics.descent) * scale)}`;
    type EpsContour = { path: string[]; points: Array<{ x: number; y: number }>; area: number; parent: number };
    const contourArea = (points: Array<{ x: number; y: number }>) => {
      let area = 0;
      for (let index = 0; index < points.length; index += 1) {
        const a = points[index]!;
        const b = points[(index + 1) % points.length]!;
        area += a.x * b.y - b.x * a.y;
      }
      return area / 2;
    };
    const pointInContour = (point: { x: number; y: number }, points: Array<{ x: number; y: number }>) => {
      let inside = false;
      for (let index = 0; index < points.length; index += 1) {
        const a = points[index]!;
        const b = points[(index + 1) % points.length]!;
        if ((a.y > point.y) !== (b.y > point.y)) {
          const crossX = (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-9) + a.x;
          if (point.x < crossX) inside = !inside;
        }
      }
      return inside;
    };
    const contourInsideContour = (inner: Array<{ x: number; y: number }>, outer: Array<{ x: number; y: number }>) => {
      if (inner.length < 3 || outer.length < 3) return false;
      const step = Math.max(1, Math.floor(inner.length / 24));
      for (let index = 0; index < inner.length; index += step) {
        if (!pointInContour(inner[index]!, outer)) return false;
      }
      const center = inner.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
      return pointInContour({ x: center.x / inner.length, y: center.y / inner.length }, outer);
    };
    const contours: EpsContour[] = [];
    let currentPath: string[] = [];
    let currentPoints: Array<{ x: number; y: number }> = [];
    let cx = 0;
    let cy = 0;
    const finishContour = () => {
      if (currentPath.length && currentPoints.length >= 3) {
        contours.push({ path: [...currentPath], points: [...currentPoints], area: contourArea(currentPoints), parent: -1 });
      }
      currentPath = [];
      currentPoints = [];
    };
    glyph.commands.forEach(command => {
      const a = command.args || [];
      switch (command.command) {
        case 'moveTo':
          finishContour();
          cx = a[0]; cy = a[1];
          currentPath.push(`${xy(a[0], a[1])} moveto`);
          currentPoints.push({ x: a[0], y: a[1] });
          return;
        case 'lineTo':
          cx = a[0]; cy = a[1];
          currentPath.push(`${xy(a[0], a[1])} lineto`);
          currentPoints.push({ x: a[0], y: a[1] });
          return;
        case 'quadraticCurveTo': {
          const c1x = cx + (2 / 3) * (a[0] - cx);
          const c1y = cy + (2 / 3) * (a[1] - cy);
          const c2x = a[2] + (2 / 3) * (a[0] - a[2]);
          const c2y = a[3] + (2 / 3) * (a[1] - a[3]);
          cx = a[2]; cy = a[3];
          currentPath.push(`${xy(c1x, c1y)} ${xy(c2x, c2y)} ${xy(a[2], a[3])} curveto`);
          currentPoints.push({ x: a[2], y: a[3] });
          return;
        }
        case 'bezierCurveTo':
          cx = a[4]; cy = a[5];
          currentPath.push(`${xy(a[0], a[1])} ${xy(a[2], a[3])} ${xy(a[4], a[5])} curveto`);
          currentPoints.push({ x: a[4], y: a[5] });
          return;
        case 'closePath':
          currentPath.push('closepath');
          finishContour();
          return;
        default:
          return;
      }
    });
    finishContour();
    contours.forEach((contour, index) => {
      let parent = -1;
      let parentArea: number | null = null;
      contours.forEach((candidate, candidateIndex) => {
        const areaAbs = Math.abs(candidate.area);
        if (candidateIndex === index || areaAbs <= Math.abs(contour.area)) return;
        if (contourInsideContour(contour.points, candidate.points) && (parentArea === null || areaAbs < parentArea)) {
          parent = candidateIndex;
          parentArea = areaAbs;
        }
      });
      contour.parent = parent;
    });
    const body = contours.map((contour, index) => {
      const parent = contour.parent;
      if (parent >= 0 && contour.area * contours[parent]!.area < 0) return '';
      const pathParts = [...contour.path];
      contours.forEach((child, childIndex) => {
        if (child.parent === index && child.area * contour.area < 0) {
          pathParts.push(...child.path);
        }
      });
      return `newpath\n${pathParts.join('\n')}\nfill`;
    }).filter(Boolean).join('\n');
    const eps = `%!PS-Adobe-3.0 EPSF-3.0
%%Creator: ${APP_NAME}
%%For: (${APP_NAME}) (Zoomla)
%%Title: (${path.basename(outPath).replace(/[^\x20-\x7E]/g, '') || 'glyph.eps'})
%%BoundingBox: 0 0 ${size} ${size}
%%HiResBoundingBox: 0 0 ${size} ${size}
%%DocumentProcessColors: Black
%%EndComments
0 0 0 setrgbcolor
${body}
showpage
%%Trailer
%%EOF
`;
    fs.writeFileSync(outPath, eps, 'ascii');
    return true;
  } catch (error) {
    console.error('Glyph EPS export failed:', error);
    return false;
  }
}

export interface ExportOptions {
  fontPath: string;
  code: number;
  format: ExportFormat;
  size: number;
  outputDir: string;
}

export function exportGlyph(options: ExportOptions): { success: boolean; message: string; outputPath?: string } {
  const { fontPath, code, format, size, outputDir } = options;
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${charFilename(code)}.${format.toLowerCase()}`);
  const ok = format === 'PNG' || format === 'JPG'
    ? exportGlyphBitmap(fontPath, code, size, format, outputPath)
    : format === 'SVG'
      ? exportGlyphSvg(fontPath, code, size, outputPath)
      : exportGlyphEps(fontPath, code, size, outputPath);
  return ok
    ? { success: true, message: `Exported ${outputPath}`, outputPath }
    : { success: false, message: `Failed to export U+${code.toString(16).toUpperCase()}` };
}

export function batchExportGlyphs(
  fontPath: string,
  codes: number[],
  format: ExportFormat,
  size: number,
  outputDir: string,
): { success: number; failed: number; outputPath: string } {
  let success = 0;
  let failed = 0;
  for (const code of codes) {
    if (exportGlyph({ fontPath, code, format, size, outputDir }).success) {
      success += 1;
    } else {
      failed += 1;
    }
  }
  return { success, failed, outputPath: outputDir };
}

export function exportProjectGlyph(options: { projectPath: string; code: number; format: ExportFormat; size: number; outputPath: string }): { success: boolean; message: string; outputPath?: string } {
  const { projectPath, code, format, size, outputPath } = options;
  try {
    runLegacy([
      'project-export-glyph',
      '--project', projectPath,
      '--code', String(code),
      '--size', String(size || 1000),
      '--format', format,
      '--output', outputPath,
    ]);
    return { success: true, message: `Exported ${outputPath}`, outputPath };
  } catch (error: any) {
    return { success: false, message: error?.message || `Failed to export U+${code.toString(16).toUpperCase()}` };
  }
}

export function publishFont(projectPath: string, outputPath: string, options: { fontType?: string; colorMode?: string; colorOffsetX?: number; colorOffsetY?: number } = {}): { success: boolean; outputPath: string; glyphCount: number; error?: string } {
  try {
    if (!fs.existsSync(projectPath)) {
      return { success: false, outputPath: '', glyphCount: 0, error: 'Project file does not exist' };
    }
    const fontType = String(options.fontType || 'ttf').toLowerCase();
    const ext = ['ttf', 'otf', 'woff', 'woff2'].includes(fontType) ? fontType : 'ttf';
    // 如果用户没有指定扩展名，自动补上
    let output = outputPath;
    if (!output.toLowerCase().endsWith(`.${ext}`)) {
      output = `${output}.${ext}`;
    }
    const colorMode = normalizePublishColorMode(options.colorMode || 'compatible');
    const args = [
      'project-publish',
      '--project', projectPath,
      '--output', output,
      '--font-type', ext,
      '--color-mode', colorMode,
    ];
    if (Number.isFinite(Number(options.colorOffsetX))) args.push('--color-offset-x', String(Number(options.colorOffsetX)));
    if (Number.isFinite(Number(options.colorOffsetY))) args.push('--color-offset-y', String(Number(options.colorOffsetY)));
    const result: any = runLegacy(args);
    return { ...result, fontType: ext, colorMode };
  } catch (error: any) {
    return { success: false, outputPath: '', glyphCount: 0, error: error.message };
  }
}

function normalizePublishColorMode(value: unknown): string {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase().replace(/[\s_]+/g, '-');
  const aliases: Record<string, string> = {
    '': 'compatible',
    'no': 'mono',
    'none': 'mono',
    'black-white': 'mono',
    'black-and-white': 'mono',
    'mono': 'mono',
    'monochrome': 'mono',
    'one-color': 'mono',
    '1-color': 'mono',
    'colr': 'colr',
    'layered': 'colr',
    'layered-glyphs': 'colr',
    'colr-layered-glyphs': 'colr',
    'two-color': 'colr',
    '2-color': 'colr',
    'svg-fixed': 'svg-fixed',
    'svg-without-color-palettes': 'svg-fixed',
    'svg-no-palette': 'svg-fixed',
    'three-color': 'svg-fixed',
    '3-color': 'svg-fixed',
    'svg-palette': 'svg-palette',
    'svg-with-color-palettes': 'svg-palette',
    'svg-with-palettes': 'svg-palette',
    'four-color': 'svg-palette',
    '4-color': 'svg-palette',
    'compatible': 'compatible',
    'both': 'compatible',
    'both-colr-and-svg': 'compatible',
    'colr-and-svg': 'compatible',
    'full-compatible': 'compatible',
    'full-color': 'compatible',
    'five-color': 'compatible',
    '5-color': 'compatible',
  };
  if (aliases[key]) return aliases[key];
  if (key.includes('one-color') || key.includes('1-color')) return 'mono';
  if (key.includes('two-color') || key.includes('2-color')) return 'colr';
  if (key.includes('three-color') || key.includes('3-color')) return 'svg-fixed';
  if (key.includes('four-color') || key.includes('4-color')) return 'svg-palette';
  if (key.includes('five-color') || key.includes('5-color')) return 'compatible';
  if (key.includes('both') && key.includes('colr') && key.includes('svg')) return 'compatible';
  if (key.includes('colr') && key.includes('svg')) return 'compatible';
  if (key.includes('svg') && key.includes('palette')) return 'svg-palette';
  if (key.includes('svg')) return 'svg-fixed';
  if (key.includes('colr') || key.includes('layer')) return 'colr';
  return ['mono', 'colr', 'svg-fixed', 'svg-palette', 'compatible'].includes(raw) ? raw : 'mono';
}

export function scanMaterials(materialDir: string, pattern = '*'): {
  success: boolean;
  items: Array<{ path: string; name: string; char: string; code: number; size: string }>;
  skipped: number;
} {
  return runLegacy(['scan-materials', '--dir', materialDir, '--pattern', pattern]);
}

export function processMaterials(operation: string, options: Record<string, any>): {
  success: boolean;
  outputPath: string;
  count: number;
} {
  const args = [operation, '--dir', options.dir, '--pattern', options.pattern || '*'];
  if (operation === 'material-convert') {
    args.push('--format', options.format);
  } else if (operation === 'material-resize') {
    args.push('--width', String(options.width || ''), '--height', String(options.height || ''));
  } else if (operation === 'material-element') {
    args.push('--element', options.element, '--mode', options.mode || 'stamp');
  } else if (operation === 'material-noise') {
    args.push(
      '--shape', options.shape || 'circle',
      '--shapes', Array.isArray(options.shapes) ? options.shapes.join(',') : String(options.shapes || options.shape || 'circle'),
      '--direction', options.direction || 'random',
      '--custom', options.custom || '',
      '--size', String(options.size || 10),
      '--density', String(options.density || 8),
    );
  }
  return runLegacy(args);
}

export function composeFont(options: {
  baseFont: string;
  materialDir: string;
  materials?: Array<{ path: string; code: number; char?: string }>;
  englishName?: string;
  chineseName?: string;
  version?: string;
  copyright?: string;
}): { success: boolean; outputPath: string; glyphCount: number; missing: number; failed: number } {
  const args = [
    'compose',
    '--base-font', options.baseFont,
    '--material-dir', options.materialDir,
    '--english-name', options.englishName || '',
    '--chinese-name', options.chineseName || '',
    '--version', options.version || '',
    '--copyright', options.copyright || '',
  ];
  if (options.materials) {
    args.push('--materials', JSON.stringify(options.materials));
  }
  return runLegacy(args);
}

export function modifyFontMetadata(options: {
  inputPath: string;
  outputPath: string;
  nameMetadata: Record<string, Record<string, string>>;
  advancedMetadata?: Record<string, any>;
}): { success: boolean; outputPath: string; nameIds: number } {
  return runLegacy([
    'metadata',
    '--input', options.inputPath,
    '--output', options.outputPath,
    '--name-metadata', JSON.stringify(options.nameMetadata),
    '--advanced-metadata', JSON.stringify(options.advancedMetadata || {}),
  ]);
}

export function createDesignProject(sourceTtf: string, output?: string): any {
  const args = ['project-create', '--source-ttf', sourceTtf];
  if (output) {
    args.push('--output', output);
  }
  return attachProjectFontData(runLegacy(args));
}

export function openDesignProject(projectPath: string): any {
  return attachProjectFontData(runLegacy(['project-open', '--project', projectPath]));
}

export function saveDesignProjectAs(projectPath: string, outputPath: string): any {
  if (!fs.existsSync(projectPath)) {
    return { success: false, error: 'Project file does not exist' };
  }
  const target = outputPath.toLowerCase().endsWith('.z01') ? outputPath : `${outputPath}.z01`;
  if (path.resolve(projectPath) === path.resolve(target)) {
    return { success: false, error: 'Source and target project paths are the same' };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(projectPath, target);
  const result = openDesignProject(target);
  return { ...result, path: target };
}

function attachProjectFontData(result: any): any {
  try {
    const source = result?.project?.source_ttf || result?.project?.sourceTtf;
    if (result?.success && source && fs.existsSync(source)) {
      const ext = path.extname(source).toLowerCase().includes('otf') ? 'otf' : 'ttf';
      result.project.fontDataUrl = `data:font/${ext};base64,${fs.readFileSync(source).toString('base64')}`;
    }
  } catch {
    // Font preview data is optional; project loading should not fail because of it.
  }
  return result;
}

export function getProjectGlyph(projectPath: string, code: number): any {
  return runLegacy(['project-glyph', '--project', projectPath, '--code', String(code)]);
}

export function saveProjectGlyph(projectPath: string, code: number, glyph: any): any {
  const glyphFile = path.join(os.tmpdir(), `zoomlaxizhi-glyph-${randomUUID()}.json`);
  fs.writeFileSync(glyphFile, JSON.stringify(glyph), 'utf8');
  try {
    return runLegacy(['project-save-glyph', '--project', projectPath, '--code', String(code), '--glyph-file', glyphFile]);
  } finally {
    try {
      fs.unlinkSync(glyphFile);
    } catch {
      // The operating system can clean up an already removed temporary file.
    }
  }
}

export function updateProjectCodes(projectPath: string, codes: number[], removed: number[] = []): any {
  const codesFile = path.join(os.tmpdir(), `zoomlaxizhi-codes-${randomUUID()}.json`);
  fs.writeFileSync(codesFile, JSON.stringify({ codes, removed }), 'utf8');
  try {
    return runLegacy(['project-update-codes', '--project', projectPath, '--codes-file', codesFile]);
  } finally {
    try {
      fs.unlinkSync(codesFile);
    } catch {
      // The operating system can clean up an already removed temporary file.
    }
  }
}

export function updateProjectMetadata(projectPath: string, metadata: any): any {
  const metadataFile = path.join(os.tmpdir(), `zoomlaxizhi-metadata-${randomUUID()}.json`);
  fs.writeFileSync(metadataFile, JSON.stringify(metadata), 'utf8');
  try {
    return attachProjectFontData(runLegacy(['project-update-metadata', '--project', projectPath, '--metadata-file', metadataFile]));
  } finally {
    try {
      fs.unlinkSync(metadataFile);
    } catch {
      // The operating system can clean up an already removed temporary file.
    }
  }
}

export function importGlyphAsset(options: { input: string; upm: number; ascent: number; descent: number; advance: number }): any {
  return runLegacy([
    'import-glyph-asset',
    '--input', options.input,
    '--upm', String(options.upm),
    '--ascent', String(options.ascent),
    '--descent', String(options.descent),
    '--advance', String(options.advance),
  ]);
}

// 枚举 Windows 系统已安装的字体
export function listSystemFonts(): Array<{ family: string; path: string }> {
  const fontDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts');
  let files: string[] = [];
  try {
    files = fs.readdirSync(fontDir).filter(f => /\.(ttf|otf)$/i.test(f));
  } catch {
    return [];
  }
  const result: Array<{ family: string; path: string }> = [];
  for (const file of files) {
    try {
      const fontPath = path.join(fontDir, file);
      const font = readFont(fontPath);
      const family = font.family || path.basename(file, path.extname(file));
      // 去重：同一家族名只保留第一个
      if (!result.some(item => item.family === family)) {
        result.push({ family, path: fontPath });
      }
    } catch {
      // 跳过无法解析的字体
    }
  }
  // 按家族名排序，确保常用中文字体靠前
  result.sort((a, b) => a.family.localeCompare(b.family, 'zh-CN'));
  return result;
}

// 检测字体是否包含彩色表（COLR / SVG / CBDT / sbix）
const COLOR_TABLE_TAGS = new Set(['COLR', 'SVG ', 'CBDT', 'sbix']);

export function isColorFont(fontPath: string): boolean {
  try {
    if (!fs.existsSync(fontPath)) return false;
    const buffer = fs.readFileSync(fontPath);
    const tag = buffer.subarray(0, 4).toString('ascii');

    // TTC 合集：读取第一个字体的偏移
    if (tag === 'ttcf') {
      const offset = buffer.readUInt32BE(12);
      return scanSfntTables(buffer, offset);
    }
    // TTF / OTF
    if (tag === '\x00\x01\x00\x00' || tag === 'OTTO' || tag === 'true') {
      return scanSfntTables(buffer, 0);
    }
    return false;
  } catch {
    return false;
  }
}

function scanSfntTables(buffer: Buffer, base: number): boolean {
  if (base + 12 > buffer.length) return false;
  const numTables = buffer.readUInt16BE(base + 4);
  for (let i = 0; i < numTables; i++) {
    const record = base + 12 + i * 16;
    if (record + 4 > buffer.length) break;
    const tableTag = buffer.subarray(record, record + 4).toString('ascii');
    if (COLOR_TABLE_TAGS.has(tableTag)) return true;
  }
  return false;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';
import { LoadingOverlay } from './LoadingOverlay';
import { DEFAULT_PREVIEW_SAMPLES, parseSmallJsonSetting } from './SettingsDialog';

type FontItem = {
  path: string;
  name: string;
  englishName: string;
  family: string;
  ext: string;
  sizeBytes?: number;
  modifiedMs?: number;
  characterCount?: number;
  version?: string;
  unitsPerEm?: number;
  infoLoaded?: boolean;
  colorFont?: boolean;
};
type FontLibrary = { id: string; name: string; path: string };
type GlyphFilter = 'common' | 'math' | 'geometric' | 'cjk' | 'non-cjk' | 'all';
type SortableColumn = -1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface FontLookProps {
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void;
  onFontSelect?: (info: { path: string; name: string } | null) => void;
  onCreateProject?: (projectPath: string) => void;
}

const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'ttc', 'otc', 'woff', 'woff2']);
const DEFAULT_SAMPLE = '汉字之美逐浪而来0123456';
const FONT_ROW_HEIGHT = 72;
const FONT_LOAD_BUFFER_ROWS = 6;
const ACTION_COLUMN_WIDTH = 35;
const DEFAULT_COLUMN_WIDTHS = [ACTION_COLUMN_WIDTH, 360, 150, 170, 92, 150, 110, 150, 100];

const FILTER_LABELS: Record<GlyphFilter, string> = {
  common: '常用字符',
  math: '数学符号',
  geometric: '几何符号',
  cjk: 'CJK汉字集',
  'non-cjk': '非汉字集',
  all: '所有字符',
};
const COMMON_SAMPLE_TEXT = '汉字之美逐浪而来仓颉造草行隶章楷自得法度华夏书魂abcdefghijklmnOPARST1234567890';
const PRINT_UI_FONT = '"Microsoft YaHei","SimSun","SimHei",sans-serif';

type PrintSettings = {
  showUni: boolean;
  charSize: number;
  pageFormat: string;
};
type PrintSampleState = {
  font: FontItem;
  dataUrl: string;
  settings: PrintSettings;
  codes: number[];
  generatedAt: string;
  page: number;
  zoom: number;
  cols: number;
  rows: number;
};

/* ---------- Unicode 范围判定 ---------- */

function isCjkCode(code: number): boolean {
  return (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0x20000 && code <= 0x2EBEF);
}

function isMathCode(code: number): boolean {
  return (code >= 0x2200 && code <= 0x22FF)
    || (code >= 0x2A00 && code <= 0x2AFF)
    || (code >= 0x27C0 && code <= 0x27EF);
}

function isGeometricCode(code: number): boolean {
  return code >= 0x25A0 && code <= 0x25FF;
}

function isCommonCode(code: number): boolean {
  // ASCII 可打印 + 常用中文标点 + 基本 CJK 常用字
  if (code >= 0x20 && code <= 0x7E) return true;
  if (code >= 0x3000 && code <= 0x303F) return true; // CJK 标点
  if (code >= 0xFF00 && code <= 0xFFEF) return true; // 全角形式
  if (code >= 0x4E00 && code <= 0x9FFF) return true;
  return false;
}

function filterGlyphCodes(codes: number[], filter: GlyphFilter): number[] {
  if (filter === 'all') return codes;
  if (filter === 'cjk') return codes.filter(isCjkCode);
  if (filter === 'math') return codes.filter(isMathCode);
  if (filter === 'geometric') return codes.filter(isGeometricCode);
  if (filter === 'non-cjk') return codes.filter(c => !isCjkCode(c));
  if (filter === 'common') return codes.filter(isCommonCode);
  return codes;
}

function fontNameFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || filePath;
  return base.replace(/\.(ttf|otf|ttc|otc|woff2?)$/i, '');
}

function fileExt(filePath: string): string {
  const match = filePath.match(/\.([^.\\/]+)$/);
  return (match?.[1] || '').toLowerCase();
}

function isSystemInstalledFont(filePath: string): boolean {
  return /^[a-z]:\/windows\/fonts(?:\/|$)/i.test(filePath.replace(/\\/g, '/'));
}

function cssFamily(id: string, salt = ''): string {
  let hash = 2166136261;
  const value = `${salt}:${id}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ZoomlaLookFont_${(hash >>> 0).toString(36)}`;
}

function fontFileUrl(filePath: string): string {
  // 使用自定义协议 zoomla-font:// 避免 dev 模式 http:// 页面加载 file:// 跨域被拦截
  const normalized = filePath.replace(/\\/g, '/');
  return `zoomla-font://${encodeURI(normalized).replace(/#/g, '%23')}`;
}

/* ---------- 拼音排序辅助 ---------- */

function formatFileSize(bytes?: number): string {
  const value = Number(bytes || 0);
  if (!value) return '—';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function formatModified(ms?: number): string {
  const value = Number(ms || 0);
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unicodeLabel(code: number): string {
  return `0x${code.toString(16).toUpperCase().padStart(code > 0xFFFF ? 6 : 4, '0')}`;
}

function unicodeBlockName(code: number): string {
  const blocks: Array<[number, number, string]> = [
    [0x0020, 0x007F, 'Basic Latin'],
    [0x0080, 0x00FF, 'Latin-1 Supplement'],
    [0x0100, 0x017F, 'Latin Extended-A'],
    [0x0180, 0x024F, 'Latin Extended-B'],
    [0x0250, 0x02AF, 'IPA Extensions'],
    [0x02B0, 0x02FF, 'Spacing Modifier Letters'],
    [0x0370, 0x03FF, 'Greek and Coptic'],
    [0x0400, 0x04FF, 'Cyrillic'],
    [0x2000, 0x206F, 'General Punctuation'],
    [0x2200, 0x22FF, 'Mathematical Operators'],
    [0x25A0, 0x25FF, 'Geometric Shapes'],
    [0x3000, 0x303F, 'CJK Symbols and Punctuation'],
    [0x3400, 0x4DBF, 'CJK Unified Ideographs Extension A'],
    [0x4E00, 0x9FFF, 'CJK Unified Ideographs'],
    [0xF900, 0xFAFF, 'CJK Compatibility Ideographs'],
    [0xFF00, 0xFFEF, 'Halfwidth and Fullwidth Forms'],
    [0x20000, 0x2A6DF, 'CJK Unified Ideographs Extension B'],
    [0x2A700, 0x2B73F, 'CJK Unified Ideographs Extension C'],
    [0x2B740, 0x2B81F, 'CJK Unified Ideographs Extension D'],
    [0x2B820, 0x2CEAF, 'CJK Unified Ideographs Extension E/F'],
  ];
  return blocks.find(([start, end]) => code >= start && code <= end)?.[2] || 'Unicode Characters';
}

function groupCodesByBlock(codes: number[]): Array<{ name: string; codes: number[]; total: number }> {
  const groups = new Map<string, number[]>();
  codes.forEach(code => {
    const name = unicodeBlockName(code);
    groups.set(name, [...(groups.get(name) || []), code]);
  });
  return Array.from(groups.entries()).map(([name, items]) => ({ name, codes: items, total: items.length }));
}

function formatPrintPage(format: string, page: number, total: number): string {
  if (format === '1') return String(page);
  if (format === '-1-') return `- ${page} -`;
  return `Page ${page} of ${total}`;
}

function filteredCodesForPrint(codes: number[], filter: GlyphFilter): number[] {
  const available = new Set(codes);
  if (filter === 'common') {
    const seen = new Set<number>();
    return Array.from(COMMON_SAMPLE_TEXT)
      .map(char => char.codePointAt(0) || 0)
      .filter(code => code > 0 && available.has(code) && !seen.has(code) && (seen.add(code), true));
  }
  return filterGlyphCodes(codes, filter);
}

function paginateCodes(codes: number[], pageSize: number): number[][] {
  const pages: number[][] = [];
  for (let index = 0; index < codes.length; index += pageSize) {
    pages.push(codes.slice(index, index + pageSize));
  }
  return pages.length ? pages : [[]];
}

function clampSourceRect(rect: { left: number; top: number; width: number; height: number }): { left: number; top: number; width: number; height: number } {
  const width = Math.min(rect.width, Math.max(220, window.innerWidth - 16));
  const height = Math.min(rect.height, Math.max(220, window.innerHeight - 16));
  return {
    width,
    height,
    left: Math.max(0, Math.min(window.innerWidth - width - 8, rect.left)),
    top: Math.max(0, Math.min(window.innerHeight - 80, rect.top)),
  };
}

function sourceRectFromRatio(ratio: { leftRatio?: number; topRatio?: number; width?: number; height?: number }) {
  const width = Number.isFinite(Number(ratio.width)) ? Number(ratio.width) : 280;
  const height = Number.isFinite(Number(ratio.height)) ? Number(ratio.height) : 420;
  const leftRatio = Number.isFinite(Number(ratio.leftRatio)) ? Number(ratio.leftRatio) : 0.02;
  const topRatio = Number.isFinite(Number(ratio.topRatio)) ? Number(ratio.topRatio) : 0.16;
  return clampSourceRect({
    left: Math.round(window.innerWidth * leftRatio),
    top: Math.round(window.innerHeight * topRatio),
    width,
    height,
  });
}

function pinyinKey(text: string): string {
  try {
    return (text || '').localeCompare('', 'zh-CN-pinyin') as unknown as string || text;
  } catch {
    return text;
  }
}

export const FontLook: React.FC<FontLookProps> = ({ showToast, onFontSelect, onCreateProject }) => {
  /* ---- 状态 ---- */
  const [libraries, setLibraries] = useState<FontLibrary[]>([]);
  const [activeLibraryId, setActiveLibraryId] = useState('');
  const [fonts, setFonts] = useState<FontItem[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [sampleText, setSampleText] = useState(DEFAULT_SAMPLE);
  const [sampleTextLoaded, setSampleTextLoaded] = useState(false);
  const [previewSize, setPreviewSize] = useState(48);
  const [glyphFilter, setGlyphFilter] = useState<GlyphFilter>('common');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedFontDataUrl, setSelectedFontDataUrl] = useState('');
  const [selectedFontCodes, setSelectedFontCodes] = useState<number[]>([]);
  const [fontDataUrls, setFontDataUrls] = useState<Record<string, string>>({});
  const [loadedFontCount, setLoadedFontCount] = useState(0);
  const [visibleFontRange, setVisibleFontRange] = useState({ start: 0, end: 0 });
  const [fontPreviewLoading, setFontPreviewLoading] = useState(false);
  const [columnWidths, setColumnWidths] = useState(DEFAULT_COLUMN_WIDTHS);
  const [columnWidthsLoaded, setColumnWidthsLoaded] = useState(false);
  const [resizing, setResizing] = useState<{ index: number; startX: number; startWidth: number } | null>(null);

  // 右键菜单 & 操作下拉
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; font: FontItem } | null>(null);
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number; font: FontItem } | null>(null);
  const [printSample, setPrintSample] = useState<PrintSampleState | null>(null);

  // 排序
  const [sortColumn, setSortColumn] = useState<SortableColumn>(-1);
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  // 悬浮制版器
  const [showPlatePane, setShowPlatePane] = useState(false);
  const [plateText, setPlateText] = useState('');
  const [plateSize, setPlateSize] = useState(64);
  const [plateRect, setPlateRect] = useState({ left: 200, top: 120, width: 800, height: 280 });
  const [plateDrag, setPlateDrag] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const [showPreviewSamples, setShowPreviewSamples] = useState(false);
  const [previewSamples, setPreviewSamples] = useState<string[]>(DEFAULT_PREVIEW_SAMPLES);
  const [plateStateLoaded, setPlateStateLoaded] = useState(false);

  // 悬浮来源面板
  const [showLeftPane, setShowLeftPane] = useState(true);
  const [sourceRect, setSourceRect] = useState({ left: 16, top: 120, width: 280, height: 420 });
  const [sourceDrag, setSourceDrag] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const [sourceStateLoaded, setSourceStateLoaded] = useState(false);

  // 字体来源下拉（与浮动面板共存）
  const [showSourceDropdown, setShowSourceDropdown] = useState(false);
  const [sourceContextMenu, setSourceContextMenu] = useState<{ x: number; y: number; lib: FontLibrary } | null>(null);
  const dragLibIndex = useRef<number | null>(null);
  const sourceDropdownBtnRef = useRef<HTMLButtonElement | null>(null);
  const [sourceDropdownPos, setSourceDropdownPos] = useState({ left: 0, top: 0 });

  // 右侧筛选区宽度拖拽
  const [rightPaneW, setRightPaneW] = useState(300);
  const [rightPaneDrag, setRightPaneDrag] = useState<number | null>(null);

  // 深色衬色模式
  const [darkMode, setDarkMode] = useState(false);
  const darkModeLoaded = useRef(false);

  useEffect(() => {
    window.electronAPI.dbGetSetting('look.darkMode', 'false').then(value => {
      if (value === 'true') setDarkMode(true);
    }).catch(() => {}).finally(() => { darkModeLoaded.current = true; });
  }, []);

  useEffect(() => {
    if (!darkModeLoaded.current) return;
    void window.electronAPI.dbSetSetting('look.darkMode', String(darkMode));
  }, [darkMode]);

  // 上次加载的字体源（记住用户选择）
  const lastLibRef = useRef('');
  const sourceRatioRef = useRef({ leftRatio: 16 / Math.max(1, window.innerWidth), topRatio: 120 / Math.max(1, window.innerHeight) });
  const fontRowsRef = useRef<HTMLDivElement | null>(null);
  const fontPreviewLoadingTimerRef = useRef<number | null>(null);
  const fontInfoLoadingRef = useRef(new Set<string>());

  /* ---- 计算 ---- */
  const activeLibrary = libraries.find(item => item.id === activeLibraryId) || libraries[0] || null;
  const selectedFont = fonts.find(item => item.path === selectedPath) || fonts[0] || null;

  const filteredFonts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return fonts;
    return fonts.filter(font =>
      font.name.toLowerCase().includes(keyword)
      || font.englishName.toLowerCase().includes(keyword)
      || font.path.toLowerCase().includes(keyword),
    );
  }, [fonts, search]);

  // 排序
  const sortedFonts = useMemo(() => {
    if (sortColumn === -1) return filteredFonts;
    const dir = sortDir;
    return [...filteredFonts].sort((a, b) => {
      if (sortColumn === 4 || sortColumn === 6 || sortColumn === 7 || sortColumn === 8) {
        const va = sortColumn === 4 ? (a.characterCount || 0) : sortColumn === 6 ? (a.unitsPerEm || 0) : sortColumn === 7 ? (a.modifiedMs || 0) : (a.sizeBytes || 0);
        const vb = sortColumn === 4 ? (b.characterCount || 0) : sortColumn === 6 ? (b.unitsPerEm || 0) : sortColumn === 7 ? (b.modifiedMs || 0) : (b.sizeBytes || 0);
        return dir * (va - vb);
      }
      let va = '';
      let vb = '';
      if (sortColumn === 2) { va = a.name; vb = b.name; }
      else if (sortColumn === 3) { va = a.englishName; vb = b.englishName; }
      else if (sortColumn === 5) { va = a.version || ''; vb = b.version || ''; }
      return dir * va.localeCompare(vb, 'zh-CN');
    });
  }, [filteredFonts, sortColumn, sortDir]);

  const previewRowHeight = useMemo(() => Math.max(FONT_ROW_HEIGHT, Math.ceil(previewSize * 1.35)), [previewSize]);

  const visibleFontRowCapacity = useCallback(() => {
    const height = fontRowsRef.current?.clientHeight || 520;
    return Math.max(8, Math.ceil(height / previewRowHeight) + FONT_LOAD_BUFFER_ROWS);
  }, [previewRowHeight]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      const end = Math.min(visibleFontRowCapacity(), sortedFonts.length);
      setLoadedFontCount(end);
      setVisibleFontRange({ start: 0, end });
    });
  }, [activeLibraryId, search, sortColumn, sortDir, sortedFonts.length, visibleFontRowCapacity]);

  useEffect(() => {
    if (!sortedFonts.length) return;
    if (fontPreviewLoadingTimerRef.current) window.clearTimeout(fontPreviewLoadingTimerRef.current);
    setFontPreviewLoading(true);
    fontPreviewLoadingTimerRef.current = window.setTimeout(() => setFontPreviewLoading(false), 650);
    return () => {
      if (fontPreviewLoadingTimerRef.current) window.clearTimeout(fontPreviewLoadingTimerRef.current);
    };
  }, [visibleFontRange.start, visibleFontRange.end, sortedFonts.length]);

  const loadedFonts = useMemo(() => {
    const start = Math.max(0, visibleFontRange.start);
    const end = Math.min(sortedFonts.length, Math.max(visibleFontRange.end, start + visibleFontRowCapacity()));
    const list = sortedFonts.slice(start, end);
    if (selectedFont && !list.some(font => font.path === selectedFont.path)) return [selectedFont, ...list];
    return list;
  }, [visibleFontRange, sortedFonts, selectedFont, visibleFontRowCapacity]);

  useEffect(() => {
    let cancelled = false;
    const targets = loadedFonts
      .filter(font => !font.infoLoaded && !fontInfoLoadingRef.current.has(font.path))
      .slice(0, 12);
    if (!targets.length) return;
    targets.forEach(font => {
      fontInfoLoadingRef.current.add(font.path);
      window.electronAPI.getFontInfo(font.path)
        .then(info => {
          if (cancelled) return;
          setFonts(prev => prev.map(item => {
            if (item.path !== font.path) return item;
            if (!info.success) return { ...item, infoLoaded: true };
            return {
              ...item,
              name: info.chineseName || item.name,
              englishName: info.englishName || item.englishName,
              family: info.family || item.family,
              characterCount: info.characterCount || info.glyphCount || item.characterCount,
              version: info.version || item.version || '',
              unitsPerEm: info.unitsPerEm || item.unitsPerEm,
              colorFont: info.colorFont,
              infoLoaded: true,
            };
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setFonts(prev => prev.map(item => item.path === font.path ? { ...item, infoLoaded: true } : item));
        })
        .finally(() => {
          fontInfoLoadingRef.current.delete(font.path);
        });
    });
    return () => { cancelled = true; };
  }, [loadedFonts]);

  useEffect(() => {
    let cancelled = false;
    const targets = loadedFonts.filter(font => !fontDataUrls[font.path]);
    if (!targets.length) return;
    targets.forEach(font => {
      window.electronAPI.getFontDataUrl(font.path)
        .then(result => {
          if (cancelled || !result.success || !result.dataUrl) return;
          setFontDataUrls(prev => prev[font.path] ? prev : { ...prev, [font.path]: result.dataUrl! });
        })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [loadedFonts, fontDataUrls]);

  const handleFontRowsScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    const start = Math.max(0, Math.floor(node.scrollTop / previewRowHeight) - FONT_LOAD_BUFFER_ROWS);
    const end = Math.min(sortedFonts.length, Math.ceil((node.scrollTop + node.clientHeight) / previewRowHeight) + FONT_LOAD_BUFFER_ROWS);
    setVisibleFontRange(prev => prev.start === start && prev.end === end ? prev : { start, end });
    setLoadedFontCount(end);
  }, [previewRowHeight, sortedFonts.length]);

  // 根据筛选器 + 选中字体的 codes 产出字形列表
  const glyphCodes = useMemo(() => {
    if (!selectedFont) return [] as number[];
    const available = new Set(selectedFontCodes);
    if (glyphFilter === 'common') {
      const seen = new Set<number>();
      return Array.from(COMMON_SAMPLE_TEXT)
        .map(char => char.codePointAt(0) || 0)
        .filter(code => code > 0 && available.has(code) && !seen.has(code) && (seen.add(code), true));
    }
    return filterGlyphCodes(selectedFontCodes, glyphFilter);
  }, [glyphFilter, selectedFont, selectedFontCodes]);

  const selectedFamily = selectedFont ? cssFamily(selectedFont.path) : UI_FONT;

  /* ---- Effects ---- */

  // 加载字体库
  useEffect(() => {
    window.electronAPI.dbGetSetting('look.fontLibraries', '[]').then(raw => {
      const parsed = parseSmallJsonSetting<unknown>(raw, []);
      if (Array.isArray(parsed) && parsed.length) {
        const safeLibraries = parsed
          .map((item: any) => ({ id: String(item?.id || ''), name: String(item?.name || '').slice(0, 120), path: String(item?.path || '').slice(0, 1000) }))
          .filter(item => item.id && item.path)
          .slice(0, 20);
        if (safeLibraries.length) {
          setLibraries(safeLibraries);
          // 恢复上次选中的来源
          window.electronAPI.dbGetSetting('look.lastLibraryId', '').then(lastId => {
            const found = safeLibraries.find(l => l.id === lastId);
            setActiveLibraryId(found ? found.id : safeLibraries[0].id);
            lastLibRef.current = found ? found.id : safeLibraries[0].id;
          }).catch(() => setActiveLibraryId(safeLibraries[0].id));
          return;
        }
      }
      const defaults: FontLibrary[] = [{ id: 'system-fonts', name: '系统已装字库', path: 'C:\\Windows\\Fonts' }];
      setLibraries(defaults);
      setActiveLibraryId(defaults[0].id);
    });
  }, []);

  useEffect(() => {
    if (libraries.length) void window.electronAPI.dbSetSetting('look.fontLibraries', JSON.stringify(libraries));
  }, [libraries]);

  // 记住用户选中的来源
  useEffect(() => {
    if (activeLibraryId && activeLibraryId !== lastLibRef.current) {
      lastLibRef.current = activeLibraryId;
      void window.electronAPI.dbSetSetting('look.lastLibraryId', activeLibraryId);
    }
  }, [activeLibraryId]);

  useEffect(() => {
    window.electronAPI.dbGetSetting('look.sampleText', DEFAULT_SAMPLE).then(value => {
      setSampleText(String(value ?? DEFAULT_SAMPLE));
    }).catch(() => {}).finally(() => setSampleTextLoaded(true));
  }, []);

  useEffect(() => {
    if (!sampleTextLoaded) return;
    void window.electronAPI.dbSetSetting('look.sampleText', sampleText);
  }, [sampleTextLoaded, sampleText]);

  // 加载 previewSamples
  useEffect(() => {
    window.electronAPI.dbGetSetting('previewSamples', JSON.stringify(DEFAULT_PREVIEW_SAMPLES)).then(raw => {
      const parsed = parseSmallJsonSetting<unknown>(raw || '[]', []);
      if (Array.isArray(parsed) && parsed.length) {
        setPreviewSamples(parsed.map(item => String(item || '').slice(0, 500)).filter(Boolean).slice(0, 20));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    window.electronAPI.dbGetSetting('look.columnWidths', '').then(raw => {
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setColumnWidths(prev => DEFAULT_COLUMN_WIDTHS.map((fallback, index) => {
        if (index === 0) return ACTION_COLUMN_WIDTH;
        const value = index < parsed.length ? parsed[index] : prev[index] || fallback;
        return Math.max(80, Math.min(900, Math.round(Number(value) || fallback)));
      }));
    }).catch(() => {}).finally(() => setColumnWidthsLoaded(true));
  }, []);

  useEffect(() => {
    if (!columnWidthsLoaded) return;
    void window.electronAPI.dbSetSetting('look.columnWidths', JSON.stringify(columnWidths.map((width, index) => index === 0 ? ACTION_COLUMN_WIDTH : width)));
  }, [columnWidthsLoaded, columnWidths]);

  useEffect(() => {
    window.electronAPI.dbGetSetting('look.platePaneState', '').then(raw => {
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed.open === 'boolean') setShowPlatePane(parsed.open);
      if (typeof parsed.text === 'string') setPlateText(parsed.text);
      if (Number.isFinite(Number(parsed.size))) setPlateSize(Number(parsed.size));
      if (parsed.rect && typeof parsed.rect === 'object') {
        setPlateRect(prev => ({
          left: Number.isFinite(Number(parsed.rect.left)) ? Number(parsed.rect.left) : prev.left,
          top: Number.isFinite(Number(parsed.rect.top)) ? Number(parsed.rect.top) : prev.top,
          width: Number.isFinite(Number(parsed.rect.width)) ? Number(parsed.rect.width) : prev.width,
          height: Number.isFinite(Number(parsed.rect.height)) ? Number(parsed.rect.height) : prev.height,
        }));
      }
    }).catch(() => {}).finally(() => setPlateStateLoaded(true));
  }, []);

  useEffect(() => {
    if (!plateStateLoaded) return;
    void window.electronAPI.dbSetSetting('look.platePaneState', JSON.stringify({
      open: showPlatePane,
      text: plateText,
      size: plateSize,
      rect: plateRect,
    }));
  }, [plateStateLoaded, showPlatePane, plateText, plateSize, plateRect]);

  useEffect(() => {
    window.electronAPI.dbGetSetting('look.sourcePaneState', '').then(raw => {
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed.open === 'boolean') setShowLeftPane(parsed.open);
      if (Number.isFinite(Number(parsed.leftRatio)) || Number.isFinite(Number(parsed.topRatio))) {
        sourceRatioRef.current = {
          leftRatio: Number.isFinite(Number(parsed.leftRatio)) ? Number(parsed.leftRatio) : sourceRatioRef.current.leftRatio,
          topRatio: Number.isFinite(Number(parsed.topRatio)) ? Number(parsed.topRatio) : sourceRatioRef.current.topRatio,
        };
        setSourceRect(sourceRectFromRatio(parsed));
        return;
      }
      if (parsed.rect && typeof parsed.rect === 'object') {
        setSourceRect(prev => clampSourceRect({
          left: Number.isFinite(Number(parsed.rect.left)) ? Number(parsed.rect.left) : prev.left,
          top: Number.isFinite(Number(parsed.rect.top)) ? Number(parsed.rect.top) : prev.top,
          width: Number.isFinite(Number(parsed.rect.width)) ? Number(parsed.rect.width) : prev.width,
          height: Number.isFinite(Number(parsed.rect.height)) ? Number(parsed.rect.height) : prev.height,
        }));
      }
    }).catch(() => {}).finally(() => setSourceStateLoaded(true));
  }, []);

  useEffect(() => {
    if (!sourceStateLoaded) return;
    void window.electronAPI.dbSetSetting('look.sourcePaneState', JSON.stringify({
      open: showLeftPane,
      leftRatio: sourceRatioRef.current.leftRatio,
      topRatio: sourceRatioRef.current.topRatio,
      width: sourceRect.width,
      height: sourceRect.height,
    }));
  }, [sourceStateLoaded, showLeftPane, sourceRect]);

  useEffect(() => {
    if (!sourceStateLoaded) return;
    const onResize = () => {
      setSourceRect(prev => {
        return sourceRectFromRatio({ ...sourceRatioRef.current, width: prev.width, height: prev.height });
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sourceStateLoaded]);

  const scanDirectory = useCallback(async (root: string) => {
    const result: FontItem[] = [];
    const stack = [root];
    const visited = new Set<string>();
    while (stack.length) {
      const dir = stack.pop()!;
      if (visited.has(dir)) continue;
      visited.add(dir);
      let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean; size?: number; mtimeMs?: number }> = [];
      try {
        entries = await window.electronAPI.fsListDir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = await window.electronAPI.pathJoin(dir, entry.name);
        if (entry.isDirectory) {
          if (visited.size < 500) stack.push(full);
          continue;
        }
        const ext = fileExt(entry.name);
        if (entry.isFile && FONT_EXTENSIONS.has(ext)) {
          const name = fontNameFromPath(full);
          result.push({
            path: full,
            name,
            englishName: name,
            family: name,
            ext,
            sizeBytes: Number(entry.size || 0),
            modifiedMs: Number(entry.mtimeMs || 0),
          });
        }
      }
      if (result.length >= 5000) break;
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }, []);

  const refreshFonts = useCallback(async () => {
    if (!activeLibrary) return;
    setBusy(true);
    try {
      if (!(await window.electronAPI.fsExists(activeLibrary.path))) {
        showToast(`字体源不存在：${activeLibrary.path}`, 'error');
        setFonts([]);
        return;
      }
      const next = await scanDirectory(activeLibrary.path);
      setFonts(next);
      setSelectedPath(next[0]?.path || '');
      showToast(`已扫描 ${next.length} 个字体文件`, 'success');
    } finally {
      setBusy(false);
    }
  }, [activeLibrary, scanDirectory, showToast]);

  useEffect(() => {
    void refreshFonts();
  }, [activeLibraryId]);

  // 选中字体 → data: URL
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!selectedFont) {
        setSelectedFontDataUrl('');
        setSelectedFontCodes([]);
        return;
      }
      const [dataUrlResult, analyzeResult] = await Promise.all([
        window.electronAPI.getFontDataUrl(selectedFont.path),
        window.electronAPI.analyzeFont(selectedFont.path),
      ]);
      if (!cancelled) {
        setSelectedFontDataUrl(dataUrlResult.success ? dataUrlResult.dataUrl || '' : '');
        setSelectedFontCodes(analyzeResult.success ? (analyzeResult.codes || []).filter(code => code >= 0x20) : []);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [selectedFont?.path]);

  // 通知父窗体
  useEffect(() => {
    onFontSelect?.(selectedFont ? { path: selectedFont.path, name: selectedFont.name } : null);
  }, [selectedFont, onFontSelect]);

  // 列宽拖拽
  const onResizeStart = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (index === 0) return;
    setResizing({ index, startX: e.clientX, startWidth: columnWidths[index] });
  }, [columnWidths]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      setColumnWidths(prev => {
        const next = [...prev];
        next[resizing.index] = Math.max(resizing.index === 0 ? 48 : 80, resizing.startWidth + (e.clientX - resizing.startX));
        return next;
      });
    };
    const onUp = () => setResizing(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  // 右侧筛选区宽度拖拽
  useEffect(() => {
    if (rightPaneDrag === null) return;
    const onMove = (e: MouseEvent) => {
      setRightPaneW(Math.max(180, Math.min(600, window.innerWidth - e.clientX)));
    };
    const onUp = () => setRightPaneDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [rightPaneDrag]);

  // 制版器拖拽
  useEffect(() => {
    if (!plateDrag) return;
    const onMove = (e: MouseEvent) => {
      setPlateRect(prev => ({
        ...prev,
        left: Math.max(0, plateDrag.left + (e.clientX - plateDrag.x)),
        top: Math.max(0, plateDrag.top + (e.clientY - plateDrag.y)),
      }));
    };
    const onUp = () => setPlateDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [plateDrag]);

  // 字体来源窗口拖拽
  useEffect(() => {
    if (!sourceDrag) return;
    const onMove = (e: MouseEvent) => {
      setSourceRect(prev => {
        const next = clampSourceRect({
          ...prev,
          left: sourceDrag.left + (e.clientX - sourceDrag.x),
          top: sourceDrag.top + (e.clientY - sourceDrag.y),
        });
        sourceRatioRef.current = {
          leftRatio: window.innerWidth > 0 ? next.left / window.innerWidth : 0,
          topRatio: window.innerHeight > 0 ? next.top / window.innerHeight : 0,
        };
        return next;
      });
    };
    const onUp = () => setSourceDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sourceDrag]);

  // F5 刷新字体
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        void refreshFonts();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refreshFonts]);

  // F8 开关制版器
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault();
        setShowPlatePane(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 全局点击关闭菜单
  useEffect(() => {
    const onClick = () => { setContextMenu(null); setActionMenu(null); };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  const gridCols = columnWidths.map((w, index) => `${index === 0 ? ACTION_COLUMN_WIDTH : w}px`).join(' ');

  /* ---- 操作 ---- */

  const addLibrary = async () => {
    const dir = await window.electronAPI.openDirectory({ title: '选择字体资源库目录' });
    if (!dir) return;
    const name = await window.electronAPI.pathBasename(dir);
    const item = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: name || dir, path: dir };
    setLibraries(prev => [...prev, item]);
    setActiveLibraryId(item.id);
  };

  const removeLibrary = (lib?: FontLibrary) => {
    const target = lib || activeLibrary;
    if (!target) return;
    const next = libraries.filter(item => item.id !== target.id);
    setLibraries(next);
    if (target.id === activeLibraryId) {
      setActiveLibraryId(next[0]?.id || '');
      setFonts([]);
    }
  };

  const openFontDir = async (font: FontItem | null) => {
    if (!font) return;
    const dir = await window.electronAPI.pathDirname(font.path);
    const result = await window.electronAPI.openPath(dir);
    if (!result.success) showToast(result.error || '无法打开目录', 'error');
  };

  const viewFont = async (font: FontItem | null) => {
    if (!font) return;
    const result = await window.electronAPI.openPath(font.path);
    if (!result.success) showToast(result.error || '无法打开字体文件', 'error');
  };

  const installFont = async (font: FontItem | null) => {
    if (!font) return;
    const result = await window.electronAPI.installFont(font.path);
    if (result.success) showToast(result.message || '字体已安装到当前用户', 'success');
    else showToast(result.error || '字体安装失败', 'error');
  };

  const createProjectFromFont = async (font: FontItem | null) => {
    if (!font) return;
    const suggested = `${fontNameFromPath(font.path)}.z01`;
    const output = await window.electronAPI.saveFile({
      title: '.z01工程文件存放处',
      defaultPath: suggested,
      filters: [{ name: 'Zoomla design project', extensions: ['z01'] }],
    });
    if (!output) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.createDesignProject(font.path, output);
      if (result.success) {
        showToast('工程已创建', 'success');
        onCreateProject?.(result.path || output);
      } else {
        showToast(result.error || '创建工程失败', 'error');
      }
    } catch (error: any) {
      showToast(error?.message || '创建工程失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const printFontSample = async (font: FontItem | null) => {
    if (!font) return;
    setBusy(true);
    try {
      const [showUniRaw, charSizeRaw, pageFormatRaw, dataUrlResult, analyzeResult] = await Promise.all([
        window.electronAPI.dbGetSetting('printShowUni', 'true'),
        window.electronAPI.dbGetSetting('printCharSize', '48'),
        window.electronAPI.dbGetSetting('printPageFormat', '1 / N'),
        fontDataUrls[font.path]
          ? Promise.resolve({ success: true, dataUrl: fontDataUrls[font.path] })
          : window.electronAPI.getFontDataUrl(font.path),
        selectedFont?.path === font.path && selectedFontCodes.length
          ? Promise.resolve({ success: true, codes: selectedFontCodes })
          : window.electronAPI.analyzeFont(font.path),
      ]);
      const settings: PrintSettings = {
        showUni: showUniRaw === 'true' || showUniRaw === '',
        charSize: Math.max(18, Math.min(96, Number(charSizeRaw) || 48)),
        pageFormat: pageFormatRaw || '1 / N',
      };
      if (!dataUrlResult.success || !dataUrlResult.dataUrl) {
        showToast('字体加载失败，无法生成打印样本', 'error');
        return;
      }
      const rawCodes = analyzeResult.success ? (analyzeResult.codes || []).filter(code => code >= 0x20) : [];
      const codes = filteredCodesForPrint(rawCodes, glyphFilter);
      if (!codes.length) {
        showToast('当前筛选器没有可打印字符', 'info');
        return;
      }
      setPrintSample({
        font,
        dataUrl: dataUrlResult.dataUrl,
        settings,
        codes,
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        page: 0,
        zoom: 1,
        cols: 16,
        rows: 18,
      });
    } catch (error: any) {
      showToast(error?.message || '生成打印样本失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSort = (col: SortableColumn) => {
    if (col === -1) return;
    if (sortColumn === col) {
      setSortDir(d => (d === 1 ? -1 : 1));
    } else {
      setSortColumn(col);
      setSortDir(1);
    }
  };

  const sortIndicator = (col: SortableColumn) => {
    if (sortColumn !== col) return '';
    return sortDir === 1 ? ' ▲' : ' ▼';
  };

  /* ---- JSX ---- */

  // 共用菜单项
  const fontMenuItems = (font: FontItem, onClose: () => void) => (
    <>
      <button style={styles.contextMenuItem} onClick={() => { onClose(); void createProjectFromFont(font); }}>新工程</button>
      {isSystemInstalledFont(font.path)
        ? <button style={styles.contextMenuItemDisabled} disabled>已安装</button>
        : <button style={styles.contextMenuItem} onClick={() => { onClose(); void installFont(font); }}>安装</button>}
      <button style={styles.contextMenuItem} onClick={() => { onClose(); void openFontDir(font); }}>所在文件夹</button>
      <button style={styles.contextMenuItem} onClick={() => { onClose(); void viewFont(font); }}>默认方式打开</button>
      <button style={styles.contextMenuItem} onClick={() => { onClose(); void printFontSample(font); }}>打印样本</button>
    </>
  );

  const renderPrintPage = (sample: PrintSampleState, codes: number[], pageIndex: number, totalPages: number, printMode = false) => {
    const title = sample.font.name || sample.font.family || fontNameFromPath(sample.font.path);
    const cellHeight = 49;
    const pageNumber = formatPrintPage(sample.settings.pageFormat, pageIndex + 1, totalPages);
    return (
      <section key={`print-page-${pageIndex}`} className="print-sample-page" style={styles.printPage}>
        <header style={styles.printTopline}><span>作品样本</span><span>{sample.generatedAt}</span></header>
        <h1 style={styles.printTitle}>{title}</h1>
        <main style={styles.printMain}>
          <div style={styles.printBlockTitle}>{FILTER_LABELS[glyphFilter]} ({codes.length} / {sample.codes.length})</div>
          <div style={{ ...styles.printGrid, gridTemplateColumns: `repeat(${sample.cols}, 1fr)`, gridTemplateRows: `repeat(${sample.rows}, ${cellHeight}px)` }}>
            {codes.map(code => (
              <div key={`${pageIndex}-${code}`} style={{ ...styles.printCell, height: cellHeight }}>
                {sample.settings.showUni && <div style={styles.printUni}>{unicodeLabel(code)}</div>}
                <div style={{ ...styles.printGlyph, fontSize: Math.min(sample.settings.charSize, 36), lineHeight: `${sample.settings.showUni ? cellHeight - 11 : cellHeight}px`, paddingTop: sample.settings.showUni ? 9 : 0 }}>{String.fromCodePoint(code)}</div>
              </div>
            ))}
            {Array.from({ length: Math.max(0, sample.cols * sample.rows - codes.length) }).map((_, index) => <div key={`blank-${pageIndex}-${index}`} style={{ ...styles.printCell, height: cellHeight }} />)}
          </div>
        </main>
        <footer style={styles.printFooter}><span>制版软件：逐浪羲之 z01.cn</span><span>{pageNumber}</span></footer>
        {!printMode && <div style={styles.printPageMeta}>第 {pageIndex + 1} 页 / 共 {totalPages} 页</div>}
      </section>
    );
  };

  return (
    <div data-f8-scope="font-look" style={styles.shell} onClick={() => { setContextMenu(null); setActionMenu(null); setShowSourceDropdown(false); setSourceContextMenu(null); }}>
      <style>
        {loadedFonts
          .filter(font => fontDataUrls[font.path])
          .map(font => `@font-face{font-family:"${cssFamily(font.path)}";src:url("${fontDataUrls[font.path]}");font-display:swap;}`)
          .join('\n')}
        {selectedFontDataUrl ? `@font-face{font-family:"${selectedFamily}";src:url("${selectedFontDataUrl}");font-display:swap;}` : ''}
        {printSample ? `@font-face{font-family:"ZoomlaPrintSample";src:url("${printSample.dataUrl}");font-display:block;}` : ''}
        {printSample ? `
          @media print {
            body * { visibility: hidden !important; }
            .print-sample-print-root, .print-sample-print-root * { visibility: visible !important; }
            .print-sample-print-root { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; background: #fff !important; }
            .print-sample-page { width: 210mm !important; height: 297mm !important; margin: 0 !important; box-shadow: none !important; page-break-after: always !important; break-after: page !important; }
          }
          @page { size: A4 portrait; margin: 0; }
        ` : ''}
      </style>
      <LoadingOverlay visible={busy} inline message="正在扫描字体文件..." />

      {/* ====== 来源切换按钮（左下角） ====== */}
      <button
        type="button"
        title="字体来源"
        style={styles.sourceToggle}
        onClick={e => { e.stopPropagation(); setShowLeftPane(v => !v); }}
      >
        <i className="ri-folder-2-line" />
        <span style={{ fontSize: 12 }}>{activeLibrary?.name || '来源'}</span>
      </button>

      {/* ====== 悬浮来源面板 ====== */}
      {showLeftPane && (
        <div style={{ ...styles.floatingSource, left: sourceRect.left, top: sourceRect.top, width: sourceRect.width, maxHeight: sourceRect.height }} onClick={e => e.stopPropagation()}>
          <div
            style={styles.floatingTitle}
            onMouseDown={e => {
              e.preventDefault();
              setSourceDrag({ x: e.clientX, y: e.clientY, left: sourceRect.left, top: sourceRect.top });
            }}
          >
            <span>字体来源</span>
            <button style={styles.floatingClose} onMouseDown={e => e.stopPropagation()} onClick={() => setShowLeftPane(false)}><i className="ri-close-line" /></button>
          </div>
          <div style={styles.sourceToolbar}>
            <button title="增加字体源" style={styles.iconBtn} onClick={addLibrary}><i className="ri-folder-add-line" /></button>
            <button title="移除字体源" style={styles.iconBtn} onClick={() => removeLibrary()}><i className="ri-delete-bin-line" /></button>
            <button title="刷新" style={styles.iconBtn} onClick={() => void refreshFonts()}><i className="ri-refresh-line" /></button>
          </div>
          <div style={styles.sourceList}>
            {libraries.map(lib => (
              <button key={lib.id} title={lib.path} style={lib.id === activeLibraryId ? styles.sourceActive : styles.sourceItem} onClick={() => { setActiveLibraryId(lib.id); }}>
                <i className="ri-folder-2-line" />
                <span style={styles.sourceName}>{lib.name}</span>
                <span style={styles.sourceCount}>{lib.id === activeLibraryId ? fonts.length : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ====== 主区域：预览区 + 筛选区 ====== */}
      <div style={styles.mainArea}>
        {/* 预览区 */}
        <main style={{ ...styles.centerPane, ...(darkMode ? { background: '#000000' } : {}) }}>
          <div style={styles.listHeader}>
            <input style={styles.sampleInput} value={sampleText} onChange={event => setSampleText(event.target.value)} placeholder="快速预览文本" />
            <select style={styles.sizeSelect} value={previewSize} onChange={event => setPreviewSize(Number(event.target.value))}>
              {[32, 40, 48, 64, 80, 96].map(size => <option key={size} value={size}>{size}</option>)}
            </select>
            <button type="button" title="刷新字体F5" style={styles.toolbarIconBtn} onClick={() => void refreshFonts()}><i className="ri-refresh-line" /></button>
            <button type="button" title="制版器F8" style={styles.toolbarIconBtn} onClick={() => setShowPlatePane(v => !v)}><i className="ri-layout-left-2-fill" /></button>
            <button type="button" title="字体来源" style={styles.toolbarIconBtn} onClick={() => setShowLeftPane(v => !v)}><i className="ri-folder-3-line" /></button>
            <button type="button" title="切换衬色" style={styles.toolbarIconBtn} onClick={() => setDarkMode(v => !v)}><i className={darkMode ? 'ri-checkbox-blank-fill' : 'ri-checkbox-blank-line'} /></button>
            <span style={styles.sourceDropdownWrap}>
              <button
                ref={sourceDropdownBtnRef}
                type="button"
                title="字体来源列表"
                style={styles.sourceDropdownBtn}
                onClick={e => {
                  e.stopPropagation();
                  const rect = sourceDropdownBtnRef.current?.getBoundingClientRect();
                  if (rect) setSourceDropdownPos({ left: rect.left, top: rect.bottom + 4 });
                  setShowSourceDropdown(v => !v);
                }}
              >
                目标来源<i className="ri-arrow-down-s-line" style={{ fontSize: 10, marginLeft: 4, flexShrink: 0 }} />
              </button>
              {showSourceDropdown && (
                <div style={{ ...styles.sourceDropdown, left: sourceDropdownPos.left, top: sourceDropdownPos.top }} onClick={e => e.stopPropagation()}>
                  <div style={styles.sourceDropdownList}>
                    {libraries.map((lib, index) => (
                      <button
                        key={lib.id}
                        draggable
                        title={lib.path}
                        style={lib.id === activeLibraryId ? styles.sourceDropdownActive : styles.sourceDropdownItem}
                        onClick={() => { setActiveLibraryId(lib.id); setShowSourceDropdown(false); }}
                        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setSourceContextMenu({ x: e.clientX, y: e.clientY, lib }); }}
                        onDragStart={() => { dragLibIndex.current = index; }}
                        onDragOver={e => { e.preventDefault(); }}
                        onDrop={() => {
                          if (dragLibIndex.current === null || dragLibIndex.current === index) return;
                          const next = [...libraries];
                          const [moved] = next.splice(dragLibIndex.current, 1);
                          next.splice(index, 0, moved);
                          setLibraries(next);
                          dragLibIndex.current = null;
                        }}
                      >
                        <i className="ri-draggable" style={{ cursor: 'grab', color: COLORS.TEXT_LIGHT, fontSize: 12 }} />
                        <i className={lib.id === activeLibraryId ? 'ri-check-line' : ''} style={{ color: COLORS.ACCENT, fontSize: 14 }} />
                        <span style={styles.sourceDropdownName}>{lib.name}</span>
                        <span style={styles.sourceDropdownCount}>{lib.id === activeLibraryId ? fonts.length : ''}</span>
                      </button>
                    ))}
                    {libraries.length === 0 && <div style={styles.sourceDropdownEmpty}>暂无字体来源，请添加</div>}
                  </div>
                  <button style={styles.sourceDropdownAdd} onClick={() => { void addLibrary(); }}><i className="ri-folder-add-line" /> 增加文件夹来源</button>
                </div>
              )}
            </span>
            <span style={styles.searchWrap}>
              <i className="ri-search-line" style={styles.searchIcon} />
              <input style={styles.searchInput} value={searchDraft} onChange={event => setSearchDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') setSearch((event.target as HTMLInputElement).value); }} placeholder="输入字体名称（回车搜索）" />
            </span>
          </div>
          <div style={{ ...styles.tableHead, gridTemplateColumns: gridCols }}>
            <span style={{ ...styles.headerCell, justifyContent: 'center', padding: 0 }}>操作</span>
            <span style={styles.headerCell}>快速预览<span style={styles.resizeHandle} onMouseDown={e => onResizeStart(1, e)} /></span>
            <span style={{ ...styles.headerCell, cursor: 'pointer' }} onClick={() => handleSort(2)}>字体中文名{sortIndicator(2)}<span style={styles.resizeHandle} onMouseDown={e => onResizeStart(2, e)} /></span>
            <span style={{ ...styles.headerCell, cursor: 'pointer' }} onClick={() => handleSort(3)}>字体英文名{sortIndicator(3)}<span style={styles.resizeHandle} onMouseDown={e => onResizeStart(3, e)} /></span>
            <span style={{ ...styles.headerCell, cursor: 'pointer' }} onClick={() => handleSort(4)}>字符总数{sortIndicator(4)}<span style={styles.resizeHandle} onMouseDown={e => onResizeStart(4, e)} /></span>
            <span style={{ ...styles.headerCell, cursor: 'pointer' }} onClick={() => handleSort(5)}>版本号{sortIndicator(5)}<span style={styles.resizeHandle} onMouseDown={e => onResizeStart(5, e)} /></span>
            <span style={{ ...styles.headerCell, cursor: 'pointer' }} onClick={() => handleSort(6)}>字宽{sortIndicator(6)}<span style={styles.resizeHandle} onMouseDown={e => onResizeStart(6, e)} /></span>
            <span style={{ ...styles.headerCell, cursor: 'pointer' }} onClick={() => handleSort(7)}>发布时间{sortIndicator(7)}<span style={styles.resizeHandle} onMouseDown={e => onResizeStart(7, e)} /></span>
            <span style={{ ...styles.headerCell, cursor: 'pointer' }} onClick={() => handleSort(8)}>文件大小{sortIndicator(8)}<span style={styles.resizeHandle} onMouseDown={e => onResizeStart(8, e)} /></span>
          </div>
          <div ref={fontRowsRef} style={styles.fontRows} onScroll={handleFontRowsScroll}>
            {busy && <div style={styles.loading}><i className="ri-hourglass-fill" /> 系统数据加载中...</div>}
            {fontPreviewLoading && <div style={styles.fontLoadingHint}><i className="ri-loader-4-line" /> 正在加载字体预览 {Math.min(loadedFontCount, sortedFonts.length)} / {sortedFonts.length}</div>}
            {!busy && sortedFonts.map((font, index) => {
              const family = cssFamily(font.path);
              const selected = font.path === selectedFont?.path;
              const loaded = Boolean(fontDataUrls[font.path]);
              return (
                <button
                  key={font.path}
                  style={{ ...(selected ? styles.fontRowActive : styles.fontRow), gridTemplateColumns: gridCols, minHeight: previewRowHeight, ...(darkMode ? { background: selected ? '#333333' : '#000000', color: '#ffffff' } : {}) }}
                  onClick={() => { setLoadedFontCount(count => Math.max(count, Math.min(sortedFonts.length, index + 1))); setSelectedPath(font.path); }}
                  onContextMenu={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, font });
                  }}
                >
                  <span
                    style={{ ...styles.actions, cursor: 'pointer' }}
                    title="操作菜单"
                    onClick={e => {
                      e.stopPropagation();
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setActionMenu({ x: rect.left, y: rect.bottom, font });
                    }}
                  >
                    <i className={loaded ? 'ri-arrow-down-s-fill' : 'ri-time-line'} />
                  </span>
                  <span style={{ ...styles.quickPreview, fontFamily: loaded ? `"${family}", serif` : UI_FONT, fontSize: previewSize, minHeight: previewRowHeight, lineHeight: `${previewRowHeight}px` }}>{sampleText}</span>
                  <span style={styles.cellText}>
                    {font.infoLoaded && (
                      <span style={styles.colorTag}>{font.colorFont ? '彩' : '字'}</span>
                    )}
                    {font.name}
                  </span>
                  <span style={styles.cellText}>{font.englishName}</span>
                  <span style={styles.cellText}>{displayValue(font.characterCount)}</span>
                  <span style={styles.cellText}>{displayValue(font.version)}</span>
                  <span style={styles.cellText}>{displayValue(font.unitsPerEm)}</span>
                  <span style={styles.cellText}>{formatModified(font.modifiedMs)}</span>
                  <span style={styles.cellText}>{formatFileSize(font.sizeBytes)}</span>
                </button>
              );
            })}
            {!busy && sortedFonts.length === 0 && <div style={styles.empty}>当前字体源未发现字体文件</div>}
          </div>
        </main>

        {/* 拖拽调整筛选区宽度 */}
        <div
          style={{ ...styles.rightResizeHandle, ...(rightPaneDrag !== null ? { background: COLORS.ACCENT } : {}) }}
          onMouseDown={e => { e.preventDefault(); setRightPaneDrag(e.clientX); }}
        />

        {/* 筛选区 */}
        <aside style={{ ...styles.rightPane, width: rightPaneW }}>
          <select style={styles.fullInput} value={glyphFilter} onChange={event => setGlyphFilter(event.target.value as GlyphFilter)}>
            {(Object.keys(FILTER_LABELS) as GlyphFilter[]).map(key => (
              <option key={key} value={key}>{FILTER_LABELS[key]}</option>
            ))}
          </select>
          <div style={styles.glyphGrid}>
            {glyphCodes.map((code, index) => {
              const char = String.fromCodePoint(code);
              return (
                <button key={`${code}-${index}`} style={styles.glyphCell} title={`U+${code.toString(16).toUpperCase()}`}>
                  <span style={styles.glyphCode}>0x{code.toString(16).toUpperCase()}</span>
                  <span style={{ ...styles.glyphChar, fontFamily: `"${selectedFamily}", serif` }}>{char}</span>
                </button>
              );
            })}
            {glyphCodes.length === 0 && <div style={styles.empty}>当前筛选无匹配字符</div>}
          </div>
        </aside>
      </div>

      {/* ====== 悬浮制版器 (F8) ====== */}
      {showPlatePane && (
        <div
          style={{ ...styles.floatingPlate, left: plateRect.left, top: plateRect.top, width: plateRect.width, height: plateRect.height }}
          onClick={e => e.stopPropagation()}
        >
          <div
            style={styles.floatingTitle}
            onMouseDown={e => setPlateDrag({ x: e.clientX, y: e.clientY, left: plateRect.left, top: plateRect.top })}
          >
            <span>制版器</span>
            <button style={styles.floatingClose} title="关闭 F8" onClick={() => setShowPlatePane(false)}><i className="ri-close-line" /></button>
          </div>
          <div style={styles.plateBar}>
            <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
              <input style={{ ...styles.plateInput, width: '100%' }} value={plateText} onChange={event => setPlateText(event.target.value)} placeholder="输入预览文本..." />
              <button style={{ ...styles.plateSampleBtn, position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)' }} title="试字群组" onClick={() => setShowPreviewSamples(v => !v)}>
                <i className="ri-arrow-down-s-fill" />
              </button>
              {showPreviewSamples && (
                <div style={{ ...styles.plateSampleMenu, top: '100%', right: 0 }}>
                  {previewSamples.map((s, i) => (
                    <button key={`${i}-${s.slice(0, 10)}`} style={styles.plateSampleItem} title={s} onClick={() => { setPlateText(s); setShowPreviewSamples(false); }}>
                      {s.length > 40 ? s.slice(0, 40) + '...' : s}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <select style={styles.sizeSelect} value={plateSize} onChange={event => setPlateSize(Number(event.target.value))}>
              {[48, 64, 80, 96, 120].map(size => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
          <div style={{ ...styles.platePreview, fontFamily: `"${selectedFamily}", serif`, fontSize: Math.max(42, plateSize * 1.2) }}>{plateText || '请选择字体并输入预览文本，F8 开关制版器'}</div>
        </div>
      )}

      {/* ====== 右键菜单 ====== */}
      {contextMenu && (
        <div style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }} onClick={e => e.stopPropagation()}>
          {fontMenuItems(contextMenu.font, () => setContextMenu(null))}
        </div>
      )}

      {/* ====== 操作下拉菜单 ====== */}
      {actionMenu && (
        <div style={{ ...styles.contextMenu, left: actionMenu.x, top: actionMenu.y }} onClick={e => e.stopPropagation()}>
          {fontMenuItems(actionMenu.font, () => setActionMenu(null))}
        </div>
      )}

      {/* ====== 来源右键菜单 ====== */}
      {sourceContextMenu && (
        <div style={{ ...styles.contextMenu, left: sourceContextMenu.x, top: sourceContextMenu.y }} onClick={e => e.stopPropagation()}>
          <button style={styles.contextMenuItem} onClick={() => { void window.electronAPI.openPath(sourceContextMenu.lib.path).then(() => setSourceContextMenu(null)); }}>打开目标文件夹</button>
          <button style={styles.contextMenuItem} onClick={() => { removeLibrary(sourceContextMenu.lib); setSourceContextMenu(null); }}>删除目录</button>
        </div>
      )}
      {printSample && (() => {
        const pages = paginateCodes(printSample.codes, printSample.cols * printSample.rows);
        const pageIndex = Math.max(0, Math.min(printSample.page, pages.length - 1));
        const setPrintZoom = (delta: number) => {
          setPrintSample(prev => prev ? { ...prev, zoom: Math.max(0.35, Math.min(2.5, Number((prev.zoom + delta).toFixed(2)))) } : prev);
        };
        return (
          <div style={styles.printOverlay} onClick={e => e.stopPropagation()}>
            <div style={styles.printDock}>
              <div style={styles.printDockTitle}>
                <span>打印样本 - {printSample.font.name || fontNameFromPath(printSample.font.path)}</span>
                <button style={styles.floatingClose} onClick={() => setPrintSample(null)}><i className="ri-close-line" /></button>
              </div>
              <div style={styles.printDockToolbar}>
                <button style={styles.secondaryBtn} disabled={pageIndex <= 0} onClick={() => setPrintSample(prev => prev ? { ...prev, page: pageIndex - 1 } : prev)}>上一页</button>
                <span style={styles.printDockInfo}>第</span>
                <input
                  type="number"
                  min={1}
                  max={pages.length}
                  value={pageIndex + 1}
                  style={styles.printPageInput}
                  onChange={event => {
                    const page = Math.max(1, Math.min(pages.length, Number(event.target.value) || 1)) - 1;
                    setPrintSample(prev => prev ? { ...prev, page } : prev);
                  }}
                />
                <span style={styles.printDockInfo}>/ {pages.length} 页，字符 {printSample.codes.length}</span>
                <button style={styles.secondaryBtn} disabled={pageIndex >= pages.length - 1} onClick={() => setPrintSample(prev => prev ? { ...prev, page: pageIndex + 1 } : prev)}>下一页</button>
                <button style={styles.iconOnlyBtn} title="缩小" onClick={() => setPrintZoom(-0.1)}><i className="ri-zoom-out-line" /></button>
                <span style={styles.printDockInfo}>{Math.round(printSample.zoom * 100)}%</span>
                <button style={styles.iconOnlyBtn} title="放大" onClick={() => setPrintZoom(0.1)}><i className="ri-zoom-in-line" /></button>
                <button style={styles.secondaryBtn} onClick={() => setPrintSample(prev => prev ? { ...prev, zoom: 1 } : prev)}>100%</button>
                <span style={{ flex: 1 }} />
                <button style={styles.primaryBtn} onClick={() => window.print()}>打印</button>
              </div>
              <div
                style={styles.printPreviewArea}
                onWheel={event => {
                  if (!event.ctrlKey) return;
                  event.preventDefault();
                  setPrintZoom(event.deltaY < 0 ? 0.08 : -0.08);
                }}
              >
                <div style={{ width: 794 * printSample.zoom, height: 1123 * printSample.zoom, display: 'flex', justifyContent: 'center', fontFamily: '"ZoomlaPrintSample", serif' }}>
                  <div style={{ transform: `scale(${printSample.zoom})`, transformOrigin: 'top center' }}>
                    {renderPrintPage(printSample, pages[pageIndex], pageIndex, pages.length)}
                  </div>
                </div>
              </div>
              <div className="print-sample-print-root" style={styles.printHiddenRoot}>
                <div style={{ fontFamily: '"ZoomlaPrintSample", serif' }}>
                  {pages.map((pageCodes, index) => renderPrintPage(printSample, pageCodes, index, pages.length, true))}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

/* ====== 样式 ====== */

const styles: Record<string, React.CSSProperties> = {
  shell: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: '#dfe7f1', padding: 8, boxSizing: 'border-box', color: COLORS.TEXT, fontFamily: UI_FONT, position: 'relative' },

  // 来源切换按钮
  sourceToggle: { position: 'absolute', left: 8, bottom: 8, zIndex: 900, height: 28, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 10px', borderRadius: 14, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, boxShadow: '0 4px 14px rgba(31,53,78,.14)', fontSize: 12 },

  // 悬浮来源面板
  floatingSource: { position: 'fixed', zIndex: 2500, background: '#fff',  borderRadius: 8, boxShadow: '0 12px 38px rgba(20,36,60,.28)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  floatingTitle: { height: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px', background: '#f2f6fb', borderBottom: `1px solid ${COLORS.BORDER}`, cursor: 'move', fontSize: 13, fontWeight: 600, userSelect: 'none' },
  floatingClose: { width: 22, height: 22, border: 0, background: 'transparent', color: COLORS.TEXT_LIGHT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 },

  // 主区域
  mainArea: { flex: 1, minHeight: 0, display: 'flex', gap: 0, position: 'relative' },

  // 预览区
  centerPane: { flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', background: '#fff',  overflow: 'hidden' },

  // 右侧筛选区宽度拖拽手柄
  rightResizeHandle: { width: 5, flexShrink: 0, cursor: 'col-resize', background: 'transparent', transition: 'background .15s' },

  // 筛选区
  rightPane: { flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#fff',  overflow: 'hidden' },

  // 悬浮制版器
  floatingPlate: { position: 'fixed', zIndex: 2400, background: '#fff', border: `1px solid ${COLORS.ACCENT}`, borderRadius: 8, boxShadow: '0 18px 54px rgba(20,36,60,.32)', display: 'flex', flexDirection: 'column', overflow: 'hidden', resize: 'both' },

  // ---------- 复用组件样式 ----------
  panel: { background: '#fff', border: `1px solid ${COLORS.BORDER}`, minHeight: 0, display: 'flex', flexDirection: 'column' },
  panelTitle: { margin: 0, padding: '7px 10px', fontSize: 14, fontWeight: 600, background: '#f2f6fb', borderBottom: `1px solid ${COLORS.BORDER}` },

  // 来源列表
  sourceToolbar: { height: 34, display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderBottom: `1px solid ${COLORS.BORDER}` },
  iconBtn: { width: 28, height: 26, border: `1px solid ${COLORS.BORDER}`, background: '#fff', color: COLORS.TEXT, cursor: 'pointer' },
  sourceList: { flex: 1, minHeight: 0, overflow: 'auto', padding: 6 },
  sourceItem: { width: '100%', height: 30, display: 'grid', gridTemplateColumns: '22px 1fr auto', alignItems: 'center', gap: 4, border: 0, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', textAlign: 'left', fontFamily: UI_FONT },
  sourceActive: { width: '100%', height: 30, display: 'grid', gridTemplateColumns: '22px 1fr auto', alignItems: 'center', gap: 4, border: 0, background: COLORS.SELECT, color: COLORS.TEXT, cursor: 'pointer', textAlign: 'left', fontFamily: UI_FONT },
  sourceName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sourceCount: { color: COLORS.TEXT_LIGHT, fontSize: 12 },

  // 字体来源下拉
  sourceDropdownWrap: { position: 'relative', display: 'inline-flex' },
  sourceDropdownBtn: { minWidth: 100, maxWidth: 180, height: 30, display: 'inline-flex', alignItems: 'center', gap: 2, padding: '0 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  sourceDropdown: { position: 'fixed', zIndex: 2600, width: 260, maxHeight: 360, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, boxShadow: '0 10px 34px rgba(20,36,60,.26)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  sourceDropdownList: { flex: 1, minHeight: 0, overflow: 'auto', padding: 4 },
  sourceDropdownItem: { width: '100%', height: 32, display: 'grid', gridTemplateColumns: '18px 22px 1fr auto', alignItems: 'center', gap: 4, padding: '0 6px', border: 0, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', textAlign: 'left', fontFamily: UI_FONT, fontSize: 13 },
  sourceDropdownActive: { width: '100%', height: 32, display: 'grid', gridTemplateColumns: '18px 22px 1fr auto', alignItems: 'center', gap: 4, padding: '0 6px', border: 0, background: COLORS.SELECT, color: COLORS.TEXT, cursor: 'pointer', textAlign: 'left', fontFamily: UI_FONT, fontSize: 13 },
  sourceDropdownName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sourceDropdownCount: { color: COLORS.TEXT_LIGHT, fontSize: 11 },
  sourceDropdownEmpty: { padding: '14px 10px', color: COLORS.TEXT_LIGHT, fontSize: 12, textAlign: 'center' },
  sourceDropdownAdd: { width: '100%', height: 34, border: 0, borderTop: `1px solid ${COLORS.BORDER}`, background: '#f8fbff', color: COLORS.ACCENT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, flexShrink: 0 },

  // 搜索栏
  listHeader: { minHeight: 42, display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderBottom: `1px solid ${COLORS.BORDER}`, background: '#f8fbff', flexShrink: 0 },
  sampleInput: { width: 240, padding: '6px 8px', border: `1px solid ${COLORS.BORDER}`, fontFamily: UI_FONT },
  sizeSelect: { height: 30, border: `1px solid ${COLORS.BORDER}`, background: '#fff' },
  toolbarIconBtn: { width: 30, height: 30, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 },
  searchInput: { fontSize: 12, width: 140, padding: '6px 8px 6px 28px', border: `1px solid ${COLORS.BORDER}`, fontFamily: UI_FONT, background: '#fff' },
  searchWrap: { marginLeft: 'auto', position: 'relative', display: 'inline-flex', alignItems: 'center' },
  searchIcon: { position: 'absolute', left: 8, color: COLORS.TEXT_LIGHT, fontSize: 14, pointerEvents: 'none' },

  // 表头
  tableHead: { display: 'grid', height: 28, alignItems: 'center', borderBottom: `1px solid ${COLORS.BORDER}`, background: '#f3f6fa', color: COLORS.TEXT_LIGHT, fontSize: 12, userSelect: 'none', flexShrink: 0, width: 'max-content', minWidth: '100%' },
  headerCell: { position: 'relative', display: 'inline-flex', alignItems: 'center', height: '100%', padding: '0 4px' },
  resizeHandle: { position: 'absolute', right: -3, top: 0, bottom: 0, width: 10, cursor: 'col-resize', zIndex: 2, borderRight: '2px solid rgba(96,113,132,.35)' },

  // 字体行
  fontRows: { flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' },
  fontLoadingHint: { position: 'sticky', top: 0, zIndex: 3, height: 30, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', background: 'rgba(255,255,255,.92)', borderBottom: `1px solid ${COLORS.BORDER}`, color: COLORS.TEXT_LIGHT, fontSize: 12 },
  fontRow: { width: 'max-content', minWidth: '100%', minHeight: 72, display: 'grid', alignItems: 'center', border: 0, borderBottom: '1px solid #eef2f6', background: '#fff', color: COLORS.TEXT, cursor: 'pointer', textAlign: 'left' },
  fontRowActive: { width: 'max-content', minWidth: '100%', minHeight: 72, display: 'grid', alignItems: 'center', border: 0, borderBottom: '1px solid #d5e7fb', background: '#b9dcfb', color: COLORS.TEXT, cursor: 'pointer', textAlign: 'left' },
  actions: { textAlign: 'center', color: COLORS.TEXT_LIGHT },
  quickPreview: { overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: 1.1 },
  cellText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8, fontSize: 13 },
  colorTag: { display: 'inline-block', width: 18, height: 18, marginLeft: 6, marginRight: 2, background: '#000', color: '#fff', textAlign: 'center', lineHeight: '18px', fontSize: 11, borderRadius: 2, verticalAlign: 'middle', flexShrink: 0 },
  loading: { padding: 18, color: COLORS.TEXT_LIGHT },
  empty: { padding: 18, color: COLORS.TEXT_LIGHT },

  // 筛选区
  fullInput: { margin: 8, padding: '7px 8px', border: `1px solid ${COLORS.BORDER}`, fontFamily: UI_FONT, flexShrink: 0 },
  glyphGrid: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexWrap: 'wrap', alignContent: 'start', padding: 8, gap: 4 },
  glyphCell: { minWidth: 64, height: 72, border: `1px solid ${COLORS.BORDER}`, background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: '0 0 auto' },
  glyphCode: { fontSize: 10, color: COLORS.TEXT_LIGHT },
  glyphChar: { fontSize: 28, lineHeight: 1.2 },

  // 右键/下拉菜单
  contextMenu: { position: 'fixed', zIndex: 3000, minWidth: 140, padding: 5, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 5, boxShadow: '0 8px 24px rgba(0,0,0,.2)', display: 'flex', flexDirection: 'column' },
  contextMenuItem: { padding: '8px 10px', border: 0, background: '#fff', color: COLORS.TEXT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT },
  contextMenuItemDisabled: { padding: '8px 10px', border: 0, background: '#f5f6f7', color: COLORS.TEXT_LIGHT, textAlign: 'left', cursor: 'default', fontFamily: UI_FONT },

  // 打印样本
  printOverlay: { position: 'fixed', inset: 0, zIndex: 3600, background: 'rgba(18,28,40,.42)', display: 'flex', alignItems: 'stretch', justifyContent: 'center', padding: 18 },
  printDock: { width: 'min(1180px, 96vw)', height: 'calc(100vh - 36px)', background: '#f4f6f8', borderRadius: 8, boxShadow: '0 20px 70px rgba(0,0,0,.32)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  printDockTitle: { height: 38, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', background: '#fff', borderBottom: `1px solid ${COLORS.BORDER}`, fontWeight: 600 },
  printDockToolbar: { height: 42, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', background: '#f8fbff', borderBottom: `1px solid ${COLORS.BORDER}` },
  printDockInfo: { color: COLORS.TEXT_LIGHT, fontSize: 13 },
  printPreviewArea: { flex: 1, minHeight: 0, overflow: 'auto', padding: 18, display: 'flex', justifyContent: 'center' },
  printPageInput: { width: 58, height: 28, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, padding: '0 6px', fontFamily: UI_FONT, textAlign: 'center' },
  printHiddenRoot: { position: 'fixed', left: -100000, top: 0, width: 0, height: 0, overflow: 'hidden' },
  printPage: { position: 'relative', width: 794, height: 1123, background: '#fff', padding: '38px 42px 34px', boxShadow: '0 4px 22px rgba(0,0,0,.16)', display: 'flex', flexDirection: 'column', color: '#111' },
  printTopline: { height: 22, borderBottom: '2px solid #111', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', fontSize: 13, fontFamily: PRINT_UI_FONT },
  printTitle: { margin: '10px 0 10px', textAlign: 'center', fontSize: 28, fontWeight: 500, letterSpacing: 0, fontFamily: PRINT_UI_FONT },
  printMain: { flex: 1, minHeight: 0, overflow: 'hidden' },
  printBlockTitle: { height: 22, lineHeight: '22px', background: '#d9d9d9', border: '1px solid #111', borderBottom: 0, padding: '0 5px', fontSize: 13, fontWeight: 600, fontFamily: PRINT_UI_FONT },
  printGrid: { display: 'grid', borderLeft: '1px solid #111', borderTop: '1px solid #111' },
  printCell: { borderRight: '1px solid #111', borderBottom: '1px solid #111', position: 'relative', overflow: 'hidden', background: '#fff' },
  printUni: { position: 'absolute', left: 3, top: 2, fontSize: 9, lineHeight: 1, color: '#444', fontFamily: PRINT_UI_FONT },
  printGlyph: { textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', fontFamily: '"ZoomlaPrintSample", serif' },
  printFooter: { height: 24, borderTop: '2px solid #111', marginTop: 10, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', fontSize: 13, fontFamily: PRINT_UI_FONT },
  printPageMeta: { position: 'absolute', right: 10, top: 10, color: COLORS.TEXT_LIGHT, fontSize: 12, fontFamily: PRINT_UI_FONT },
  secondaryBtn: { height: 28, padding: '0 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT },
  iconOnlyBtn: { width: 30, height: 28, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 },
  primaryBtn: { height: 30, padding: '0 14px', border: `1px solid ${COLORS.ACCENT}`, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', fontFamily: UI_FONT },

  // 制版器
  plateSampleBtn: { width: 22, height: 22, border: 0, background: 'transparent', color: COLORS.TEXT_LIGHT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 },
  plateSampleMenu: { position: 'absolute', top: 24, right: 0, zIndex: 10, minWidth: 220, maxHeight: 200, overflow: 'auto', padding: 4, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, boxShadow: '0 6px 20px rgba(0,0,0,.16)', display: 'flex', flexDirection: 'column' },
  plateSampleItem: { padding: '6px 8px', border: 0, background: '#fff', color: COLORS.TEXT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  plateBar: { height: 36, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', borderBottom: `1px solid ${COLORS.BORDER}`, background: '#f8fbff', flexShrink: 0 },
  plateInput: { flex: 1, minWidth: 0, padding: '5px 8px', border: `1px solid ${COLORS.BORDER}`, fontFamily: UI_FONT, fontSize: 13 },
  platePreview: { flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 24px', whiteSpace: 'pre-wrap', lineHeight: 1.4 },
};

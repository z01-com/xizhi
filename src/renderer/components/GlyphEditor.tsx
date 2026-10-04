import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Ellipse, Group, Layer, Line, Path, Rect, Stage, Text } from 'react-konva';
import { COLORS, UI_FONT } from '@shared/constants';
import { DEFAULT_PREVIEW_SAMPLES, parseSmallJsonSetting } from './SettingsDialog';
import { WikiTips } from './WikiTips';

type Tool = 'select' | 'brush' | 'eraser' | 'bigBrush';
type Mode = 'block' | 'edit';
type ShapeKind = 'square' | 'circle' | 'polygon';
type TransformHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Point = { x: number; y: number; on?: boolean };
type Contour = Point[];
type BBox = { minX: number; minY: number; maxX: number; maxY: number };
type GlyphClipboardPayload = { contours: Contour[]; contourColors: string[] };

const GLYPH_CLIPBOARD_MIME = 'application/x-zoomla-xizhi-glyph';
let sharedGlyphClipboard: GlyphClipboardPayload | null = null;

interface GlyphEditorProps {
  code: number;
  codes: number[];
  initialGlyph?: { advance?: number; sourceAdvance?: number; sourceLsb?: number; advanceModified?: boolean; glyphName?: string; contours?: Contour[]; contourColors?: string[]; sourceBounds?: { xMin?: number; yMin?: number; xMax?: number; yMax?: number } };
  metrics: { upm: number; ascent: number; descent: number };
  family: string;
  refFont?: string;
  refFontMode?: string;
  onClose: (options?: { skipAutoSave?: boolean }) => void;
  onSave: (code: number, data: any) => boolean | Promise<boolean>;
  onChangeCode?: (nextCode: number, data: any) => boolean | Promise<boolean>;
  onExport: (code: number, data: any) => void | Promise<void>;
  onNavigate: (delta: number, currentData: any) => void | Promise<void>;
  onJump: (code: number, currentData: any) => void | Promise<void>;
  onChange: (data: any) => void;
  usedGlyphNames?: string[];
  previewFontFace?: string;
  tabsSlot?: React.ReactNode;
  floatingCompact?: boolean;
}

const CANVAS_W = 1160;
const CANVAS_H = 780;
const SIDE_W = 230;
const SIDE_COLLAPSED_W = 34;
const HIT = 10;
const DOCK_W = 188;
const DOCK_H = 172;
const COLOR_DOCK_W = 188;
const COLOR_DOCK_H = 186;
type DockPercent = { xPct: number; yPct: number };

function parseCode(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  if (text.toUpperCase().startsWith('U+')) return parseInt(text.slice(2), 16);
  if (text.toLowerCase().startsWith('0x')) return parseInt(text.slice(2), 16);
  if (/^[0-9a-fA-F]{4,6}$/.test(text)) return parseInt(text, 16);
  return text.codePointAt(0) ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dockPercentToPx(pos: DockPercent, width: number, height: number, dockW: number, dockH: number): { x: number; y: number } {
  const minX = 8;
  const minY = 8;
  const maxX = Math.max(minX, width - dockW - 8);
  const maxY = Math.max(minY, height - dockH - 8);
  return {
    x: Math.round(minX + clamp(pos.xPct, 0, 1) * (maxX - minX)),
    y: Math.round(minY + clamp(pos.yPct, 0, 1) * (maxY - minY)),
  };
}

function dockPxToPercent(x: number, y: number, width: number, height: number, dockW: number, dockH: number): DockPercent {
  const minX = 8;
  const minY = 8;
  const maxX = Math.max(minX, width - dockW - 8);
  const maxY = Math.max(minY, height - dockH - 8);
  return {
    xPct: maxX === minX ? 0 : clamp((x - minX) / (maxX - minX), 0, 1),
    yPct: maxY === minY ? 0 : clamp((y - minY) / (maxY - minY), 0, 1),
  };
}

function midpoint(a: Point, b: Point): Point {
  return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), on: true };
}

function serializeEditorData(advance: number, contours: Contour[], contourColors: string[]): string {
  return JSON.stringify({
    advance,
    contours: contours.map(contour => contour.map(point => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
      on: point.on !== false,
    }))),
    contourColors: contours.map((_contour, index) => contourColors[index] || '#111111'),
  });
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

function clampZoom(value: number): number {
  return Math.max(0.3, Math.min(4, value));
}

function contourArea(contour: Contour = []): number {
  return contour.reduce((sum, point, index) => {
    const next = contour[(index + 1) % contour.length];
    return sum + (Number(point.x) || 0) * (Number(next?.y) || 0) - (Number(next?.x) || 0) * (Number(point.y) || 0);
  }, 0) / 2;
}

function contourCenter(contour: Contour = []): Point {
  const count = Math.max(1, contour.length);
  return {
    x: contour.reduce((sum, point) => sum + (Number(point.x) || 0), 0) / count,
    y: contour.reduce((sum, point) => sum + (Number(point.y) || 0), 0) / count,
    on: true,
  };
}

function pointInContour(point: Point, contour: Contour = []): boolean {
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

function effectiveContourColors(contours: Contour[], contourColors: string[]): string[] {
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
    if (parentIndex >= 0 && areas[index] * areas[parentIndex] < 0 && (!contourColors[index] || contourColors[index] === '#111111')) {
      return contourColors[parentIndex] || '#111111';
    }
    return contourColors[index] || '#111111';
  });
}

function circleContour(cx: number, cy: number, radius: number, segments = 24): Contour {
  return Array.from({ length: segments }).map((_value, index) => {
    const angle = index * Math.PI * 2 / segments;
    return {
      x: Math.round(cx + Math.cos(angle) * radius),
      y: Math.round(cy + Math.sin(angle) * radius),
      on: true,
    };
  });
}

function isEraseColor(color?: string): boolean {
  const normalized = (color || '').trim().toLowerCase();
  return normalized === '#fff' || normalized === '#ffffff' || normalized === 'white' || normalized === 'rgb(255,255,255)' || normalized === 'rgb(255, 255, 255)';
}

function previewResizeHandleStyle(edge: string): React.CSSProperties {
  const base: React.CSSProperties = { position: 'absolute' };
  if (edge.includes('n')) base.top = -4;
  if (edge.includes('s')) base.bottom = -4;
  if (edge.includes('w')) base.left = -4;
  if (edge.includes('e')) base.right = -4;
  if (edge === 'n' || edge === 's') {
    base.left = 10;
    base.right = 10;
    base.height = 8;
    base.cursor = 'ns-resize';
  } else if (edge === 'e' || edge === 'w') {
    base.top = 10;
    base.bottom = 10;
    base.width = 8;
    base.cursor = 'ew-resize';
  } else {
    base.width = 12;
    base.height = 12;
    base.cursor = edge === 'ne' || edge === 'sw' ? 'nesw-resize' : 'nwse-resize';
  }
  return base;
}

export const GlyphEditor: React.FC<GlyphEditorProps> = ({ code, codes, initialGlyph, metrics, family, refFont, refFontMode, onClose, onSave, onChangeCode, onExport, onNavigate, onJump, onChange, usedGlyphNames = [], previewFontFace, tabsSlot, floatingCompact = false }) => {
  const [contours, setContours] = useState<Contour[]>([]);
  const [contourColors, setContourColors] = useState<string[]>([]);
  const [advance, setAdvance] = useState(metrics.upm || 1024);
  const [sourceAdvance, setSourceAdvance] = useState(metrics.upm || 1024);
  const [sourceLsb, setSourceLsb] = useState(0);
  const [advanceModified, setAdvanceModified] = useState(false);
  const [advanceDraft, setAdvanceDraft] = useState(String(metrics.upm || 1024));
  const [leftBearingDraft, setLeftBearingDraft] = useState('0');
  const [rightBearingDraft, setRightBearingDraft] = useState('0');
  const [codeDraft, setCodeDraft] = useState('');
  const [glyphName, setGlyphName] = useState('');
  const [glyphNameDraft, setGlyphNameDraft] = useState('');
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [mode, setMode] = useState<Mode>('block');
  const [zoom, setZoom] = useState(1);
  const [showFill, setShowFill] = useState(true);
  const [showRulers, setShowRulers] = useState(true);
  const [guideLocked, setGuideLocked] = useState(false);
  const [selected, setSelected] = useState<Array<[number, number]>>([]);
  const [selectedContour, setSelectedContour] = useState<number | null>(null);
  const [selectedContours, setSelectedContours] = useState<number[]>([]);
  const [dragPoint, setDragPoint] = useState<[number, number] | null>(null);
  const [dragSelectionStart, setDragSelectionStart] = useState<{ x: number; y: number; contours: Contour[] } | null>(null);
  const [dragGlyphStart, setDragGlyphStart] = useState<{ x: number; y: number; contours: Contour[]; contourIndexes: number[]; action: 'move' | 'scale'; handle?: TransformHandle; bbox: BBox } | null>(null);
  const [selectBox, setSelectBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [brushContour, setBrushContour] = useState<Contour | null>(null);
  const [bigBrushSize, setBigBrushSize] = useState(92);
  const [bigBrushPath, setBigBrushPath] = useState<Contour | null>(null);
  const [undo, setUndo] = useState<string[]>([]);
  const [redo, setRedo] = useState<string[]>([]);
  const [jumpText, setJumpText] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; hit: [number, number] | null; segment: [number, number] | null; contourIndex: number | null; fontPoint: Point } | null>(null);
  const [guides, setGuides] = useState<{ vertical: number[]; horizontal: number[] }>({ vertical: [], horizontal: [] });
  const [guideDraft, setGuideDraft] = useState<{ axis: 'vertical' | 'horizontal'; canvasValue: number } | null>(null);
  const [guideDrag, setGuideDrag] = useState<{ axis: 'vertical' | 'horizontal'; index: number } | null>(null);
  const [hoverGuide, setHoverGuide] = useState<{ axis: 'vertical' | 'horizontal'; canvasValue: number } | null>(null);
  const [dockPos, setDockPos] = useState<DockPercent>({ xPct: 0.5, yPct: 0.12 });
  const [dockDrag, setDockDrag] = useState<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const [colorDockPos, setColorDockPos] = useState<DockPercent>({ xPct: 0.66, yPct: 0.12 });
  const [colorDockDrag, setColorDockDrag] = useState<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const [pendingShape, setPendingShape] = useState<{ kind: ShapeKind; sides: number } | null>(null);
  const [shapeDraft, setShapeDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [showPolygonSides, setShowPolygonSides] = useState(false);
  const [showColorDock, setShowColorDock] = useState(false);
  const [paintMode, setPaintMode] = useState(false);
  const [activeColor, setActiveColor] = useState('#111111');
  const [showPreviewDock, setShowPreviewDock] = useState(false);
  const [previewText, setPreviewText] = useState('汉字之美，逐浪而来！你好我爱中国123abc\n和平与共');
  const [previewSize, setPreviewSize] = useState(96);
  const [previewRect, setPreviewRect] = useState({ left: 10, top: 0, width: 920, height: 250 });
  const [previewDrag, setPreviewDrag] = useState<{ x: number; y: number; rect: typeof previewRect } | null>(null);
  const [previewResize, setPreviewResize] = useState<{ edge: string; x: number; y: number; rect: typeof previewRect } | null>(null);
  const [previewSamples, setPreviewSamples] = useState<string[]>(DEFAULT_PREVIEW_SAMPLES);
  const [showPreviewSamples, setShowPreviewSamples] = useState(false);
  const [findTip, setFindTip] = useState('');
  const [propertyTip, setPropertyTip] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [externalPasteBusy, setExternalPasteBusy] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const [closeDialog, setCloseDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasGlyphClipboard, setHasGlyphClipboard] = useState(false);
  const stageRef = useRef<any>(null);
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const editorStateReady = useRef(false);
  const suppressInitialChange = useRef(true);
  const savedDataRef = useRef('');
  const [stageSize, setStageSize] = useState({ width: CANVAS_W, height: CANVAS_H });

  useEffect(() => {
    setHasGlyphClipboard(Boolean(sharedGlyphClipboard?.contours.length));
    const update = () => setHasGlyphClipboard(Boolean(sharedGlyphClipboard?.contours.length));
    window.addEventListener('zoomla-glyph-clipboard', update);
    return () => window.removeEventListener('zoomla-glyph-clipboard', update);
  }, []);

  useEffect(() => {
    setHasGlyphClipboard(Boolean(sharedGlyphClipboard?.contours.length));
  }, []);

  useEffect(() => {
    suppressInitialChange.current = true;
    const rawAdvance = Number(initialGlyph?.advance);
    const nextAdvance = Number.isFinite(rawAdvance) && rawAdvance >= 0 ? rawAdvance : metrics.upm || 1024;
    const nextSourceAdvance = Number.isFinite(Number(initialGlyph?.sourceAdvance)) ? Number(initialGlyph?.sourceAdvance) : nextAdvance;
    const nextSourceLsb = Number.isFinite(Number(initialGlyph?.sourceLsb)) ? Number(initialGlyph?.sourceLsb) : 0;
    const nextContours = Array.isArray(initialGlyph?.contours)
      ? initialGlyph.contours.map(c => c.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0, on: p.on !== false })))
      : [];
    const nextColors = nextContours.map((_contour, index) => initialGlyph?.contourColors?.[index] || '#111111');
    setAdvance(nextAdvance);
    setAdvanceDraft(String(nextAdvance));
    setSourceAdvance(nextSourceAdvance);
    setSourceLsb(nextSourceLsb);
    setAdvanceModified(Boolean(initialGlyph?.advanceModified));
    setCodeDraft(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    const nextName = normalizeGlyphName(initialGlyph?.glyphName || '') || defaultGlyphName(code);
    setGlyphName(nextName);
    setGlyphNameDraft(nextName);
    setContours(nextContours);
    setContourColors(nextColors);
    savedDataRef.current = JSON.stringify({
      advance: nextAdvance,
      sourceAdvance: nextSourceAdvance,
      sourceLsb: nextSourceLsb,
      advanceModified: Boolean(initialGlyph?.advanceModified),
      glyphName: nextName,
      contours: nextContours,
      contourColors: nextColors,
      sourceBounds: initialGlyph?.sourceBounds,
    });
    setSelected([]); setSelectedContour(null); setSelectedContours([]); setMode('block'); setUndo([]); setRedo([]); setBrushContour(null); setBigBrushPath(null); setSelectBox(null); setMenu(null); setPendingShape(null); setShapeDraft(null); setShowPolygonSides(false); setPaintMode(false); setSaveDialog(false); setCloseDialog(false);
  }, [code, initialGlyph, metrics.upm]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      window.electronAPI.getEditorState('glyphEditor.dockPosition', ''),
      window.electronAPI.getEditorState('glyphEditor.colorDockState', ''),
      window.electronAPI.getEditorState('glyphEditor.guides', ''),
      window.electronAPI.getEditorState('glyphEditor.previewDockState', ''),
      window.electronAPI.getEditorState('glyphEditor.leftBarCollapsed', 'false'),
    ]).then(([dockRaw, colorDockRaw, guidesRaw, previewRaw, leftBarRaw]) => {
      if (!alive) return;
      setSideCollapsed(leftBarRaw === 'true');
      try {
        const parsed = JSON.parse(dockRaw || '{}');
        if (Number.isFinite(parsed.xPct) && Number.isFinite(parsed.yPct)) {
          setDockPos({ xPct: clamp(parsed.xPct, 0, 1), yPct: clamp(parsed.yPct, 0, 1) });
        } else if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          setDockPos(dockPxToPercent(parsed.x, parsed.y, window.innerWidth, window.innerHeight, DOCK_W, DOCK_H));
        }
      } catch {}
      try {
        const parsed = JSON.parse(colorDockRaw || '{}');
        if (typeof parsed.open === 'boolean') setShowColorDock(parsed.open);
        if (Number.isFinite(parsed.xPct) && Number.isFinite(parsed.yPct)) {
          setColorDockPos({ xPct: clamp(parsed.xPct, 0, 1), yPct: clamp(parsed.yPct, 0, 1) });
        } else if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          setColorDockPos(dockPxToPercent(parsed.x, parsed.y, window.innerWidth, window.innerHeight, COLOR_DOCK_W, COLOR_DOCK_H));
        }
      } catch {}
      try {
        const parsed = JSON.parse(guidesRaw || '{}');
        if (Array.isArray(parsed.vertical) && Array.isArray(parsed.horizontal)) {
          setGuides({
            vertical: parsed.vertical.filter(Number.isFinite),
            horizontal: parsed.horizontal.filter(Number.isFinite),
          });
        }
      } catch {}
      try {
        const parsed = JSON.parse(previewRaw || '{}');
        if (typeof parsed.open === 'boolean') setShowPreviewDock(parsed.open);
        if (typeof parsed.text === 'string') setPreviewText(parsed.text);
        if (Number.isFinite(parsed.size)) setPreviewSize(clamp(Number(parsed.size), 16, 240));
        if ([parsed.left, parsed.top, parsed.width, parsed.height].every(Number.isFinite)) {
          setPreviewRect({ left: parsed.left, top: parsed.top, width: parsed.width, height: parsed.height });
        }
      } catch {}
      editorStateReady.current = true;
    }).catch(() => { editorStateReady.current = true; });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    window.electronAPI.dbGetSetting('previewSamples', JSON.stringify(DEFAULT_PREVIEW_SAMPLES)).then(raw => {
      if (!alive) return;
      const parsed = parseSmallJsonSetting<unknown>(raw || '[]', []);
      if (Array.isArray(parsed) && parsed.length) {
        setPreviewSamples(parsed.map(item => String(item || '').slice(0, 500)).filter(Boolean).slice(0, 20));
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setAdvanceDraft(String(advance));
  }, [advance]);

  useEffect(() => {
    if (!editorStateReady.current) return;
    const timer = window.setTimeout(() => {
      window.electronAPI.setEditorState('glyphEditor.dockPosition', JSON.stringify(dockPos));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [dockPos]);

  useEffect(() => {
    if (!editorStateReady.current) return;
    const timer = window.setTimeout(() => {
      window.electronAPI.setEditorState('glyphEditor.colorDockState', JSON.stringify({ open: showColorDock, ...colorDockPos }));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [showColorDock, colorDockPos]);

  useEffect(() => {
    if (!editorStateReady.current) return;
    const timer = window.setTimeout(() => {
      window.electronAPI.setEditorState('glyphEditor.guides', JSON.stringify(guides));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [guides]);

  useEffect(() => {
    if (!editorStateReady.current) return;
    const timer = window.setTimeout(() => {
      window.electronAPI.setEditorState('glyphEditor.previewDockState', JSON.stringify({
        open: showPreviewDock,
        text: previewText,
        size: previewSize,
        ...previewRect,
      }));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [previewRect, previewSize, previewText, showPreviewDock]);

  const clampPreviewRect = useCallback((rect: typeof previewRect, width = workspaceRef.current?.clientWidth || CANVAS_W, height = workspaceRef.current?.clientHeight || CANVAS_H) => {
    const minW = 520;
    const minH = 160;
    const nextWidth = clamp(rect.width, minW, Math.max(minW, width - 20));
    const nextHeight = clamp(rect.height, minH, Math.max(minH, height - 20));
    return {
      left: clamp(rect.left, 8, Math.max(8, width - nextWidth - 8)),
      top: clamp(rect.top || height - nextHeight - 8, 8, Math.max(8, height - nextHeight - 8)),
      width: nextWidth,
      height: nextHeight,
    };
  }, []);

  useEffect(() => {
    const update = () => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (rect) {
        setStageSize({ width: Math.max(640, Math.floor(rect.width - SIDE_W)), height: Math.max(420, Math.floor(rect.height)) });
        setPreviewRect(prev => clampPreviewRect(prev, Math.floor(rect.width), Math.floor(rect.height)));
      }
    };
    update();
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (workspaceRef.current && observer) observer.observe(workspaceRef.current);
    return () => { window.removeEventListener('resize', update); observer?.disconnect(); };
  }, [clampPreviewRect]);

  useEffect(() => {
    if (!showPreviewDock) return;
    const width = workspaceRef.current?.clientWidth || stageSize.width + SIDE_W;
    const height = workspaceRef.current?.clientHeight || stageSize.height;
    setPreviewRect(prev => clampPreviewRect(prev.top ? prev : { ...prev, top: height - prev.height - 8 }, width, height));
  }, [clampPreviewRect, showPreviewDock, stageSize.height, stageSize.width]);

  useEffect(() => {
    if (!previewDrag && !previewResize) return;
    const move = (event: MouseEvent) => {
      const width = workspaceRef.current?.clientWidth || stageSize.width + SIDE_W;
      const height = workspaceRef.current?.clientHeight || stageSize.height;
      if (previewDrag) {
        setPreviewRect(clampPreviewRect({
          ...previewDrag.rect,
          left: previewDrag.rect.left + event.clientX - previewDrag.x,
          top: previewDrag.rect.top + event.clientY - previewDrag.y,
        }, width, height));
      } else if (previewResize) {
        const dx = event.clientX - previewResize.x;
        const dy = event.clientY - previewResize.y;
        let { left, top, width: rectW, height: rectH } = previewResize.rect;
        if (previewResize.edge.includes('e')) rectW += dx;
        if (previewResize.edge.includes('s')) rectH += dy;
        if (previewResize.edge.includes('w')) { left += dx; rectW -= dx; }
        if (previewResize.edge.includes('n')) { top += dy; rectH -= dy; }
        setPreviewRect(clampPreviewRect({ left, top, width: rectW, height: rectH }, width, height));
      }
    };
    const up = () => {
      setPreviewDrag(null);
      setPreviewResize(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [clampPreviewRect, previewDrag, previewResize, stageSize.height, stageSize.width]);

  const glyphChar = useMemo(() => String.fromCodePoint(code), [code]);
  const title = `字形设计 - U+${code.toString(16).toUpperCase().padStart(4, '0')} ${glyphChar} ${family ? `｜${family}` : ''}`;
  const top = metrics.ascent || 880;
  const bottom = metrics.descent || -144;
  const upm = metrics.upm || 1024;
  const fontHeight = Math.max(1, top - bottom);
  const stageW = stageSize.width;
  const stageH = stageSize.height;
  const leftBarWidth = floatingCompact ? 0 : (sideCollapsed ? SIDE_COLLAPSED_W : SIDE_W);
  const workspaceW = stageW + leftBarWidth;
  const workspaceH = stageH;
  const dockPx = useMemo(() => dockPercentToPx(dockPos, workspaceW, workspaceH, DOCK_W, DOCK_H), [dockPos, workspaceW, workspaceH]);
  const colorDockPx = useMemo(() => dockPercentToPx(colorDockPos, workspaceW, workspaceH, COLOR_DOCK_W, COLOR_DOCK_H), [colorDockPos, workspaceW, workspaceH]);
  const baseScale = Math.min((stageW - 120) / Math.max(upm, advance), (stageH - 120) / fontHeight);
  const scale = baseScale * zoom;
  const ox = (stageW - advance * scale) / 2;
  const oy = (stageH - fontHeight * scale) / 2;
  const contourBounds = useMemo(() => {
    const points = contours.flat();
    if (!points.length) return null;
    return points.reduce((box, point) => ({
      minX: Math.min(box.minX, point.x),
      maxX: Math.max(box.maxX, point.x),
    }), { minX: points[0].x, maxX: points[0].x });
  }, [contours]);
  const leftSideBearing = contourBounds ? Math.round(contourBounds.minX) : 0;
  const rightSideBearing = contourBounds ? Math.round(advance - contourBounds.maxX) : Math.round(advance);
  useEffect(() => {
    setLeftBearingDraft(String(leftSideBearing));
    setRightBearingDraft(String(rightSideBearing));
  }, [leftSideBearing, rightSideBearing]);

  const data = useMemo(() => ({ advance, sourceAdvance, sourceLsb, advanceModified, glyphName, contours, contourColors, sourceBounds: initialGlyph?.sourceBounds }), [advance, sourceAdvance, sourceLsb, advanceModified, glyphName, contours, contourColors, initialGlyph?.sourceBounds]);
  const hasChanges = useMemo(() => JSON.stringify(data) !== savedDataRef.current, [data]);
  const commitAdvanceDraft = useCallback(() => {
    const value = Number(advanceDraft);
    if (Number.isFinite(value) && value >= 0) {
      const next = Math.round(value);
      setAdvance(next);
      setAdvanceDraft(String(next));
      setAdvanceModified(true);
    } else {
      setAdvanceDraft(String(advance));
    }
  }, [advance, advanceDraft]);
  const shiftAllContours = useCallback((dx: number) => {
    if (!Number.isFinite(dx) || Math.abs(dx) < 1 || !contours.length) return;
    setContours(prev => prev.map(contour => contour.map(point => ({ ...point, x: Math.round(point.x + dx) }))));
  }, [contours.length]);
  const commitLeftBearingDraft = useCallback(() => {
    if (!contourBounds) {
      setLeftBearingDraft('0');
      return;
    }
    const value = Number(leftBearingDraft);
    if (!Number.isFinite(value)) {
      setLeftBearingDraft(String(leftSideBearing));
      return;
    }
    const next = Math.round(value);
    shiftAllContours(next - leftSideBearing);
  }, [contourBounds, leftBearingDraft, leftSideBearing, shiftAllContours]);
  const commitRightBearingDraft = useCallback(() => {
    if (!contourBounds) {
      setRightBearingDraft(String(Math.round(advance)));
      return;
    }
    const value = Number(rightBearingDraft);
    if (!Number.isFinite(value)) {
      setRightBearingDraft(String(rightSideBearing));
      return;
    }
    const next = Math.round(value);
    shiftAllContours(rightSideBearing - next);
  }, [advance, contourBounds, rightBearingDraft, rightSideBearing, shiftAllContours]);
  const commitCodeDraft = useCallback(async () => {
    const nextCode = parseCode(codeDraft);
    if (nextCode == null || !Number.isFinite(nextCode) || nextCode < 0 || nextCode > 0x10FFFF) {
      setCodeDraft('');
      return;
    }
    if (nextCode === code) {
      setCodeDraft(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
      return;
    }
    if (codes.includes(nextCode)) {
      setCodeDraft('');
      setPropertyTip('字码点不可重复');
      window.setTimeout(() => setPropertyTip(''), 1600);
      return;
    }
    const success = await onChangeCode?.(nextCode, data);
    if (!success) {
      setCodeDraft(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }, [code, codeDraft, codes, data, onChangeCode]);
  const commitGlyphNameDraft = useCallback(() => {
    const current = normalizeGlyphName(glyphName);
    const used = usedGlyphNames.filter(name => name !== current);
    const next = uniqueGlyphName(glyphNameDraft, used);
    if (next !== glyphName) {
      setGlyphName(next);
    }
    setGlyphNameDraft(next);
  }, [glyphName, glyphNameDraft, usedGlyphNames]);
  useEffect(() => {
    if (suppressInitialChange.current) {
      suppressInitialChange.current = false;
      return;
    }
    onChange(data);
  }, [data, onChange]);
  const historyState = useCallback(() => JSON.stringify({ contours, advance, contourColors, glyphName }), [contours, advance, contourColors, glyphName]);
  const applyHistoryState = useCallback((raw: string) => {
    const parsed = JSON.parse(raw);
    setContours(parsed.contours || []);
    setAdvance(parsed.advance);
    setContourColors(parsed.contourColors || (parsed.contours || []).map(() => '#111111'));
    if (typeof parsed.glyphName === 'string') {
      setGlyphName(parsed.glyphName);
      setGlyphNameDraft(parsed.glyphName);
    }
    setSelected([]);
    setSelectedContour(null);
    setSelectedContours([]);
  }, []);
  const snapshot = useCallback(() => {
    setUndo(prev => [...prev.slice(-9), historyState()]);
    setRedo([]);
  }, [historyState]);
  const cloneContours = (src: Contour[]) => src.map(c => c.map(p => ({ ...p })));
  const clipboardContourIndexes = useCallback(() => {
    const indexes = selectedContours.length
      ? selectedContours
      : selectedContour != null
        ? [selectedContour]
        : selected.length
          ? Array.from(new Set(selected.map(([ci]) => ci)))
          : contours.map((_contour, index) => index);
    return indexes.filter(index => contours[index]?.length >= 3);
  }, [contours, selected, selectedContour, selectedContours]);
  const applyImportedContours = useCallback((nextContours: Contour[], color = activeColor) => {
    if (!nextContours.length) return;
    snapshot();
    const startIndex = contours.length;
    setContours(prev => [...prev, ...nextContours]);
    setContourColors(prev => [...prev, ...nextContours.map(() => color)]);
    const nextIndexes = nextContours.map((_contour, index) => startIndex + index);
    setSelected([]);
    setSelectedContours(nextIndexes);
    setSelectedContour(nextIndexes[0] ?? null);
    setMode('block');
  }, [activeColor, contours.length, snapshot]);

  const importClipboardFile = useCallback(async (filePath: string) => {
    const result = await window.electronAPI.importGlyphAsset({ input: filePath, upm, ascent: top, descent: bottom, advance });
    if (!result.success || !result.contours?.length) {
      setImportStatus(result.error || '剪贴板内容无法转换为字形');
      return false;
    }
    const nextContours = result.contours.map(contour => contour.map(point => ({ x: point.x, y: point.y, on: point.on !== false })));
    applyImportedContours(nextContours);
    setImportStatus(`粘贴完成：${result.count || nextContours.length} 个轮廓`);
    return true;
  }, [advance, applyImportedContours, bottom, top, upm]);

  const importExternalClipboard = useCallback(async (clipboardData?: DataTransfer | null) => {
    setExternalPasteBusy(true);
    try {
      const dataTransfer = clipboardData || null;
      const svgText = dataTransfer?.getData('image/svg+xml') || dataTransfer?.getData('text/plain') || '';
      if (svgText.trim().startsWith('<svg')) {
        const tempDir = await window.electronAPI.pathJoin(await window.electronAPI.getAppPath('temp'), 'ZoomlaXizhiClipboard');
        await window.electronAPI.fsMkdir(tempDir);
        const filePath = await window.electronAPI.pathJoin(tempDir, `clipboard-${Date.now()}.svg`);
        await window.electronAPI.fsWriteFile(filePath, svgText);
        return importClipboardFile(filePath);
      }
      const items = Array.from(dataTransfer?.items || []);
      const imageItem = items.find(item => item.kind === 'file' && item.type.startsWith('image/'));
      const imageFile = imageItem?.getAsFile();
      if (imageFile) {
        const buffer = await imageFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        const tempDir = await window.electronAPI.pathJoin(await window.electronAPI.getAppPath('temp'), 'ZoomlaXizhiClipboard');
        await window.electronAPI.fsMkdir(tempDir);
        const extension = imageFile.type.includes('jpeg') ? 'jpg' : imageFile.type.includes('bmp') ? 'bmp' : 'png';
        const filePath = await window.electronAPI.pathJoin(tempDir, `clipboard-${Date.now()}.${extension}`);
        await window.electronAPI.fsWriteBinaryBase64(filePath, btoa(binary));
        return importClipboardFile(filePath);
      }
      const material = await window.electronAPI.readClipboardMaterial();
      if (material.success && material.path) {
        return importClipboardFile(material.path);
      }
      setImportStatus(material.error || '剪贴板中没有可粘贴的字形、图片或 SVG');
      return false;
    } finally {
      setExternalPasteBusy(false);
    }
  }, [importClipboardFile]);

  const copySelection = useCallback(async () => {
    const indexes = clipboardContourIndexes();
    if (!indexes.length) return;
    const payload: GlyphClipboardPayload = {
      contours: indexes.map(index => contours[index].map(point => ({ ...point }))),
      contourColors: indexes.map(index => contourColors[index] || '#111111'),
    };
    sharedGlyphClipboard = payload;
    setHasGlyphClipboard(true);
    window.dispatchEvent(new Event('zoomla-glyph-clipboard'));
    await navigator.clipboard?.writeText(`${GLYPH_CLIPBOARD_MIME}:${JSON.stringify(payload)}`).catch(() => undefined);
  }, [clipboardContourIndexes, contourColors, contours]);
  const cutSelection = useCallback(async () => {
    const indexes = clipboardContourIndexes();
    if (!indexes.length) return;
    await copySelection();
    snapshot();
    const remove = new Set(indexes);
    setContours(prev => prev.filter((_contour, index) => !remove.has(index)));
    setContourColors(prev => prev.filter((_color, index) => !remove.has(index)));
    setSelected([]);
    setSelectedContours([]);
    setSelectedContour(null);
  }, [clipboardContourIndexes, copySelection, snapshot]);
  const pasteInternalPayload = useCallback((payload: GlyphClipboardPayload | null) => {
    if (!payload?.contours.length) return;
    snapshot();
    const startIndex = contours.length;
    const pastedContours = payload.contours.map(contour => contour.map(point => ({ ...point, x: point.x + 24, y: point.y - 24 })));
    setContours(prev => [...prev, ...pastedContours]);
    setContourColors(prev => [...prev, ...payload.contourColors.map(color => color || '#111111')]);
    const nextIndexes = pastedContours.map((_contour, index) => startIndex + index);
    setSelected([]);
    setSelectedContours(nextIndexes);
    setSelectedContour(nextIndexes[0] ?? null);
    setMode('block');
  }, [contours.length, snapshot]);
  const pasteSelection = useCallback(async (clipboardData?: DataTransfer | null) => {
    let payload = sharedGlyphClipboard;
    if (!payload) {
      const text = await navigator.clipboard?.readText?.().catch(() => '') || '';
      if (text.startsWith(`${GLYPH_CLIPBOARD_MIME}:`)) {
        try {
          payload = JSON.parse(text.slice(GLYPH_CLIPBOARD_MIME.length + 1)) as GlyphClipboardPayload;
        } catch {
          payload = null;
        }
      }
    }
    if (payload?.contours.length) {
      pasteInternalPayload(payload);
      return;
    }
    await importExternalClipboard(clipboardData);
  }, [importExternalClipboard, pasteInternalPayload]);
  const toCanvas = useCallback((x: number, y: number) => ({ x: ox + x * scale, y: oy + (top - y) * scale }), [ox, oy, scale, top]);
  const toFont = useCallback((x: number, y: number) => ({ x: Math.round((x - ox) / scale), y: Math.round(top - (y - oy) / scale) }), [ox, oy, scale, top]);
  const pointer = () => stageRef.current?.getPointerPosition() || { x: 0, y: 0 };
  const contourToCanvasPoints = (contour: Contour) => contour.flatMap(p => { const c = toCanvas(p.x, p.y); return [c.x, c.y]; });
  const contourPathData = useCallback((contour: Contour) => {
    if (contour.length < 2) return '';
    const expanded: Contour = [];
    contour.forEach((point, index) => {
      const next = contour[(index + 1) % contour.length];
      expanded.push(point);
      if (point.on === false && next.on === false) {
        expanded.push({ ...midpoint(point, next), on: true });
      }
    });
    const startIndex = expanded.findIndex(point => point.on !== false);
    if (startIndex < 0) return '';
    const ordered = [...expanded.slice(startIndex), ...expanded.slice(0, startIndex)];
    const start = ordered[0];
    const startCanvas = toCanvas(start.x, start.y);
    let d = `M ${startCanvas.x.toFixed(2)} ${startCanvas.y.toFixed(2)}`;
    const sequence = [...ordered.slice(1), start];
    let index = 0;
    while (index < sequence.length) {
      const point = sequence[index];
      if (point.on === false) {
        const nextPoint = sequence[index + 1];
        if (!nextPoint) break;
        const control = toCanvas(point.x, point.y);
        const end = toCanvas(nextPoint.x, nextPoint.y);
        d += ` Q ${control.x.toFixed(2)} ${control.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
        index += 2;
      } else {
        const c = toCanvas(point.x, point.y);
        d += ` L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`;
        index += 1;
      }
    }
    return `${d} Z`;
  }, [toCanvas]);
  const glyphPathData = useMemo(() => contours
    .map((contour, index) => isEraseColor(contourColors[index]) ? '' : contourPathData(contour))
    .filter(Boolean)
    .join(' '), [contours, contourColors, contourPathData]);
  const erasePathData = useMemo(() => contours
    .map((contour, index) => isEraseColor(contourColors[index]) ? contourPathData(contour) : '')
    .filter(Boolean)
    .join(' '), [contours, contourColors, contourPathData]);
  const glyphPathGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    const colors = effectiveContourColors(contours, contourColors);
    contours.forEach((contour, index) => {
      const d = contourPathData(contour);
      if (!d) return;
      const color = colors[index] || '#111111';
      if (isEraseColor(color)) return;
      groups.set(color, [...(groups.get(color) || []), d]);
    });
    return Array.from(groups.entries()).map(([color, paths]) => ({ color, data: paths.join(' ') }));
  }, [contours, contourColors, contourPathData]);
  const handleLines = useMemo(() => contours.flatMap((contour, ci) => contour.flatMap((point, pi) => {
    if (point.on !== false) return [];
    const prev = contour[(pi - 1 + contour.length) % contour.length];
    const next = contour[(pi + 1) % contour.length];
    const owner = prev?.on !== false ? prev : next?.on !== false ? next : null;
    if (!owner) return [];
    const a = toCanvas(owner.x, owner.y);
    const b = toCanvas(point.x, point.y);
    return [{ key: `${ci}:${pi}`, points: [a.x, a.y, b.x, b.y] }];
  })), [contours, toCanvas]);
  const selectedSet = useMemo(() => new Set(selected.map(([ci, pi]) => `${ci}:${pi}`)), [selected]);
  const contourBox = useCallback((contour: Contour): BBox | null => {
    if (!contour.length) return null;
    return contour.reduce((box, point) => ({
      minX: Math.min(box.minX, point.x),
      minY: Math.min(box.minY, point.y),
      maxX: Math.max(box.maxX, point.x),
      maxY: Math.max(box.maxY, point.y),
    }), { minX: contour[0].x, minY: contour[0].y, maxX: contour[0].x, maxY: contour[0].y });
  }, []);
  const contourIndexesBox = useCallback((indexes: number[]): BBox | null => {
    const boxes = indexes.map(index => contourBox(contours[index] || [])).filter(Boolean) as BBox[];
    if (!boxes.length) return null;
    return boxes.reduce((box, item) => ({
      minX: Math.min(box.minX, item.minX),
      minY: Math.min(box.minY, item.minY),
      maxX: Math.max(box.maxX, item.maxX),
      maxY: Math.max(box.maxY, item.maxY),
    }), { ...boxes[0] });
  }, [contours, contourBox]);
  const activeContourIndexes = useMemo(() => {
    if (selectedContours.length) return selectedContours;
    return selectedContour != null ? [selectedContour] : [];
  }, [selectedContours, selectedContour]);
  const selectedBox = useMemo(() => contourIndexesBox(activeContourIndexes), [activeContourIndexes, contourIndexesBox]);
  const canvasBox = useCallback((box: BBox) => {
    const tl = toCanvas(box.minX, box.maxY);
    const br = toCanvas(box.maxX, box.minY);
    return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
  }, [toCanvas]);
  const transformHandles = useMemo(() => {
    if (!selectedBox) return [];
    const box = canvasBox(selectedBox);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    return [
      { id: 'nw' as TransformHandle, x: box.x, y: box.y, cursor: 'nwse-resize' },
      { id: 'n' as TransformHandle, x: cx, y: box.y, cursor: 'ns-resize' },
      { id: 'ne' as TransformHandle, x: box.x + box.width, y: box.y, cursor: 'nesw-resize' },
      { id: 'e' as TransformHandle, x: box.x + box.width, y: cy, cursor: 'ew-resize' },
      { id: 'se' as TransformHandle, x: box.x + box.width, y: box.y + box.height, cursor: 'nwse-resize' },
      { id: 's' as TransformHandle, x: cx, y: box.y + box.height, cursor: 'ns-resize' },
      { id: 'sw' as TransformHandle, x: box.x, y: box.y + box.height, cursor: 'nesw-resize' },
      { id: 'w' as TransformHandle, x: box.x, y: cy, cursor: 'ew-resize' },
    ];
  }, [selectedBox, canvasBox]);
  const hitTransformHandle = (x: number, y: number): TransformHandle | null => {
    const handle = transformHandles.find(item => Math.abs(item.x - x) <= 8 && Math.abs(item.y - y) <= 8);
    return handle?.id || null;
  };
  const isInsideCanvasBox = (x: number, y: number, box: BBox | null) => {
    if (!box) return false;
    const cbox = canvasBox(box);
    return x >= cbox.x && x <= cbox.x + cbox.width && y >= cbox.y && y <= cbox.y + cbox.height;
  };
  const buildBigBrushEraseContours = useCallback((path: Contour): Contour[] => {
    const radius = Math.max(4, Math.round(bigBrushSize / 2));
    if (path.length === 1) return [circleContour(path[0].x, path[0].y, radius)];
    const stamps: Contour[] = [];
    path.forEach((point, index) => {
      if (index === 0) {
        stamps.push(circleContour(point.x, point.y, radius));
        return;
      }
      const prev = path[index - 1];
      const dx = point.x - prev.x;
      const dy = point.y - prev.y;
      const distance = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(distance / Math.max(4, radius * 0.55)));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        stamps.push(circleContour(prev.x + dx * t, prev.y + dy * t, radius));
      }
    });
    return stamps;
  }, [bigBrushSize]);
  const shapeDraftBox = useMemo(() => {
    if (!shapeDraft) return null;
    return {
      x: Math.min(shapeDraft.x1, shapeDraft.x2),
      y: Math.min(shapeDraft.y1, shapeDraft.y2),
      width: Math.abs(shapeDraft.x2 - shapeDraft.x1),
      height: Math.abs(shapeDraft.y2 - shapeDraft.y1),
    };
  }, [shapeDraft]);
  const polygonDraftPoints = useMemo(() => {
    if (!shapeDraftBox || !pendingShape) return [];
    const cx = shapeDraftBox.x + shapeDraftBox.width / 2;
    const cy = shapeDraftBox.y + shapeDraftBox.height / 2;
    const rx = shapeDraftBox.width / 2;
    const ry = shapeDraftBox.height / 2;
    return Array.from({ length: pendingShape.sides }).flatMap((_v, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / pendingShape.sides;
      return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry];
    });
  }, [pendingShape, shapeDraftBox]);
  const constrainShapePoint = useCallback((startX: number, startY: number, endX: number, endY: number, proportional: boolean) => {
    if (!proportional) return { x: endX, y: endY };
    const dx = endX - startX;
    const dy = endY - startY;
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: startX + size * (dx < 0 ? -1 : 1),
      y: startY + size * (dy < 0 ? -1 : 1),
    };
  }, []);

  useEffect(() => {
    if (!dragGlyphStart) return;
    const container = stageRef.current?.container?.() as HTMLElement | undefined;
    const previousBodyCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const previousContainerCursor = container?.style.cursor || '';
    const previousContainerUserSelect = container?.style.userSelect || '';
    const previousContainerTouchAction = container?.style.touchAction || '';
    const canvases: HTMLCanvasElement[] = container ? Array.from(container.querySelectorAll('canvas')) as HTMLCanvasElement[] : [];
    const previousCanvasState = canvases.map(canvas => ({
      canvas,
      draggable: canvas.draggable,
      userSelect: canvas.style.userSelect,
      touchAction: canvas.style.touchAction,
      cursor: canvas.style.cursor,
    }));
    const activeHandle = dragGlyphStart.handle ? transformHandles.find(handle => handle.id === dragGlyphStart.handle) : null;
    const activeCursor = dragGlyphStart.action === 'scale' ? activeHandle?.cursor || 'default' : 'move';
    document.body.style.cursor = activeCursor;
    document.body.style.userSelect = 'none';
    if (container) {
      container.style.cursor = activeCursor;
      container.style.userSelect = 'none';
      container.style.touchAction = 'none';
    }
    canvases.forEach(canvas => {
      canvas.draggable = false;
      canvas.style.userSelect = 'none';
      canvas.style.touchAction = 'none';
      canvas.style.cursor = activeCursor;
    });

    const moveContour = (clientX: number, clientY: number) => {
      const rect = container?.getBoundingClientRect();
      if (!rect) return;
      const pos = { x: clientX - rect.left, y: clientY - rect.top };
      const dx = Math.round((pos.x - dragGlyphStart.x) / scale);
      const dy = Math.round(-(pos.y - dragGlyphStart.y) / scale);
      const targets = new Set(dragGlyphStart.contourIndexes);
      setContours(dragGlyphStart.contours.map((contour, ci) => targets.has(ci) ? contour.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) : contour));
    };
    const scaleContour = (clientX: number, clientY: number, event: MouseEvent) => {
      const rect = container?.getBoundingClientRect();
      if (!rect || !dragGlyphStart.handle) return;
      const pos = { x: clientX - rect.left, y: clientY - rect.top };
      const fontPos = toFont(pos.x, pos.y);
      const box = dragGlyphStart.bbox;
      const w = Math.max(1, box.maxX - box.minX);
      const h = Math.max(1, box.maxY - box.minY);
      const handle = dragGlyphStart.handle;
      const lockAspect = event.shiftKey;
      const side = ['n', 'e', 's', 'w'].includes(handle);
      let anchorX = handle.includes('w') ? box.maxX : handle.includes('e') ? box.minX : (box.minX + box.maxX) / 2;
      let anchorY = handle.includes('s') ? box.maxY : handle.includes('n') ? box.minY : (box.minY + box.maxY) / 2;
      let sx = 1;
      let sy = 1;
      if (handle.includes('w')) sx = (anchorX - fontPos.x) / w;
      if (handle.includes('e')) sx = (fontPos.x - anchorX) / w;
      if (handle.includes('s')) sy = (anchorY - fontPos.y) / h;
      if (handle.includes('n')) sy = (fontPos.y - anchorY) / h;
      if (side) {
        if (handle === 'n' || handle === 's') sx = 1;
        if (handle === 'e' || handle === 'w') sy = 1;
      } else if (lockAspect) {
        const signX = Math.sign(sx || 1);
        const signY = Math.sign(sy || 1);
        const uniform = Math.max(Math.abs(sx), Math.abs(sy), 0.04);
        sx = signX * uniform;
        sy = signY * uniform;
      }
      sx = Math.abs(sx) < 0.04 ? 0.04 * Math.sign(sx || 1) : sx;
      sy = Math.abs(sy) < 0.04 ? 0.04 * Math.sign(sy || 1) : sy;
      const targets = new Set(dragGlyphStart.contourIndexes);
      setContours(dragGlyphStart.contours.map((contour, ci) => targets.has(ci)
        ? contour.map(p => ({ ...p, x: Math.round(anchorX + (p.x - anchorX) * sx), y: Math.round(anchorY + (p.y - anchorY) * sy) }))
        : contour));
    };
    const applyTransform = (event: MouseEvent) => {
      if (dragGlyphStart.action === 'scale') scaleContour(event.clientX, event.clientY, event);
      else moveContour(event.clientX, event.clientY);
    };

    const onMove = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      applyTransform(event);
    };
    const onUp = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      applyTransform(event);
      setDragGlyphStart(null);
    };
    const suppressNativeDrag = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('mousemove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp, { passive: false });
    window.addEventListener('dragstart', suppressNativeDrag, true);
    window.addEventListener('selectstart', suppressNativeDrag, true);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('dragstart', suppressNativeDrag, true);
      window.removeEventListener('selectstart', suppressNativeDrag, true);
      document.body.style.cursor = previousBodyCursor;
      document.body.style.userSelect = previousUserSelect;
      if (container) {
        container.style.cursor = previousContainerCursor;
        container.style.userSelect = previousContainerUserSelect;
        container.style.touchAction = previousContainerTouchAction;
      }
      previousCanvasState.forEach(({ canvas, draggable, userSelect, touchAction, cursor }) => {
        canvas.draggable = draggable;
        canvas.style.userSelect = userSelect;
        canvas.style.touchAction = touchAction;
        canvas.style.cursor = cursor;
      });
    };
  }, [dragGlyphStart, scale, toFont, transformHandles]);

  useEffect(() => {
    if (!dockDrag) return;
    const onMove = (event: MouseEvent) => {
      const nextX = dockDrag.startX + event.clientX - dockDrag.x;
      const nextY = dockDrag.startY + event.clientY - dockDrag.y;
      setDockPos(dockPxToPercent(nextX, nextY, workspaceW, workspaceH, DOCK_W, DOCK_H));
    };
    const onUp = () => setDockDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dockDrag, workspaceW, workspaceH]);

  useEffect(() => {
    if (!colorDockDrag) return;
    const onMove = (event: MouseEvent) => {
      const nextX = colorDockDrag.startX + event.clientX - colorDockDrag.x;
      const nextY = colorDockDrag.startY + event.clientY - colorDockDrag.y;
      setColorDockPos(dockPxToPercent(nextX, nextY, workspaceW, workspaceH, COLOR_DOCK_W, COLOR_DOCK_H));
    };
    const onUp = () => setColorDockDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [colorDockDrag, workspaceW, workspaceH]);

  const hitPoint = (x: number, y: number): [number, number] | null => {
    let best: [number, number] | null = null; let bestD = HIT * HIT;
    contours.forEach((contour, ci) => contour.forEach((point, pi) => { const c = toCanvas(point.x, point.y); const d = (c.x - x) ** 2 + (c.y - y) ** 2; if (d <= bestD) { bestD = d; best = [ci, pi]; } }));
    return best;
  };

  const hitSegment = (x: number, y: number): [number, number] | null => {
    let best: [number, number] | null = null;
    let bestD = 9 * 9;
    contours.forEach((contour, ci) => {
      if (contour.length < 2) return;
      contour.forEach((point, pi) => {
        const next = contour[(pi + 1) % contour.length];
        if (point.on === false || next.on === false) return;
        const a = toCanvas(point.x, point.y);
        const b = toCanvas(next.x, next.y);
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const len2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / len2));
        const px = a.x + vx * t;
        const py = a.y + vy * t;
        const d = (px - x) ** 2 + (py - y) ** 2;
        if (d <= bestD) {
          bestD = d;
          best = [ci, pi];
        }
      });
    });
    return best;
  };

  const hitContour = (x: number, y: number): number | null => {
    for (let ci = contours.length - 1; ci >= 0; ci -= 1) {
      const contour = contours[ci];
      if (contour.length < 3) continue;
      let inside = false;
      for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
        const a = toCanvas(contour[i].x, contour[i].y);
        const b = toCanvas(contour[j].x, contour[j].y);
        if (((a.y > y) !== (b.y > y)) && x < ((b.x - a.x) * (y - a.y)) / ((b.y - a.y) || 1) + a.x) inside = !inside;
      }
      if (inside) return ci;
    }
    return null;
  };

  const hitGuide = (x: number, y: number): { axis: 'vertical' | 'horizontal'; index: number; canvasValue: number } | null => {
    const threshold = 6;
    for (let index = guides.vertical.length - 1; index >= 0; index -= 1) {
      const gx = toCanvas(guides.vertical[index], 0).x;
      if (Math.abs(gx - x) <= threshold) return { axis: 'vertical', index, canvasValue: gx };
    }
    for (let index = guides.horizontal.length - 1; index >= 0; index -= 1) {
      const gy = toCanvas(0, guides.horizontal[index]).y;
      if (Math.abs(gy - y) <= threshold) return { axis: 'horizontal', index, canvasValue: gy };
    }
    return null;
  };

  const deleteSelected = useCallback(() => {
    if (selected.length) {
      snapshot();
      const keys = new Set(selected.map(([ci, pi]) => `${ci}:${pi}`));
      setContours(prev => {
        const keepIndexes: number[] = [];
        const next = prev.map((contour, ci) => ({ contour: contour.filter((_p, pi) => !keys.has(`${ci}:${pi}`)), ci })).filter(item => {
          const keep = item.contour.length >= 3;
          if (keep) keepIndexes.push(item.ci);
          return keep;
        }).map(item => item.contour);
        setContourColors(colors => keepIndexes.map(index => colors[index] || '#111111'));
        return next;
      });
      setSelected([]);
      return;
    }
    const contourIndexes = selectedContours.length ? selectedContours : selectedContour != null ? [selectedContour] : [];
    if (!contourIndexes.length) return;
    snapshot();
    const remove = new Set(contourIndexes);
    setContours(prev => prev.filter((_contour, ci) => !remove.has(ci)));
    setContourColors(prev => prev.filter((_color, ci) => !remove.has(ci)));
    setSelected([]);
    setSelectedContours([]);
    setSelectedContour(null);
  }, [selected, selectedContours, selectedContour, snapshot]);

  const selectAllContours = useCallback(() => {
    if (!contours.length) return;
    setMode('block');
    setSelected([]);
    setSelectedContours(contours.map((_contour, index) => index));
    setSelectedContour(0);
  }, [contours]);

  const deletePoint = (ci: number, pi: number) => {
    snapshot();
    setContours(prev => prev.map((contour, index) => index === ci ? contour.filter((_p, pointIndex) => pointIndex !== pi) : contour).filter(c => c.length >= 3));
    setSelected([]);
  };

  const undoLast = useCallback(() => {
    const last = undo[undo.length - 1];
    if (!last) return;
    setRedo(prev => [...prev.slice(-9), historyState()]);
    applyHistoryState(last);
    setUndo(prev => prev.slice(0, -1));
  }, [applyHistoryState, historyState, undo]);
  const redoLast = useCallback(() => {
    const last = redo[redo.length - 1];
    if (!last) return;
    setUndo(prev => [...prev.slice(-9), historyState()]);
    applyHistoryState(last);
    setRedo(prev => prev.slice(0, -1));
  }, [applyHistoryState, historyState, redo]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (saveDialog) {
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          setSaveDialog(false);
        }
        return;
      }
      if (closeDialog) {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopImmediatePropagation();
          void confirmCloseWithSave();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setCloseDialog(false);
        }
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestClose();
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void handleSaveAndClose();
        return;
      }
      if (event.key === 'F8') {
        const target = event.target as Node | null;
        const root = editorRootRef.current;
        if (root) {
          const rect = root.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          const inEditor = Boolean(target && root.contains(target));
          const targetElement = target instanceof Element ? target : null;
          const inOtherAppRegion = Boolean(targetElement?.closest('[data-f8-scope]')) && !inEditor;
          if (!visible || inOtherAppRegion) return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        setShowPreviewDock(value => !value);
        return;
      }
      if (event.altKey && event.code === 'ArrowLeft') { event.preventDefault(); event.stopImmediatePropagation(); void onNavigate(-1, data); return; }
      if (event.altKey && event.code === 'ArrowRight') { event.preventDefault(); event.stopImmediatePropagation(); void onNavigate(1, data); return; }
      const target = event.target as HTMLElement | null;
      const isTextInput = Boolean(target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      const hasNativeTextSelection = Boolean(window.getSelection()?.toString().trim());
      if (hasNativeTextSelection && event.ctrlKey && event.key.toLowerCase() === 'c') return;
      if (!isTextInput && event.ctrlKey && event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopImmediatePropagation(); copySelection(); return; }
      if (!isTextInput && event.ctrlKey && event.key.toLowerCase() === 'x') { event.preventDefault(); event.stopImmediatePropagation(); void cutSelection(); return; }
      if (!isTextInput && event.ctrlKey && event.key.toLowerCase() === 'v' && sharedGlyphClipboard?.contours.length) { event.preventDefault(); event.stopImmediatePropagation(); void pasteSelection(); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'i') { event.preventDefault(); event.stopImmediatePropagation(); void importGlyph(); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'e') { event.preventDefault(); event.stopImmediatePropagation(); void onExport(code, data); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void handleSave(); return; }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'z') { event.preventDefault(); redoLast(); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); undoLast(); return; }
      if (event.ctrlKey && event.key === '0') { event.preventDefault(); setZoom(1); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'r') { event.preventDefault(); setShowRulers(value => !value); }
      if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); document.getElementById('glyph-jump-input')?.focus(); }
      if (event.ctrlKey && event.key.toLowerCase() === 'a') { event.preventDefault(); selectAllContours(); }
      if (event.key === 'Delete') { event.preventDefault(); deleteSelected(); }
      if (event.key.toLowerCase() === 'v') { setMode('edit'); setTool('select'); }
      if (event.key.toLowerCase() === 'b') { setMode('edit'); setTool('brush'); }
      if (event.key.toLowerCase() === 'e') { setMode('edit'); setTool('eraser'); }
      if (event.shiftKey && event.key.toLowerCase() === 'b') { setMode('edit'); setTool('bigBrush'); }
      if (event.key === 'Escape') { setSelected([]); setSelectedContours([]); setSelectedContour(null); setMode('block'); setMenu(null); }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [closeDialog, code, copySelection, cutSelection, data, deleteSelected, hasChanges, onExport, onNavigate, pasteSelection, redoLast, saveDialog, selectAllContours, undoLast]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void pasteSelection(event.clipboardData);
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [pasteSelection]);

  const handleMouseDown = (event: any) => {
    setMenu(null); const pos = pointer();
    if (event.evt?.button !== 0) return;
    event.evt?.preventDefault?.();
    event.evt?.stopPropagation?.();
    const guideHit = showRulers ? hitGuide(pos.x, pos.y) : null;
    if (guideHit && !guideLocked) {
      const container = stageRef.current?.container?.();
      if (container) container.style.cursor = guideHit.axis === 'vertical' ? 'ew-resize' : 'ns-resize';
      setGuideDrag({ axis: guideHit.axis, index: guideHit.index });
      return;
    }
    if (showRulers && pos.y <= 24 && pos.x > 34) { setGuideDraft({ axis: 'horizontal', canvasValue: pos.y }); return; }
    if (showRulers && pos.x <= 34 && pos.y > 24) { setGuideDraft({ axis: 'vertical', canvasValue: pos.x }); return; }
    if (pendingShape) {
      const container = stageRef.current?.container?.();
      if (container) container.style.cursor = 'crosshair';
      setShapeDraft({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
      return;
    }
    if (paintMode) {
      const contourIndex = hitContour(pos.x, pos.y);
      if (contourIndex != null) {
        snapshot();
        setContourColors(prev => contours.map((_contour, index) => index === contourIndex ? activeColor : prev[index] || '#111111'));
        setSelectedContour(contourIndex);
        setSelectedContours([contourIndex]);
      }
      return;
    }
    if (paintMode) {
      const container = stageRef.current?.container?.();
      if (container) container.style.cursor = hitContour(pos.x, pos.y) !== null ? 'crosshair' : 'default';
      return;
    }
    if (mode === 'edit' && tool === 'bigBrush') {
      snapshot();
      setSelected([]); setSelectedContour(null); setSelectedContours([]);
      setBigBrushPath([toFont(pos.x, pos.y)]);
      const container = stageRef.current?.container?.();
      if (container) container.style.cursor = 'crosshair';
      return;
    }
    if (mode === 'block') {
      const activeBox = selectedBox;
      const handle = activeBox ? hitTransformHandle(pos.x, pos.y) : null;
      if (activeContourIndexes.length && activeBox && handle) {
        const found = transformHandles.find(item => item.id === handle);
        const container = stageRef.current?.container?.();
        if (container) container.style.cursor = found?.cursor || 'default';
        snapshot();
        setDragGlyphStart({ x: pos.x, y: pos.y, contours: cloneContours(contours), contourIndexes: activeContourIndexes, action: 'scale', handle, bbox: activeBox });
        return;
      }
      if (activeContourIndexes.length && activeBox && isInsideCanvasBox(pos.x, pos.y, activeBox)) {
        const container = stageRef.current?.container?.();
        if (container) container.style.cursor = 'move';
        snapshot();
        setDragGlyphStart({ x: pos.x, y: pos.y, contours: cloneContours(contours), contourIndexes: activeContourIndexes, action: 'move', bbox: activeBox });
        return;
      }
      const contourIndex = hitContour(pos.x, pos.y);
      const appendSelect = Boolean(event.evt?.ctrlKey || event.evt?.metaKey);
      if (contourIndex === null) {
        if (!appendSelect) {
          setSelectedContour(null);
          setSelectedContours([]);
        }
        return;
      }
      const container = stageRef.current?.container?.();
      if (container) container.style.cursor = 'default';
      setSelected([]);
      if (appendSelect) {
        setSelectedContours(prev => {
          const exists = prev.includes(contourIndex);
          const next = exists ? prev.filter(index => index !== contourIndex) : [...prev, contourIndex];
          setSelectedContour(next[0] ?? null);
          return next;
        });
      } else {
        setSelectedContour(contourIndex);
        setSelectedContours([contourIndex]);
      }
      return;
    }
    if (tool === 'brush') { snapshot(); setBrushContour([toFont(pos.x, pos.y)]); return; }
    const hit = hitPoint(pos.x, pos.y);
    if (tool === 'eraser') { if (hit) { snapshot(); const [ci, pi] = hit; setContours(prev => { const keepIndexes: number[] = []; const next = prev.map((c, index) => ({ contour: index === ci ? c.filter((_p, idx) => idx !== pi) : c, index })).filter(item => { const keep = item.contour.length >= 3; if (keep) keepIndexes.push(item.index); return keep; }).map(item => item.contour); setContourColors(colors => keepIndexes.map(index => colors[index] || '#111111')); return next; }); } return; }
    if (hit) {
      snapshot(); const isAlreadySelected = selectedSet.has(`${hit[0]}:${hit[1]}`);
      const nextSelected = event.evt.shiftKey ? Array.from(new Set([...selected, hit].map(x => x.join(':')))).map(s => s.split(':').map(Number) as [number, number]) : isAlreadySelected ? selected : [hit];
      setSelectedContours([]); setSelectedContour(null); setSelected(nextSelected); setDragSelectionStart({ x: pos.x, y: pos.y, contours: cloneContours(contours) }); setDragPoint(hit);
    } else {
      const segment = hitSegment(pos.x, pos.y);
      if (segment) {
        const [ci, pi] = segment;
        snapshot();
        const nextContours = cloneContours(contours);
        nextContours[ci].splice(pi + 1, 0, { ...toFont(pos.x, pos.y), on: false });
        setContours(nextContours);
        setSelected([[ci, pi + 1]]);
        setDragSelectionStart({ x: pos.x, y: pos.y, contours: nextContours });
        setDragPoint([ci, pi + 1]);
        return;
      }
      setSelectedContours([]); setSelectedContour(null); setSelected([]); setSelectBox({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
    }
  };

  const handleMouseMove = (event?: any) => {
    if (dragGlyphStart || guideDrag || guideDraft || dragPoint || selectBox || brushContour || bigBrushPath || shapeDraft) event?.evt?.preventDefault?.();
    const pos = pointer();
    const guideHit = showRulers ? hitGuide(pos.x, pos.y) : null;
    setHoverGuide(guideHit ? { axis: guideHit.axis, canvasValue: guideHit.canvasValue } : null);
    const container = stageRef.current?.container?.();
    if (container) {
      const cursorAxis = guideDrag?.axis || (!guideLocked ? guideHit?.axis : undefined);
      container.style.cursor = cursorAxis ? (cursorAxis === 'vertical' ? 'ew-resize' : 'ns-resize') : pendingShape || (mode === 'edit' && tool === 'bigBrush') ? 'crosshair' : 'default';
    }
    if (guideDrag) {
      if (event?.evt?.buttons !== 1) {
        setGuideDrag(null);
        return;
      }
      const fontPoint = toFont(pos.x, pos.y);
      setGuides(prev => guideDrag.axis === 'vertical'
        ? { ...prev, vertical: prev.vertical.map((value, index) => index === guideDrag.index ? fontPoint.x : value) }
        : { ...prev, horizontal: prev.horizontal.map((value, index) => index === guideDrag.index ? fontPoint.y : value) });
      return;
    }
    if (guideDraft) { setGuideDraft({ ...guideDraft, canvasValue: guideDraft.axis === 'vertical' ? pos.x : pos.y }); return; }
    if (shapeDraft) {
      const end = constrainShapePoint(shapeDraft.x1, shapeDraft.y1, pos.x, pos.y, Boolean(event?.evt?.shiftKey));
      setShapeDraft({ ...shapeDraft, x2: end.x, y2: end.y });
      return;
    }
    if (mode === 'block') {
      const container = stageRef.current?.container?.();
      if (dragGlyphStart) {
        const found = dragGlyphStart.handle ? transformHandles.find(item => item.id === dragGlyphStart.handle) : null;
        if (container) container.style.cursor = dragGlyphStart.action === 'scale' ? found?.cursor || 'default' : 'move';
        return;
      }
      if (!guideHit && container) {
        const handle = activeContourIndexes.length ? hitTransformHandle(pos.x, pos.y) : null;
        const found = transformHandles.find(item => item.id === handle);
        const activeBox = activeContourIndexes.length ? selectedBox : null;
        container.style.cursor = found?.cursor || (isInsideCanvasBox(pos.x, pos.y, activeBox) ? 'move' : hitContour(pos.x, pos.y) !== null ? 'pointer' : 'default');
      }
    } else if (!guideHit && container) {
      if (tool === 'bigBrush') container.style.cursor = 'crosshair';
      else
      if (hitPoint(pos.x, pos.y)) container.style.cursor = 'move';
      else if (hitSegment(pos.x, pos.y)) container.style.cursor = 'copy';
      else container.style.cursor = 'crosshair';
    }
    if (tool === 'brush' && brushContour) { const p = toFont(pos.x, pos.y); const last = brushContour[brushContour.length - 1]; if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 8) setBrushContour([...brushContour, p]); return; }
    if (tool === 'bigBrush' && bigBrushPath) { const p = toFont(pos.x, pos.y); const last = bigBrushPath[bigBrushPath.length - 1]; if (!last || Math.hypot(last.x - p.x, last.y - p.y) > Math.max(4, bigBrushSize * 0.22)) setBigBrushPath([...bigBrushPath, p]); return; }
    if (dragPoint && dragSelectionStart) { const dx = Math.round((pos.x - dragSelectionStart.x) / scale); const dy = Math.round(-(pos.y - dragSelectionStart.y) / scale); const keys = new Set(selected.map(([ci, pi]) => `${ci}:${pi}`)); setContours(dragSelectionStart.contours.map((contour, ci) => contour.map((p, pi) => keys.has(`${ci}:${pi}`) ? { ...p, x: p.x + dx, y: p.y + dy } : p))); return; }
    if (selectBox) setSelectBox({ ...selectBox, x2: pos.x, y2: pos.y });
  };

  const handleMouseUp = (event?: any) => {
    if (guideDrag) {
      const pos = pointer();
      setGuides(prev => {
        if (guideDrag.axis === 'vertical' && (pos.x < 34 || pos.x > stageW)) {
          return { ...prev, vertical: prev.vertical.filter((_value, index) => index !== guideDrag.index) };
        }
        if (guideDrag.axis === 'horizontal' && (pos.y < 24 || pos.y > stageH)) {
          return { ...prev, horizontal: prev.horizontal.filter((_value, index) => index !== guideDrag.index) };
        }
        return prev;
      });
      setGuideDrag(null);
      return;
    }
    if (guideDraft) {
      const pos = pointer();
      const fontPoint = toFont(pos.x, pos.y);
      setGuides(prev => guideDraft.axis === 'vertical'
        ? { ...prev, vertical: [...prev.vertical, fontPoint.x] }
        : { ...prev, horizontal: [...prev.horizontal, fontPoint.y] });
      setGuideDraft(null);
      return;
    }
    if (shapeDraft && pendingShape) {
      const end = pointer();
      const constrainedEnd = constrainShapePoint(shapeDraft.x1, shapeDraft.y1, end.x, end.y, Boolean(event?.evt?.shiftKey));
      const draft = { ...shapeDraft, x2: constrainedEnd.x, y2: constrainedEnd.y };
      setShapeDraft(null);
      if (Math.abs(draft.x2 - draft.x1) < 6 || Math.abs(draft.y2 - draft.y1) < 6) return;
      const a = toFont(draft.x1, draft.y1);
      const b = toFont(draft.x2, draft.y2);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      const cx = Math.round((minX + maxX) / 2);
      const cy = Math.round((minY + maxY) / 2);
      const rx = Math.max(1, (maxX - minX) / 2);
      const ry = Math.max(1, (maxY - minY) / 2);
      const contour: Contour = pendingShape.kind === 'square'
        ? [{ x: minX, y: maxY, on: true }, { x: maxX, y: maxY, on: true }, { x: maxX, y: minY, on: true }, { x: minX, y: minY, on: true }]
        : Array.from({ length: pendingShape.sides }).map((_value, index) => {
          const angle = -Math.PI / 2 + index * Math.PI * 2 / pendingShape.sides;
          return { x: Math.round(cx + Math.cos(angle) * rx), y: Math.round(cy + Math.sin(angle) * ry), on: true };
        });
      snapshot();
      const newIndex = contours.length;
      setContours(prev => [...prev, contour]);
      setContourColors(prev => [...prev, activeColor]);
      setMode('block');
      setTool('select');
      setPendingShape(null);
      setSelected([]);
      setSelectedContours([newIndex]);
      setSelectedContour(newIndex);
      return;
    }
    if (mode === 'block') { const container = stageRef.current?.container?.(); if (dragGlyphStart) { event?.evt?.preventDefault?.(); return; } if (container) container.style.cursor = hitContour(pointer().x, pointer().y) !== null ? 'pointer' : 'default'; return; }
    if (tool === 'brush' && brushContour) { if (brushContour.length >= 3) { setContours(prev => [...prev, brushContour.map(p => ({ ...p, on: true }))]); setContourColors(prev => [...prev, activeColor]); } setBrushContour(null); }
    if (tool === 'bigBrush' && bigBrushPath) {
      const eraseContours = buildBigBrushEraseContours(bigBrushPath);
      if (eraseContours.length) {
        setContours(prev => [...prev, ...eraseContours]);
        setContourColors(prev => [...prev, ...eraseContours.map(() => '#ffffff')]);
      }
      setBigBrushPath(null);
      return;
    }
    if (selectBox) {
      const xMin = Math.min(selectBox.x1, selectBox.x2), xMax = Math.max(selectBox.x1, selectBox.x2), yMin = Math.min(selectBox.y1, selectBox.y2), yMax = Math.max(selectBox.y1, selectBox.y2);
      const hits: Array<[number, number]> = [];
      contours.forEach((contour, ci) => contour.forEach((p, pi) => { const c = toCanvas(p.x, p.y); if (c.x >= xMin && c.x <= xMax && c.y >= yMin && c.y <= yMax) hits.push([ci, pi]); }));
      setSelected(hits); setSelectBox(null);
    }
    setDragPoint(null); setDragSelectionStart(null);
  };

  const handleDoubleClick = () => {
    const pos = pointer();
    const hit = hitPoint(pos.x, pos.y);
    const segment = hitSegment(pos.x, pos.y);
    const contourHit = hitContour(pos.x, pos.y);
    if (mode === 'block' && contourHit !== null) {
      setMode('edit');
      setTool('select');
      setSelectedContour(null);
      setSelected([]);
      return;
    }
    if (mode === 'block' && contourHit === null) {
      setMode('edit');
      setTool('select');
      setSelectedContour(null);
      setSelected([]);
      return;
    }
    if (mode === 'edit') {
      if (hit) {
        const [ci, pi] = hit;
        if (contours[ci]?.[pi]?.on !== false) makeAnchorCurved(ci, pi);
        return;
      }
      if (segment) {
        const [ci, pi] = segment;
        insertAfter(ci, pi, toFont(pos.x, pos.y));
        return;
      }
      setMode('block');
      setTool('select');
      setSelected([]);
      setSelectedContour(null);
    }
  };

  const togglePoint = (ci: number, pi: number) => { snapshot(); setContours(prev => prev.map((contour, cIndex) => cIndex === ci ? contour.map((p, pIndex) => pIndex === pi ? { ...p, on: p.on === false } : p) : contour)); };
  const makeAnchorCurved = (ci: number, pi: number) => {
    snapshot();
    setContours(prev => prev.map((contour, cIndex) => {
      if (cIndex !== ci || !contour[pi] || contour[pi].on === false) return contour;
      const anchor = contour[pi];
      const beforeIndex = (pi - 1 + contour.length) % contour.length;
      const afterIndex = (pi + 1) % contour.length;
      const before = contour[beforeIndex];
      const after = contour[afterIndex];
      const left = { x: Math.round(anchor.x + ((before?.x ?? anchor.x) - anchor.x) * 0.35), y: Math.round(anchor.y + ((before?.y ?? anchor.y) - anchor.y) * 0.35), on: false };
      const right = { x: Math.round(anchor.x + ((after?.x ?? anchor.x) - anchor.x) * 0.35), y: Math.round(anchor.y + ((after?.y ?? anchor.y) - anchor.y) * 0.35), on: false };
      const next = [...contour];
      if (before.on !== false) {
        next.splice(pi, 0, left);
        next.splice(pi + 2, 0, right);
        setSelected([[ci, pi + 1]]);
      } else if (after.on !== false) {
        next.splice(pi + 1, 0, right);
        setSelected([[ci, pi]]);
      }
      return next;
    }));
  };
  const insertAfter = (ci: number, pi: number, at?: Point) => { snapshot(); setContours(prev => prev.map((contour, cIndex) => { if (cIndex !== ci) return contour; const a = contour[pi], b = contour[(pi + 1) % contour.length]; const point = at || { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), on: true }; const next = [...contour]; next.splice(pi + 1, 0, { x: Math.round(point.x), y: Math.round(point.y), on: true }); return next; })); setSelected([[ci, pi + 1]]); };
  const rotateGlyph = (degrees: number) => { snapshot(); const pts = contours.flat(); if (!pts.length) return; const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length; const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length; const rad = degrees * Math.PI / 180; setContours(prev => prev.map(c => c.map(p => ({ ...p, x: Math.round(cx + (p.x - cx) * Math.cos(rad) - (p.y - cy) * Math.sin(rad)), y: Math.round(cy + (p.x - cx) * Math.sin(rad) + (p.y - cy) * Math.cos(rad)) })))); };
  const flipGlyph = (axis: 'horizontal' | 'vertical') => { snapshot(); const target = selectedContour == null ? contours.flat() : contours[selectedContour] || []; if (!target.length) return; const cx = target.reduce((s, p) => s + p.x, 0) / target.length; const cy = target.reduce((s, p) => s + p.y, 0) / target.length; setContours(prev => prev.map((c, ci) => selectedContour == null || ci === selectedContour ? c.map(p => axis === 'horizontal' ? { ...p, x: Math.round(2 * cx - p.x) } : { ...p, y: Math.round(2 * cy - p.y) }) : c)); };
  const invertContourFill = useCallback((index = selectedContour) => {
    const targetIndexes = index != null
      ? [index]
      : selectedContours.length
        ? selectedContours
        : selected.length
          ? Array.from(new Set(selected.map(([ci]) => ci)))
          : [];
    const validIndexes = Array.from(new Set(targetIndexes)).filter(ci => contours[ci]?.length >= 3);
    if (!validIndexes.length) return;
    const targets = new Set(validIndexes);
    snapshot();
    setContours(prev => prev.map((contour, ci) => targets.has(ci) ? [...contour].reverse().map(p => ({ ...p })) : contour));
    setContourColors(prev => contours.map((_contour, ci) => {
      const color = prev[ci] || '#111111';
      return targets.has(ci) && isEraseColor(color) ? activeColor || '#111111' : color;
    }));
    setSelected([]);
    setSelectedContour(validIndexes[0]);
    setSelectedContours(validIndexes);
  }, [activeColor, contours, selected, selectedContour, selectedContours, snapshot]);
  const invertMenuContourFill = useCallback(() => {
    if (!menu) return;
    const target = menu.contourIndex ?? selectedContour;
    if (target != null) {
      setSelected([]);
      setSelectedContour(target);
      setSelectedContours([target]);
      invertContourFill(target);
    } else {
      invertContourFill();
    }
    setMenu(null);
  }, [invertContourFill, menu, selectedContour]);
  const clearGlyph = () => { snapshot(); setContours([]); setContourColors([]); setSelected([]); setSelectedContour(null); setSelectedContours([]); };
  const importGlyph = async () => {
    const input = await window.electronAPI.openFile({
      title: '导入字形',
      filters: [
        { name: '字形素材', extensions: ['png', 'svg', 'eps', 'bmp', 'jpg', 'jpeg'] },
        { name: '图片', extensions: ['png', 'bmp', 'jpg', 'jpeg'] },
        { name: '矢量', extensions: ['svg', 'eps'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (!input) return;
    const result = await window.electronAPI.importGlyphAsset({ input, upm, ascent: top, descent: bottom, advance });
    if (!result.success || !result.contours?.length) {
      alert(result.error || '导入失败：未识别到有效字形轮廓');
      return;
    }
    snapshot();
    const startIndex = contours.length;
    setContours(prev => [...prev, ...result.contours.map(contour => contour.map(point => ({ x: point.x, y: point.y, on: point.on !== false })))]);
    setContourColors(prev => [...prev, ...result.contours.map(() => activeColor)]);
    setMode('block');
    setSelected([]);
    setSelectedContour(startIndex);
    const methodLabel = result.method?.includes('raster') ? '位图追踪' : result.method?.includes('direct') ? '矢量解析' : '轮廓追踪';
    setImportStatus(`导入完成：${methodLabel}，${result.count || result.contours.length} 个轮廓`);
    window.setTimeout(() => setImportStatus(''), 2600);
  };
  const addShape = (kind: 'square' | 'circle' | 'polygon' | 'free') => {
    if (kind === 'free') {
      setMode('edit');
      setTool('brush');
      setPendingShape(null);
      setShowPolygonSides(false);
      return;
    }
    if (kind === 'polygon') {
      setShowPolygonSides(true);
      setPendingShape(null);
      setShapeDraft(null);
      return;
    }
    const sides = kind === 'circle' ? 32 : 4;
    setMode('block');
    setTool('select');
    setSelected([]); setSelectedContours([]); setSelectedContour(null);
    setPendingShape({ kind, sides });
  };
  const choosePolygonSides = (sides: number) => {
    setMode('block');
    setTool('select');
    setSelected([]); setSelectedContours([]); setSelectedContour(null);
    setShowPolygonSides(false);
    setPendingShape({ kind: 'polygon', sides });
  };
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const success = await onSave(code, data);
      if (success) {
        savedDataRef.current = JSON.stringify(data);
        setSaveDialog(true);
      }
    } finally {
      setSaving(false);
    }
  };
  const handleSaveAndClose = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const success = await onSave(code, data);
      if (success) {
        savedDataRef.current = JSON.stringify(data);
        onClose({ skipAutoSave: true });
      }
    } finally {
      setSaving(false);
    }
  };
  const requestClose = () => {
    if (hasChanges) setCloseDialog(true);
    else onClose({ skipAutoSave: true });
  };
  const confirmCloseWithSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const success = await onSave(code, data);
      if (success) {
        savedDataRef.current = JSON.stringify(data);
        setCloseDialog(false);
        onClose({ skipAutoSave: true });
      }
    } finally {
      setSaving(false);
    }
  };
  const jump = () => {
    const target = parseCode(jumpText);
    if (target == null || !codes.includes(target)) {
      setFindTip('无此字');
      window.setTimeout(() => setFindTip(''), 1400);
      return;
    }
    setFindTip('');
    onJump(target, data);
  };
  const jumpPreviewChar = (char: string) => {
    const target = char.codePointAt(0);
    if (target == null || char === '\n' || char === '\r') return;
    if (!codes.includes(target)) {
      setFindTip('无此字');
      window.setTimeout(() => setFindTip(''), 1400);
      return;
    }
    setFindTip('');
    void onJump(target, data);
  };
  const renderPreviewText = () => previewText.split('\n').map((line, lineIndex) => (
    <div key={`line-${lineIndex}`} style={styles.previewLine}>
      {Array.from(line || ' ').map((char, charIndex) => (
        char === ' '
          ? <span key={`${lineIndex}-${charIndex}`} style={{ ...styles.previewGlyph, width: Math.max(18, previewSize * 0.36) }}>&nbsp;</span>
          : <button
              key={`${lineIndex}-${charIndex}-${char}`}
              style={{ ...styles.previewGlyph, fontSize: previewSize, fontFamily: previewFontFace ? `"${previewFontFace}", "${family}", serif` : `"${family}", serif` }}
              title={`${char} U+${(char.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0')}`}
              onClick={() => jumpPreviewChar(char)}
            >
              {char}
            </button>
      ))}
    </div>
  ));

  const boardW = advance * scale, boardH = fontHeight * scale;
  const boardX = toCanvas(0, top).x, boardY = toCanvas(0, top).y;
  const currentCodeIndex = codes.indexOf(code);
  const canNavigatePrevious = currentCodeIndex > 0;
  const canNavigateNext = currentCodeIndex >= 0 && currentCodeIndex < codes.length - 1;

  return (
    <div ref={editorRootRef} style={styles.backdrop}>
      <div style={styles.dialog}>
        {!floatingCompact && <header style={styles.header}><h3 style={styles.title}>{title}</h3><div style={styles.headerActions}><button style={styles.primaryButton} disabled={saving} onClick={handleSave}>{saving ? '保存中...' : '保存 Ctrl+S'}</button><button style={styles.secondaryButton} onClick={requestClose}>关闭 Ctrl+W</button></div></header>}
        {!floatingCompact && <div style={styles.toolbar}>
          <button style={mode === 'block' ? styles.activeTool : styles.toolButton} onClick={() => setMode('block')}>块状拖动</button><button style={mode === 'edit' ? styles.activeTool : styles.toolButton} onClick={() => setMode('edit')}>锚点编辑</button>
          {(['select', 'brush', 'eraser'] as Tool[]).map(t => <button key={t} disabled={mode !== 'edit'} style={tool === t && mode === 'edit' ? styles.activeTool : styles.toolButton} onClick={() => { setMode('edit'); setTool(t); }}>{toolNames[t]}</button>)}
          <button title="撤销 Ctrl+Z" disabled={!undo.length} style={!undo.length ? styles.iconToolDisabled : styles.iconTool} onClick={undoLast}><i className="ri-arrow-go-back-line" /></button><button title="反撤销 Ctrl+Shift+Z" disabled={!redo.length} style={!redo.length ? styles.iconToolDisabled : styles.iconTool} onClick={redoLast}><i className="ri-arrow-go-forward-line" /></button><button title="删除选中(Del)" style={selected.length || selectedContours.length || selectedContour != null ? styles.iconTool : styles.iconToolDisabled} onClick={() => { if (!(selected.length || selectedContours.length || selectedContour != null)) { return; } deleteSelected(); }}><i className="ri-delete-back-fill" /></button><button title="剪切 Ctrl+X" disabled={!contours.length} style={!contours.length ? styles.iconToolDisabled : styles.iconTool} onClick={() => void cutSelection()}><i className="ri-scissors-cut-line" /></button><button title="复制 Ctrl+C" disabled={!contours.length} style={!contours.length ? styles.iconToolDisabled : styles.iconTool} onClick={() => void copySelection()}><i className="ri-file-copy-line" /></button><button title={hasGlyphClipboard ? '粘贴 Ctrl+V' : '粘贴 Ctrl+V（支持外部图片/SVG）'} style={styles.iconTool} onClick={() => void pasteSelection()}><i className="ri-clipboard-line" /></button><button title="导入字形 Ctrl+I" style={styles.iconTool} onClick={importGlyph}><i className="ri-import-fill" /></button><button title="导出字形 Ctrl+E" style={styles.iconTool} onClick={() => void onExport(code, data)}><i className="ri-export-fill" /></button><button title="清空全字形" style={styles.iconTool} onClick={clearGlyph}><i className="ri-delete-bin-5-fill" /></button>
          <span style={styles.shapeGroup}><button title="方形" style={pendingShape?.kind === 'square' ? styles.iconToolActive : styles.iconTool} onClick={() => addShape('square')}><i className="zi zi_squarefull" /></button><button title="圆形" style={pendingShape?.kind === 'circle' ? styles.iconToolActive : styles.iconTool} onClick={() => addShape('circle')}><i className="ri-checkbox-blank-circle-fill" /></button><span style={styles.polygonPicker}><button title="多边形" style={pendingShape?.kind === 'polygon' || showPolygonSides ? styles.iconToolActive : styles.iconTool} onClick={() => addShape('polygon')}><i className="ri-settings-6-fill" /></button>{showPolygonSides && <span style={styles.polygonMenu}>{[3, 4, 5, 6, 7, 8, 10, 12].map(sides => <button key={sides} style={styles.polygonOption} onClick={() => choosePolygonSides(sides)}>{sides} 边</button>)}</span>}</span><button title="自由绘画" style={styles.iconTool} onClick={() => addShape('free')}><i className="zi zi_paintbrush" data-zico="笔刷" /></button><button title="大刷：强力抹除" style={tool === 'bigBrush' && mode === 'edit' ? styles.iconToolActive : styles.iconTool} onClick={() => { setMode('edit'); setTool('bigBrush'); setPendingShape(null); setShowPolygonSides(false); }}><i className="ri-brush-2-fill" /></button></span>
          {tool === 'bigBrush' && mode === 'edit' && <span style={styles.brushSizeGroup}><label style={styles.inline}>大刷</label><input type="range" min={18} max={260} step={2} value={bigBrushSize} onChange={event => setBigBrushSize(Number(event.target.value))} /><input style={styles.brushSizeInput} value={bigBrushSize} onChange={event => setBigBrushSize(clamp(Number(event.target.value) || 18, 18, 260))} /></span>}
          <button title="色盘" style={showColorDock ? styles.activeTool : styles.toolButton} onClick={() => setShowColorDock(value => { if (value) setPaintMode(false); return !value; })}>🎨</button>{showColorDock && <button title="着色工具" style={paintMode ? styles.activeTool : styles.toolButton} onClick={() => { setPaintMode(value => !value); setMode('block'); }}>🔫</button>}<button title="制版器 F8" style={showPreviewDock ? styles.iconToolActive : styles.iconTool} onClick={() => setShowPreviewDock(value => !value)}><i className="ri-merge-cells-horizontal" /></button><button title="轮廓翻转" disabled={!(selected.length || selectedContours.length || selectedContour != null)} style={selected.length || selectedContours.length || selectedContour != null ? styles.iconTool : styles.iconToolDisabled} onClick={() => invertContourFill()}><i className="ri-ink-bottle-line" /></button><button style={styles.toolButton} onClick={() => flipGlyph('horizontal')}>水平翻转</button><button style={styles.toolButton} onClick={() => flipGlyph('vertical')}>垂直翻转</button><button style={styles.toolButton} onClick={() => setShowFill(!showFill)}>{showFill ? '轮廓视图' : '填充视图'}</button><button style={showRulers ? styles.activeTool : styles.toolButton} onClick={() => setShowRulers(!showRulers)}>标尺 Ctrl+R</button>
          <span style={styles.findGroup}>
            <input id="glyph-jump-input" value={findTip || jumpText} onChange={e => { setFindTip(''); setJumpText(e.target.value); }} onFocus={() => findTip && setFindTip('')} onKeyDown={e => { if (e.key === 'Enter') jump(); }} placeholder="" style={{ ...styles.findInput, ...(findTip ? styles.findInputTip : {}) }} />
            <button style={styles.findButton} onClick={jump}>找字</button>
          </span>
          <label style={styles.inline}>缩放</label><input type="range" min={0.3} max={4} step={0.1} value={zoom} onChange={event => setZoom(clampZoom(Number(event.target.value)))} /><span>{Math.round(zoom * 100)}%</span>
          <label style={styles.inline}>字宽</label><input style={styles.numberInput} value={advance} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) { setAdvance(value); setAdvanceModified(true); } }} /><button style={!guideLocked ? styles.activeTool : styles.toolButton} onClick={() => setGuideLocked(!guideLocked)}>{guideLocked ? '参考线锁定' : '参考线可拖动'}</button><span style={styles.navigationTools}><button title="上一个字符 Alt+左方向键" aria-label="上一个字符" disabled={!canNavigatePrevious} style={!canNavigatePrevious ? styles.iconToolDisabled : styles.iconTool} onClick={() => onNavigate(-1, data)}><i className="ri-arrow-left-long-fill" /></button><button title="下一个字符 Alt+右方向键" aria-label="下一个字符" disabled={!canNavigateNext} style={!canNavigateNext ? styles.iconToolDisabled : styles.iconTool} onClick={() => onNavigate(1, data)}><i className="ri-arrow-right-long-line" /></button></span><span style={styles.status}>模式 {mode === 'block' ? '块状' : '锚点'} | 轮廓 {contours.length} | 锚点 {contours.flat().length} | 已选 {selected.length}{importStatus ? ` | ${importStatus}` : ''}</span>
        </div>}
        {!floatingCompact && tabsSlot}
        <div ref={workspaceRef} style={{ ...styles.workspace, justifyContent: sideCollapsed ? 'flex-start' : 'center' }}>
          {externalPasteBusy && <div style={styles.externalPasteOverlay}>外部粘贴解算中...</div>}
          <div style={{ ...styles.dock, left: dockPx.x, top: dockPx.y }} onMouseDown={event => event.stopPropagation()}>
            <div style={styles.dockTitle} onMouseDown={event => setDockDrag({ x: event.clientX, y: event.clientY, startX: dockPx.x, startY: dockPx.y })}>属性</div>
            <div style={styles.dockTools}><button title="方形" style={pendingShape?.kind === 'square' ? styles.dockButtonActive : styles.dockButton} onClick={() => addShape('square')}><i className="zi zi_squarefull" /></button><button title="圆形" style={pendingShape?.kind === 'circle' ? styles.dockButtonActive : styles.dockButton} onClick={() => addShape('circle')}><i className="ri-checkbox-blank-circle-fill" /></button><button title="多边形" style={pendingShape?.kind === 'polygon' ? styles.dockButtonActive : styles.dockButton} onClick={() => addShape('polygon')}><i className="ri-settings-6-fill" /></button><button title="自由绘画" style={styles.dockButton} onClick={() => addShape('free')}><i className="zi zi_paintbrush" data-zico="笔刷" /></button><button title="大刷：强力抹除" style={tool === 'bigBrush' && mode === 'edit' ? styles.dockButtonActive : styles.dockButton} onClick={() => { setMode('edit'); setTool('bigBrush'); setPendingShape(null); setShowPolygonSides(false); }}><i className="ri-brush-2-fill" /></button></div>
            <div style={styles.propertyField}>
              <label style={styles.propertyLabel}>大刷笔触</label>
              <input type="range" min={18} max={260} step={2} value={bigBrushSize} onChange={event => setBigBrushSize(Number(event.target.value))} />
            </div>
            <div style={styles.propertyField}>
              <label htmlFor={`glyph-advance-${code}`} style={styles.propertyLabel}>字宽设定</label>
              <input
                id={`glyph-advance-${code}`}
                type="number"
                min={0}
                step={1}
                value={advanceDraft}
                style={styles.propertyInput}
                onChange={event => setAdvanceDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    commitAdvanceDraft();
                  }
                  if (event.key === 'Escape') {
                    setAdvanceDraft(String(advance));
                    event.currentTarget.blur();
                  }
                }}
                onBlur={() => setAdvanceDraft(String(advance))}
              />
            </div>
          </div>
          {showColorDock && <div style={{ ...styles.colorDock, left: colorDockPx.x, top: colorDockPx.y }} onMouseDown={event => event.stopPropagation()}>
            <div style={styles.dockTitle} onMouseDown={event => setColorDockDrag({ x: event.clientX, y: event.clientY, startX: colorDockPx.x, startY: colorDockPx.y })}>🎨 色盘</div>
            <div style={styles.colorGrid}>
              {['#111111', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#5e35b1', '#8e24aa', '#6d4c41', '#ffffff', '#9e9e9e'].map(color => (
                <button key={color} title={color} style={{ ...styles.colorSwatch, background: color, outline: activeColor === color ? `2px solid ${COLORS.ACCENT}` : 'none' }} onClick={() => setActiveColor(color)} />
              ))}
            </div>
            <div style={styles.colorCustom}><input type="color" value={activeColor} onChange={event => setActiveColor(event.target.value)} /><span>{activeColor}</span></div>
            <button style={paintMode ? styles.activeTool : styles.toolButton} onClick={() => { setPaintMode(value => !value); setMode('block'); }}>🔫 着色工具</button>
          </div>}
          {!floatingCompact && <aside style={sideCollapsed ? styles.sidePanelCollapsed : styles.sidePanel}>
            <button
              type="button"
              title={sideCollapsed ? '展开设计器左bar' : '收起设计器左bar'}
              style={styles.sideToggle}
              onClick={() => {
                const next = !sideCollapsed;
                setSideCollapsed(next);
                void window.electronAPI.setEditorState('glyphEditor.leftBarCollapsed', String(next));
              }}
            >
              <i className={sideCollapsed ? 'ri-arrow-right-s-line' : 'ri-arrow-left-s-line'} />
            </button>
            {!sideCollapsed && <>
              <div style={styles.previewChar}>{String.fromCodePoint(code)}</div>
              <div style={styles.codeLabel}>U+{code.toString(16).toUpperCase().padStart(4, '0')}</div>
              <div style={styles.propertyStack}>
                <label style={styles.propertyGroupLabel}>字宽</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={advanceDraft}
                  style={styles.propertyGroupInput}
                  onChange={event => setAdvanceDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') commitAdvanceDraft();
                    if (event.key === 'Escape') setAdvanceDraft(String(advance));
                  }}
                  onBlur={commitAdvanceDraft}
                />
                <label style={styles.propertyGroupLabel}>字码点</label>
                <input
                  value={codeDraft}
                  style={styles.propertyGroupInput}
                  onChange={event => setCodeDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void commitCodeDraft();
                    if (event.key === 'Escape') setCodeDraft(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
                  }}
                  onBlur={() => void commitCodeDraft()}
                />
                {propertyTip && <div style={styles.propertyTip}>{propertyTip}</div>}
                <label style={styles.propertyGroupLabel}>字符名</label>
                <input
                  value={glyphNameDraft}
                  style={styles.propertyGroupInput}
                  onChange={event => setGlyphNameDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') commitGlyphNameDraft();
                    if (event.key === 'Escape') setGlyphNameDraft(glyphName);
                  }}
                  onBlur={commitGlyphNameDraft}
                />
                <label style={styles.propertyGroupLabel}>元素离左</label>
                <input
                  type="number"
                  step={1}
                  value={leftBearingDraft}
                  style={styles.propertyGroupInput}
                  onChange={event => setLeftBearingDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') commitLeftBearingDraft();
                    if (event.key === 'Escape') setLeftBearingDraft(String(leftSideBearing));
                  }}
                  onBlur={commitLeftBearingDraft}
                />
                <label style={{ ...styles.propertyGroupLabel, ...styles.propertyGroupLast }}>元素离右</label>
                <input
                  type="number"
                  step={1}
                  value={rightBearingDraft}
                  style={{ ...styles.propertyGroupInput, ...styles.propertyGroupLast }}
                  onChange={event => setRightBearingDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') commitRightBearingDraft();
                    if (event.key === 'Escape') setRightBearingDraft(String(rightSideBearing));
                  }}
                  onBlur={commitRightBearingDraft}
                />
              </div>
              <WikiTips scope="glyphEditor" style={styles.leftBarHint} />
            </>}
          </aside>}
        <Stage ref={stageRef} width={stageW} height={stageH} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onDblClick={handleDoubleClick} onDragStart={(e: any) => e.evt?.preventDefault?.()} onMouseLeave={() => { const container = stageRef.current?.container?.(); if (container && !dragGlyphStart) container.style.cursor = 'default'; setHoverGuide(null); if (guideDrag) setGuideDrag(null); }} onWheel={(e: any) => { if (!e.evt.ctrlKey) return; e.evt.preventDefault(); setZoom(z => clampZoom(z + (e.evt.deltaY < 0 ? 0.1 : -0.1))); }} onContextMenu={(e: any) => { e.evt.preventDefault(); const pos = pointer(); const hit = hitPoint(pos.x, pos.y); const segment = mode === 'edit' && !hit ? hitSegment(pos.x, pos.y) : null; const contourIndex = mode === 'edit' ? hit?.[0] ?? segment?.[0] ?? selectedContour : hitContour(pos.x, pos.y) ?? selectedContour; if (mode === 'block' && contourIndex != null && !selectedContours.includes(contourIndex)) { setSelectedContour(contourIndex); setSelectedContours([contourIndex]); } setMenu({ x: e.evt.clientX, y: e.evt.clientY, hit, segment, contourIndex, fontPoint: toFont(pos.x, pos.y) }); }}>
            <Layer>
              <Rect width={stageW} height={stageH} fill="#d9dee7" />
              {showRulers && <Group>
                <Rect x={0} y={0} width={stageW} height={24} fill="#f7f9fc" stroke="#b8c3d1" />
                <Rect x={0} y={0} width={34} height={stageH} fill="#f7f9fc" stroke="#b8c3d1" />
                {Array.from({ length: Math.ceil(stageW / 50) + 1 }).map((_v, i) => {
                  const x = i * 50;
                  return <Group key={`rx${i}`}><Line points={[x, 18, x, 24]} stroke="#6f7d8d" strokeWidth={1} /><Text x={x + 2} y={3} text={String(Math.round((x - ox) / scale))} fontSize={9} fill="#526174" /></Group>;
                })}
                {Array.from({ length: Math.ceil(stageH / 50) + 1 }).map((_v, i) => {
                  const y = i * 50;
                  return <Group key={`ry${i}`}><Line points={[28, y, 34, y]} stroke="#6f7d8d" strokeWidth={1} /><Text x={2} y={y + 2} text={String(Math.round(top - (y - oy) / scale))} fontSize={9} fill="#526174" /></Group>;
                })}
              </Group>}
              <Rect x={boardX - 24} y={boardY - 24} width={boardW + 48} height={boardH + 48} fill="#eef2f7" shadowColor="rgba(20,30,50,.22)" shadowBlur={18} shadowOffset={{ x: 0, y: 8 }} />
              <Rect x={boardX} y={boardY} width={boardW} height={boardH} fill="#fafafa" stroke="#b7c4d4" strokeWidth={1.5} />
              {Array.from({ length: Math.ceil(stageW / 50) }).map((_v, i) => <Line key={`gx${i}`} points={[i * 50, 0, i * 50, stageH]} stroke="#cbd3df" strokeWidth={1} />)}{Array.from({ length: Math.ceil(stageH / 50) }).map((_v, i) => <Line key={`gy${i}`} points={[0, i * 50, stageW, i * 50]} stroke="#cbd3df" strokeWidth={1} />)}
              <Rect x={boardX} y={boardY} width={boardW} height={boardH} stroke={COLORS.EM_BOX} dash={[6, 4]} /><Line points={[toCanvas(0, 0).x, toCanvas(0, 0).y, toCanvas(advance, 0).x, toCanvas(advance, 0).y]} stroke={COLORS.BASELINE} strokeWidth={2} dash={[4, 3]} /><Text x={toCanvas(0, 0).x + 6} y={toCanvas(0, 0).y - 18} text="baseline" fontSize={11} fill={COLORS.BASELINE} /><Line points={[toCanvas(advance, top).x, toCanvas(advance, top).y, toCanvas(advance, bottom).x, toCanvas(advance, bottom).y]} stroke="#ff7a00" strokeWidth={2} dash={[4, 4]} />
              {(refFontMode === 'background' || (refFontMode === 'empty' && contours.length === 0)) && refFont && (
                <Text text={String.fromCodePoint(code)} x={boardX} y={boardY} width={boardW} height={boardH} fontSize={boardH * 0.72} fontFamily={refFont} fill="rgba(0,0,0,0.10)" align="center" verticalAlign="middle" listening={false} />
              )}
            </Layer>
            <Layer>
              {showFill
                ? glyphPathGroups.map(group => <Path key={`fill-${group.color}`} data={group.data} fill={group.color} stroke={COLORS.OUTLINE} strokeWidth={0.8} fillRule="nonzero" />)
                : glyphPathData && <Path data={glyphPathData} fill={undefined} stroke={COLORS.OUTLINE} strokeWidth={2} fillRule="nonzero" />}
              {erasePathData && <Path data={erasePathData} fill="#000" stroke={undefined} strokeWidth={0} fillRule="nonzero" globalCompositeOperation="destination-out" listening={false} />}
              {refFontMode === 'overlay' && refFont && contours.length > 0 && (
                <Text text={String.fromCodePoint(code)} x={boardX} y={boardY} width={boardW} height={boardH} fontSize={boardH * 0.72} fontFamily={refFont} fill="rgba(0,0,0,0.10)" align="center" verticalAlign="middle" listening={false} />
              )}
              {mode === 'edit' && handleLines.map(line => <Line key={line.key} points={line.points} stroke="#7b8794" strokeWidth={1} dash={[3, 3]} />)}
              {mode === 'edit' && contours.map((contour, ci) => <Group key={ci}>{!showFill && contour.length >= 2 && <Line points={contourToCanvasPoints(contour)} closed stroke={COLORS.OUTLINE} strokeWidth={1} />}{contour.map((p, pi) => { const c = toCanvas(p.x, p.y); const isSelected = selectedSet.has(`${ci}:${pi}`); return p.on === false ? <Circle key={pi} x={c.x} y={c.y} radius={isSelected ? 7 : 5} fill="#fff" stroke={isSelected ? '#e34b4b' : COLORS.OFF_POINT} strokeWidth={2} onDblClick={() => togglePoint(ci, pi)} /> : <Rect key={pi} x={c.x - (isSelected ? 6 : 4)} y={c.y - (isSelected ? 6 : 4)} width={isSelected ? 12 : 8} height={isSelected ? 12 : 8} fill={isSelected ? '#e34b4b' : COLORS.ON_POINT} stroke="#fff" strokeWidth={1} onDblClick={() => togglePoint(ci, pi)} />; })}</Group>)}
              {mode === 'block' && selectedBox && (() => { const b = canvasBox(selectedBox); return <Group><Rect x={b.x} y={b.y} width={b.width} height={b.height} stroke="#2b87f0" strokeWidth={1.5} dash={[6, 4]} /><Rect x={b.x} y={b.y} width={b.width} height={b.height} fill="rgba(43,135,240,.035)" /></Group>; })()}
              {mode === 'block' && selectedBox && transformHandles.map(handle => <Rect key={handle.id} x={handle.x - 5} y={handle.y - 5} width={10} height={10} fill="#fff" stroke="#2b87f0" strokeWidth={1.5} />)}
              {shapeDraftBox && pendingShape?.kind === 'square' && <Rect x={shapeDraftBox.x} y={shapeDraftBox.y} width={shapeDraftBox.width} height={shapeDraftBox.height} fill="rgba(43,135,240,.12)" stroke="#2b87f0" strokeWidth={1.5} dash={[6, 4]} />}
              {shapeDraftBox && pendingShape?.kind === 'circle' && <Ellipse x={shapeDraftBox.x + shapeDraftBox.width / 2} y={shapeDraftBox.y + shapeDraftBox.height / 2} radiusX={shapeDraftBox.width / 2} radiusY={shapeDraftBox.height / 2} fill="rgba(43,135,240,.12)" stroke="#2b87f0" strokeWidth={1.5} dash={[6, 4]} />}
              {shapeDraftBox && pendingShape?.kind === 'polygon' && <Line points={polygonDraftPoints} closed fill="rgba(43,135,240,.12)" stroke="#2b87f0" strokeWidth={1.5} dash={[6, 4]} />}
              {brushContour && brushContour.length > 1 && <Line points={contourToCanvasPoints(brushContour)} stroke="#21a366" strokeWidth={2} dash={[4, 3]} />}
              {bigBrushPath && bigBrushPath.length > 0 && <Group>{bigBrushPath.map((point, index) => { const c = toCanvas(point.x, point.y); return <Circle key={index} x={c.x} y={c.y} radius={Math.max(4, bigBrushSize * scale / 2)} fill="rgba(255,255,255,.55)" stroke="#d23f31" strokeWidth={1.2} dash={[5, 3]} />; })}{bigBrushPath.length > 1 && <Line points={contourToCanvasPoints(bigBrushPath)} stroke="#d23f31" strokeWidth={1.2} dash={[4, 3]} />}</Group>}
              {selectBox && <Rect x={Math.min(selectBox.x1, selectBox.x2)} y={Math.min(selectBox.y1, selectBox.y2)} width={Math.abs(selectBox.x2 - selectBox.x1)} height={Math.abs(selectBox.y2 - selectBox.y1)} fill="rgba(43,135,240,.18)" stroke={COLORS.ACCENT} dash={[4, 3]} />}
              {guides.vertical.map((value, index) => { const x = toCanvas(value, 0).x; return <Line key={`gv${index}`} points={[x, 0, x, stageH]} stroke="#ff8a8a" strokeWidth={1.5} dash={[8, 4]} />; })}
              {guides.horizontal.map((value, index) => { const y = toCanvas(0, value).y; return <Line key={`gh${index}`} points={[0, y, stageW, y]} stroke="#ff8a8a" strokeWidth={1.5} dash={[8, 4]} />; })}
              {guideDraft?.axis === 'vertical' && <Line points={[guideDraft.canvasValue, 0, guideDraft.canvasValue, stageH]} stroke="#ff6f6f" strokeWidth={1.5} dash={[6, 4]} />}
              {guideDraft?.axis === 'horizontal' && <Line points={[0, guideDraft.canvasValue, stageW, guideDraft.canvasValue]} stroke="#ff6f6f" strokeWidth={1.5} dash={[6, 4]} />}
              {hoverGuide && !guideLocked && <Text x={hoverGuide.axis === 'vertical' ? hoverGuide.canvasValue + 8 : 42} y={hoverGuide.axis === 'vertical' ? 30 : hoverGuide.canvasValue + 8} text="拖动参考线" fontSize={12} fill="#d95f5f" />}
            </Layer>
          </Stage>
          {!floatingCompact && (
            <button
              type="button"
              title="双击恢复 100%"
              style={{ ...styles.zoomBadge, left: leftBarWidth + 36 }}
              onDoubleClick={() => setZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
          )}
          {showPreviewDock && (
            <div style={{ ...styles.previewDock, left: previewRect.left, top: previewRect.top, width: previewRect.width, height: previewRect.height }} onMouseDown={event => event.stopPropagation()}>
              <div style={styles.previewDockTitle} onMouseDown={event => setPreviewDrag({ x: event.clientX, y: event.clientY, rect: previewRect })}>
                <span>制版器</span>
                <button style={styles.previewClose} title="关闭 F8" onClick={() => setShowPreviewDock(false)}>×</button>
              </div>
              <div style={styles.previewControls}>
                <select style={styles.previewSelect} defaultValue="Auto"><option>自动</option><option>Left</option><option>Center</option></select>
                <select style={styles.previewSelect} defaultValue="Custom"><option>Custom</option><option>Latin</option><option>CJK</option></select>
                <label style={styles.previewLabel}>字号</label>
                <input style={styles.previewNumber} type="number" min={16} max={240} value={previewSize} onChange={event => setPreviewSize(clamp(Number(event.target.value) || 96, 16, 240))} />
                <div style={styles.previewInputGroup}>
                  <textarea style={styles.previewInput} value={previewText} onChange={event => setPreviewText(event.target.value)} />
                  <button style={styles.previewSampleButton} title="试字群组" onClick={() => setShowPreviewSamples(value => !value)}><i className="ri-arrow-down-s-fill" /></button>
                  {showPreviewSamples && (
                    <div style={styles.previewSampleMenu}>
                      {previewSamples.map((sample, index) => (
                        <button
                          key={`${index}-${sample}`}
                          style={styles.previewSampleItem}
                          title={sample}
                          onClick={() => {
                            setPreviewText(sample);
                            setShowPreviewSamples(false);
                          }}
                        >{sample}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div style={styles.previewBody}>
                <aside style={styles.previewFeatureList}>
                  {['_shaper', 'aalt', 'ccmp', 'cpsp', 'dlig', 'frac', 'liga', 'nalt', 'ordn', 'vert'].map(item => (
                    <label key={item} style={styles.previewFeature}><input type="checkbox" />{item}</label>
                  ))}
                </aside>
                <div style={{ ...styles.previewOutput, lineHeight: `${Math.round(previewSize * 1.35)}px` }}>
                  {renderPreviewText()}
                </div>
              </div>
              {['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].map(edge => (
                <span
                  key={edge}
                  style={{ ...styles.previewResizeHandle, ...previewResizeHandleStyle(edge) }}
                  onMouseDown={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    setPreviewResize({ edge, x: event.clientX, y: event.clientY, rect: previewRect });
                  }}
                />
              ))}
            </div>
          )}
        </div>
        {menu && <div style={{ ...styles.contextMenu, left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
          {menu.hit && <><button style={styles.menuItem} onClick={() => { const [ci, pi] = menu.hit!; deletePoint(ci, pi); setMenu(null); }}>删除锚点</button><button style={styles.menuItem} onClick={() => { const [ci, pi] = menu.hit!; insertAfter(ci, pi); setMenu(null); }}>增加锚点</button></>}
          {!menu.hit && menu.segment && <button style={styles.menuItem} onClick={() => { const [ci, pi] = menu.segment!; insertAfter(ci, pi, menu.fontPoint); setMenu(null); }}>增加锚点</button>}
          <button style={styles.menuItem} onClick={invertMenuContourFill}>轮廓翻转</button><button style={styles.menuItem} onClick={() => { rotateGlyph(-15); setMenu(null); }}>左旋 15°</button><button style={styles.menuItem} onClick={() => { rotateGlyph(15); setMenu(null); }}>右旋 15°</button><button style={styles.menuItem} onClick={() => { flipGlyph('horizontal'); setMenu(null); }}>水平翻转</button><button style={styles.menuItem} onClick={() => { flipGlyph('vertical'); setMenu(null); }}>垂直翻转</button><button style={styles.menuItemDanger} onClick={() => { clearGlyph(); setMenu(null); }}>清空全字形</button>
        </div>}
        {saveDialog && <div style={styles.saveDialogBackdrop} onClick={() => setSaveDialog(false)}>
          <div style={styles.saveDialog} onClick={event => event.stopPropagation()}>
            <div style={styles.saveDialogTitle}>保存成功</div>
            <div style={styles.saveDialogActions}>
              <button autoFocus style={styles.primaryButton} onClick={() => setSaveDialog(false)}>确认</button>
              <button style={styles.secondaryButton} onClick={() => { setSaveDialog(false); void onNavigate(1, data); }}>下个字形</button>
            </div>
          </div>
        </div>}
        {closeDialog && <div style={styles.saveDialogBackdrop} onClick={() => setCloseDialog(false)}>
          <div style={styles.saveDialog} onClick={event => event.stopPropagation()}>
            <div style={styles.saveDialogTitle}>当前字形已有设计成果，是否保存？</div>
            <div style={styles.saveDialogActions}>
              <button autoFocus disabled={saving} style={styles.primaryButton} onClick={() => void confirmCloseWithSave()}>{saving ? '保存中...' : '确认'}</button>
              <button style={styles.secondaryButton} onClick={() => { setCloseDialog(false); onClose({ skipAutoSave: true }); }}>不保存</button>
              <button style={styles.secondaryButton} onClick={() => setCloseDialog(false)}>取消</button>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
};

const toolNames: Record<Tool, string> = { select: '选择(v)', brush: '画笔(b)', eraser: '橡皮(e)', bigBrush: '大刷' };
const styles: Record<string, React.CSSProperties> = {
  iconToolDisabled: { width: 30, height: 30, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#f3f5f7', color: '#aeb6c1', cursor: 'not-allowed', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 },
  navigationTools: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 },
  status: { color: COLORS.TEXT_LIGHT, fontSize: 13, whiteSpace: 'nowrap' },
  propertyField: { display: 'flex', flexDirection: 'column', gap: 5, padding: '0 8px 9px' },
  propertyLabel: { color: COLORS.TEXT_LIGHT, fontSize: 12 },
  propertyInput: { width: '100%', boxSizing: 'border-box', padding: '6px 7px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT },
  propertyInputReadonly: { width: '100%', boxSizing: 'border-box', padding: '6px 7px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#f5f7fa', color: COLORS.TEXT_LIGHT, fontFamily: UI_FONT },
  propertyTip: { color: '#b42318', fontSize: 12, lineHeight: 1.3, gridColumn: '1 / -1', padding: '0 2px' },
  propertyStack: { display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: 0, marginTop: 12, border: '1px solid #aeb6c1', borderRadius: 4, overflow: 'hidden', background: '#eef1f4' },
  propertyGroupLabel: { minHeight: 32, padding: '0 8px', borderRight: '1px solid #aeb6c1', borderBottom: '1px solid #cfd6df', background: '#eef1f4', color: COLORS.TEXT_LIGHT, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', boxSizing: 'border-box' },
  propertyGroupInput: { width: '100%', minWidth: 0, height: 32, boxSizing: 'border-box', padding: '0 8px', border: 0, borderBottom: '1px solid #cfd6df', outline: 'none', background: '#f7f8fa', color: COLORS.TEXT, fontFamily: UI_FONT, fontSize: 13 },
  propertyGroupLast: { borderBottom: 0 },
  codeLabel: { color: COLORS.TEXT_LIGHT, fontSize: 12, textAlign: 'center' },
  sidePanelCollapsed: { width: SIDE_COLLAPSED_W, padding: '10px 6px', borderRight: `1px solid ${COLORS.BORDER}`, background: '#fff', color: COLORS.TEXT, flexShrink: 0, display: 'flex', justifyContent: 'center', position: 'relative' },
  sideToggle: { position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)', width: 20, height: 42, border: 0, borderRadius: 0, background: 'transparent', color: COLORS.TEXT_LIGHT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, padding: 0 },
  leftBarHint: { marginTop: 'auto', paddingTop: 12, color: COLORS.TEXT_LIGHT, fontSize: 12, lineHeight: 1.7 },
  zoomBadge: { position: 'absolute', bottom: 3, zIndex: 90, minWidth: 48, height: 26, padding: '0 8px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: 'rgba(255,255,255,.6)', color: COLORS.TEXT, fontFamily: UI_FONT, fontSize: 12, fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 12px rgba(20,36,60,.12)' },
  previewDock: { position: 'absolute', zIndex: 80, background: '#fff', border: '1px solid #cccccc', boxShadow: '0 -8px 28px rgba(20,36,60,.16)', display: 'flex', flexDirection: 'column', overflow: 'visible' },
  previewDockTitle: { height: 24, padding: '0 8px', background: '#D9EAFF', color: COLORS.TEXT, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, cursor: 'move', userSelect: 'none' },
  previewClose: { width: 22, height: 22, border: 0, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', fontSize: 18, lineHeight: 1 },
  previewControls: { minHeight: 36, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', borderBottom: `1px solid ${COLORS.BORDER}`, background: '#f6f8fb' },
  previewSelect: { height: 26, minWidth: 104, border: `1px solid ${COLORS.BORDER}`, background: '#fff', color: COLORS.TEXT, fontSize: 12, fontFamily: UI_FONT },
  previewLabel: { fontSize: 12, color: COLORS.TEXT_LIGHT },
  previewNumber: { width: 64, height: 26, border: `1px solid ${COLORS.BORDER}`, borderRadius: 3, padding: '0 6px', fontFamily: UI_FONT, fontSize: 13 },
  previewInputGroup: { flex: 1, minWidth: 180, height: 28, display: 'flex', alignItems: 'stretch', position: 'relative' },
  previewInput: { flex: 1, height: 26, minWidth: 0, resize: 'none', border: `1px solid ${COLORS.BORDER}`, borderRadius: 3, padding: '3px 30px 3px 7px', fontFamily: UI_FONT, fontSize: 13, lineHeight: 1.25 },
  previewSampleButton: { position: 'absolute', right: 2, top: 1, width: 26, height: 26, border: 0, borderRadius: 0, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 },
  previewSampleMenu: { position: 'absolute', zIndex: 120, top: 31, right: 0, width: 420, maxWidth: '80vw', maxHeight: 220, overflow: 'auto', padding: 5, background: '#fff', border: `1px solid ${COLORS.BORDER}`, boxShadow: '0 8px 24px rgba(20,36,60,.18)', display: 'flex', flexDirection: 'column', gap: 4 },
  previewSampleItem: { padding: '7px 9px', border: 0, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: UI_FONT, fontSize: 13 },
  previewBody: { flex: 1, minHeight: 0, display: 'flex', background: '#fff' },
  previewFeatureList: { width: 198, padding: 7, borderRight: `1px solid ${COLORS.BORDER}`, overflow: 'auto', background: '#f9fbfd', display: 'flex', flexDirection: 'column', gap: 3 },
  previewFeature: { display: 'flex', alignItems: 'center', gap: 5, color: COLORS.TEXT, fontSize: 12, fontFamily: UI_FONT },
  previewOutput: { flex: 1, padding: '24px 28px', overflow: 'auto', background: '#fff', color: '#000', whiteSpace: 'pre-wrap' },
  previewLine: { display: 'block', minHeight: 1 },
  previewGlyph: { display: 'inline-flex', alignItems: 'baseline', justifyContent: 'center', padding: 0, margin: 0, border: 0, background: 'transparent', color: '#000', cursor: 'pointer', lineHeight: 1, verticalAlign: 'baseline' },
  previewResizeHandle: { position: 'absolute', zIndex: 2, background: 'transparent' },
  backdrop: { position: 'absolute', inset: 0, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' },
  dialog: { width: '100%', height: '100%', background: '#fff', borderRadius: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' },
  header: { padding: '10px 14px', borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, position: 'relative', zIndex: 80, background: '#fff', flexShrink: 0 }, title: { margin: 0, color: COLORS.TEXT, fontSize: 18 }, headerActions: { display: 'flex', gap: 8, alignItems: 'center' }, toolbar: { padding: 10, borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', position: 'relative', zIndex: 80, background: '#fff', flexShrink: 0 }, workspace: { flex: 1, display: 'flex', minHeight: 0, width: '100%', height: '100%', background: '#cfd6e2', alignItems: 'stretch', justifyContent: 'center', position: 'relative' }, externalPasteOverlay: { position: 'absolute', inset: 0, zIndex: 2600, background: 'rgba(245,248,252,.72)', color: COLORS.TEXT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: UI_FONT, fontSize: 16, fontWeight: 600, pointerEvents: 'auto' }, sidePanel: { width: SIDE_W, padding: 12, borderRight: `1px solid ${COLORS.BORDER}`, background: '#fff', color: COLORS.TEXT, flexShrink: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', position: 'relative' }, previewChar: { height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 72, border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, marginBottom: 10 }, help: { marginTop: 12, color: COLORS.TEXT_LIGHT, fontSize: 12, lineHeight: 1.7 }, toolButton: { padding: '7px 12px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT }, activeTool: { padding: '7px 12px', border: `1px solid ${COLORS.ACCENT}`, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', fontFamily: UI_FONT }, shapeGroup: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 5px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#f7fbff' }, brushSizeGroup: { height: 32, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 8px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff' }, brushSizeInput: { width: 48, height: 24, border: `1px solid ${COLORS.BORDER}`, borderRadius: 3, padding: '0 4px', fontFamily: UI_FONT, fontSize: 12 }, polygonPicker: { position: 'relative', display: 'inline-flex' }, polygonMenu: { position: 'absolute', zIndex: 100, top: 34, left: 0, width: 132, padding: 6, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, boxShadow: '0 8px 20px rgba(0,0,0,.18)' }, polygonOption: { padding: '6px 4px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 3, background: '#fff', color: COLORS.TEXT, cursor: 'pointer' }, iconTool: { width: 30, height: 30, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }, iconToolActive: { width: 30, height: 30, border: `1px solid ${COLORS.ACCENT}`, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', cursor: 'crosshair', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }, dock: { position: 'absolute', zIndex: 30, width: 188, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, boxShadow: '0 8px 24px rgba(25,40,70,.18)', overflow: 'hidden' }, colorDock: { position: 'absolute', zIndex: 32, width: 188, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, boxShadow: '0 8px 24px rgba(25,40,70,.18)', overflow: 'hidden', paddingBottom: 8, display: 'flex', flexDirection: 'column', gap: 8 }, dockTitle: { padding: '7px 9px', background: '#e3eefb', color: COLORS.TEXT, fontSize: 12, fontWeight: 600, cursor: 'move', userSelect: 'none' }, dockTools: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, padding: 8 }, dockButton: { height: 32, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontSize: 17 }, dockButtonActive: { height: 32, border: `1px solid ${COLORS.ACCENT}`, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', cursor: 'crosshair', fontSize: 17 }, colorGrid: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, padding: '0 8px' }, colorSwatch: { height: 24, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, cursor: 'pointer' }, colorCustom: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', color: COLORS.TEXT_LIGHT, fontSize: 12 }, primaryButton: { padding: '8px 14px', border: 0, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', fontFamily: UI_FONT }, secondaryButton: { padding: '8px 12px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT }, inline: { color: COLORS.TEXT_LIGHT, fontSize: 13 }, numberInput: { width: 80, padding: '6px 8px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4 }, findGroup: { width: 118, height: 32, display: 'inline-flex', alignItems: 'stretch', border: '1px solid #aeb6c1', borderRadius: 16, overflow: 'hidden', background: '#eef1f4', flexShrink: 0 }, findInput: { width: 60, minWidth: 0, border: 0, outline: 'none', padding: '0 8px 0 12px', background: '#f7f8fa', color: COLORS.TEXT, fontFamily: UI_FONT, fontSize: 13 }, findInputTip: { color: '#8c96a3', background: '#f7f8fa' }, findButton: { width: 56, border: 0, borderLeft: '1px solid #aeb6c1', background: '#eef1f4', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 }, contextMenu: { position: 'fixed', zIndex: 2000, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.18)', padding: 5, display: 'flex', flexDirection: 'column', minWidth: 132 }, menuItem: { padding: '7px 10px', border: 0, background: '#fff', textAlign: 'left', cursor: 'pointer', color: COLORS.TEXT }, menuItemDanger: { padding: '7px 10px', border: 0, background: '#fff', textAlign: 'left', cursor: 'pointer', color: '#c62828' }, saveDialogBackdrop: { position: 'absolute', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center' }, saveDialog: { width: 320, padding: 22, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, boxShadow: '0 16px 48px rgba(0,0,0,.28)' }, saveDialogTitle: { color: COLORS.TEXT, fontSize: 18, fontWeight: 600, marginBottom: 20 }, saveDialogActions: { display: 'flex', justifyContent: 'flex-end', gap: 10 },
};

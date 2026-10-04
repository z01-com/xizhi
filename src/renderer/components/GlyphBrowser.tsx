import React, { useEffect, useMemo, useRef, useState } from 'react';
import { COLORS, EXPORT_FORMATS, EXPORT_SIZES, UI_FONT } from '@shared/constants';
import { LoadingOverlay } from './LoadingOverlay';
import { PathTools } from './PathTools';

type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'EPS';

interface GlyphBrowserProps {
  fontPath: string;
  metrics: { upm: number; ascent: number; descent: number; family: string; fontDataUrl?: string };
  codes: number[];
  thumbSize: number;
  onClose: () => void;
  onEdit: (code: number) => void;
  onExport: (codes: number[], format: ExportFormat, size: number, outputDir: string) => Promise<{ success: number; failed: number; outputPath: string }>;
  showToast: (message: string, type: 'info' | 'success' | 'error') => void;
}

type RangeType = 'all' | 'han' | 'latin' | 'other';
type SelectionBox = { x1: number; y1: number; x2: number; y2: number };
type BrowserRecord = { time: string; text: string };

function codeLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function charName(code: number): string {
  const ch = String.fromCodePoint(code);
  if (code < 0x20 || /\s/.test(ch) || /[<>:"/\\|?*]/.test(ch)) return `uni${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return ch;
}

function fileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, '/').replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

function inRange(code: number, range: RangeType): boolean {
  if (range === 'all') return true;
  const isHan = (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff);
  const isLatin = code >= 0x20 && code <= 0x7e;
  if (range === 'han') return isHan;
  if (range === 'latin') return isLatin;
  return !isHan && !isLatin;
}

export const GlyphBrowser: React.FC<GlyphBrowserProps> = ({ fontPath, metrics, codes, thumbSize, onClose, onEdit, onExport, showToast }) => {
  const [previewSize, setPreviewSize] = useState(Math.max(56, Math.min(300, thumbSize)));
  const [range, setRange] = useState<RangeType>('all');
  const [filter, setFilter] = useState('');
  const [pageSize, setPageSize] = useState(2000);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; ctrl: boolean } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('PNG');
  const [exportSize, setExportSize] = useState(1000);
  const [outputDir, setOutputDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [gridLoading, setGridLoading] = useState(false);
  const [records, setRecords] = useState<BrowserRecord[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyValue, setHistoryValue] = useState('');
  const gridRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const fontFace = useMemo(() => `ZoomlaPreview_${Math.abs(fontPath.split('').reduce((s, c) => ((s << 5) - s + c.charCodeAt(0)) | 0, 0))}`, [fontPath]);

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `@font-face{font-family:"${fontFace}";src:url("${metrics.fontDataUrl || fileUrl(fontPath)}");}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [fontFace, fontPath, metrics.fontDataUrl]);

  useEffect(() => {
    Promise.all([
      window.electronAPI.dbGetSetting('exportDir', ''),
      window.electronAPI.dbGetSetting('glyphBrowserHistory', '[]'),
    ]).then(([dir, rawHistory]) => {
      setOutputDir(dir || '');
      try {
        const parsed = JSON.parse(rawHistory);
        if (Array.isArray(parsed)) setHistory(parsed.slice(0, 30));
      } catch {
        setHistory([]);
      }
    });
  }, []);

  const filtered = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return codes.filter(code => {
      if (!inRange(code, range)) return false;
      if (!text) return true;
      return String.fromCodePoint(code).includes(filter) || code.toString(16).toLowerCase().includes(text) || codeLabel(code).toLowerCase().includes(text);
    });
  }, [codes, filter, range]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageCodes = filtered.slice(page * pageSize, (page + 1) * pageSize);

  useEffect(() => setPage(0), [filter, range, pageSize]);
  useEffect(() => setPage(current => Math.min(current, totalPages - 1)), [totalPages]);
  useEffect(() => {
    setGridLoading(true);
    const timer = window.setTimeout(() => setGridLoading(false), Math.min(900, Math.max(180, pageCodes.length / 4)));
    return () => window.clearTimeout(timer);
  }, [previewSize, pageSize, page, filter, range, pageCodes.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'PageDown') {
        event.preventDefault();
        setPage(current => Math.min(current + 1, totalPages - 1));
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        setPage(current => Math.max(current - 1, 0));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalPages]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [page]);

  const PREVIEW_PRESETS = [12, 18, 24, 36, 48, 56, 72, 96, 120, 150, 200, 300];

  // Ctrl + 鼠标滚轮 自由缩放字形预览大小
  useEffect(() => {
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
  }, []);

  const setRecord = (text: string) => {
    setRecords(prev => [{ time: new Date().toLocaleTimeString(), text }, ...prev].slice(0, 80));
  };

  const updateSelected = (next: Set<number>, text?: string) => {
    setSelected(next);
    if (text) setRecord(text);
  };

  const selectSingle = (code: number, index: number, event: React.MouseEvent) => {
    if (event.shiftKey && anchorIndex !== null) {
      const [lo, hi] = [Math.min(anchorIndex, index), Math.max(anchorIndex, index)];
      const next = new Set(selected);
      pageCodes.slice(lo, hi + 1).forEach(item => next.add(item));
      updateSelected(next, `Shift 范围选择 ${hi - lo + 1} 个字形，当前已选 ${next.size} 个`);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected);
      next.has(code) ? next.delete(code) : next.add(code);
      setAnchorIndex(index);
      updateSelected(next, `Ctrl 点选 ${String.fromCodePoint(code)} (${codeLabel(code)})，当前已选 ${next.size} 个`);
      return;
    }
    setAnchorIndex(index);
    updateSelected(new Set([code]), `选择 ${String.fromCodePoint(code)} (${codeLabel(code)})`);
  };

  const selectPage = () => {
    const next = new Set(selected);
    pageCodes.forEach(code => next.add(code));
    updateSelected(next, `本页全选 ${pageCodes.length} 个字形，当前已选 ${next.size} 个`);
  };

  const selectAllFiltered = () => {
    const next = new Set(selected);
    filtered.forEach(code => next.add(code));
    updateSelected(next, `选择当前筛选结果 ${filtered.length} 个字形`);
  };

  const invertPage = () => {
    const next = new Set(selected);
    pageCodes.forEach(code => next.has(code) ? next.delete(code) : next.add(code));
    updateSelected(next, `反选本页，当前已选 ${next.size} 个`);
  };

  const clearSelection = () => updateSelected(new Set(), '清除全部选择');

  const hitTestDrag = (box: SelectionBox, additive: boolean) => {
    const grid = gridRef.current;
    if (!grid) return;
    const lx = Math.min(box.x1, box.x2);
    const hx = Math.max(box.x1, box.x2);
    const ly = Math.min(box.y1, box.y2);
    const hy = Math.max(box.y1, box.y2);
    const next = additive ? new Set(selected) : new Set<number>();
    grid.querySelectorAll<HTMLElement>('[data-code]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.left <= hx && rect.right >= lx && rect.top <= hy && rect.bottom >= ly) {
        next.add(Number(el.dataset.code));
      }
    });
    updateSelected(next, `拖拽框选完成，当前已选 ${next.size} 个`);
  };

  const chooseOutputDir = async () => {
    const dir = await window.electronAPI.openDirectory({ defaultPath: outputDir || undefined });
    if (dir) setOutputDir(dir);
  };

  const exportSelected = async () => {
    if (!selected.size) {
      showToast('请先选择要导出的字形', 'error');
      return;
    }
    let dir = outputDir;
    if (!dir) {
      const picked = await window.electronAPI.openDirectory({});
      if (!picked) return;
      dir = picked;
      setOutputDir(dir);
    }
    setBusy(true);
    try {
      await window.electronAPI.dbSetSetting('exportDir', dir);
      const result = await onExport([...selected].sort((a, b) => a - b), format, exportSize, dir);
      const message = `导出 ${format} ${exportSize}*${exportSize}，成功 ${result.success}，失败 ${result.failed}，目录：${result.outputPath}`;
      const historyItem = `${new Date().toLocaleString()} | ${format} ${exportSize}*${exportSize} | ${selected.size} 个 | ${dir}`;
      const nextHistory = [historyItem, ...history.filter(item => item !== historyItem)].slice(0, 30);
      setHistory(nextHistory);
      setHistoryValue(historyItem);
      await window.electronAPI.dbSetSetting('glyphBrowserHistory', JSON.stringify(nextHistory));
      setRecord(message);
      showToast(`导出完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? 'info' : 'success');
      await window.electronAPI.openPath(dir);
      setExportOpen(false);
    } catch (error: any) {
      showToast(error.message || '导出失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openMenu = (event: React.MouseEvent, code?: number) => {
    event.preventDefault();
    if (code !== undefined && !selected.has(code)) updateSelected(new Set([...selected, code]), `右键加入选择 ${String.fromCodePoint(code)} (${codeLabel(code)})`);
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.dialog} onClick={event => { event.stopPropagation(); setContextMenu(null); if (event.target === event.currentTarget) gridRef.current?.focus(); }}>
        <header style={styles.header}>
          <div style={{ minWidth: 0 }}>
            <h3 style={styles.title}>字形浏览 - {metrics.family}</h3>
            <div style={styles.muted}>{fontPath} | {codes.length} 个字符 | UPM {metrics.upm} | Asc {metrics.ascent} | Desc {metrics.descent}</div>
          </div>
          <button style={styles.secondaryButton} onClick={onClose}>关闭</button>
        </header>

        <div style={styles.toolbar}>
          <label style={styles.label}>预览大小</label>
          <select value={previewSize} onChange={event => setPreviewSize(Number(event.target.value))} style={styles.input}>
            {PREVIEW_PRESETS.map(value => <option key={value} value={value}>{value}px</option>)}
            {!PREVIEW_PRESETS.includes(previewSize) && <option value={previewSize}>{previewSize}px</option>}
          </select>
          <label style={styles.label}>字符集</label>
          <select value={range} onChange={event => setRange(event.target.value as RangeType)} style={styles.input}>
            <option value="all">全部</option>
            <option value="han">中文汉字</option>
            <option value="latin">基本拉丁</option>
            <option value="other">其他</option>
          </select>
          <input value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') setPage(0); }} placeholder="精确筛选：输入文字或 Unicode" style={{ ...styles.input, width: 220 }} />
          <select value={pageSize} onChange={event => setPageSize(Number(event.target.value))} style={styles.input}>
            {[100, 200, 500, 1000, 2000].map(value => <option key={value} value={value}>每页 {value}</option>)}
          </select>
          <button style={styles.secondaryButton} onClick={selectPage}>本页全选</button>
          <button style={styles.secondaryButton} onClick={invertPage}>反选本页</button>
          <button style={styles.secondaryButton} onClick={clearSelection}>清除选择</button>
          <span style={styles.selectedText}>已选 {selected.size}</span>
          <button style={styles.primaryButton} disabled={!selected.size} onClick={() => setExportOpen(true)}>导出所选</button>
        </div>

        <div style={styles.pager}>
          <button style={styles.smallButton} disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
          <span>第 {page + 1} / {totalPages} 页，共 {filtered.length} 个字符</span>
          <button style={styles.smallButton} disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>下一页</button>
        </div>

        <div
          ref={gridRef}
          tabIndex={0}
          style={{ ...styles.grid, gridTemplateColumns: `repeat(auto-fill, minmax(${previewSize + 42}px, ${previewSize + 42}px))` }}
          onContextMenu={openMenu}
          onClick={event => {
            if (event.target === event.currentTarget) gridRef.current?.focus();
          }}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            suppressClickRef.current = false;
            setDragStart({ x: event.clientX, y: event.clientY, ctrl: event.ctrlKey || event.metaKey });
            setSelectionBox({ x1: event.clientX, y1: event.clientY, x2: event.clientX, y2: event.clientY });
          }}
          onPointerMove={event => {
            if (!dragStart) return;
            if (Math.abs(event.clientX - dragStart.x) > 6 || Math.abs(event.clientY - dragStart.y) > 6) suppressClickRef.current = true;
            setSelectionBox({ x1: dragStart.x, y1: dragStart.y, x2: event.clientX, y2: event.clientY });
          }}
          onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (selectionBox && dragStart && suppressClickRef.current) hitTestDrag(selectionBox, dragStart.ctrl);
            setSelectionBox(null);
            setDragStart(null);
          }}
          onPointerCancel={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            setSelectionBox(null);
            setDragStart(null);
          }}
        >
          <LoadingOverlay visible={gridLoading} />
          {pageCodes.map((code, index) => {
            const selectedCell = selected.has(code);
            const char = String.fromCodePoint(code);
            return (
              <button
                key={code}
                data-code={code}
                title={`${char} ${codeLabel(code)} -> ${charName(code)}.${format.toLowerCase()}`}
                style={{
                  ...styles.cell,
                  width: previewSize + 42,
                  height: previewSize + 52,
                  borderColor: selectedCell ? COLORS.ACCENT : COLORS.BORDER,
                  background: selectedCell ? COLORS.SELECT : '#fff',
                }}
                onClick={event => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  selectSingle(code, index, event);
                }}
                onDoubleClick={() => onEdit(code)}
                onContextMenu={event => openMenu(event, code)}
              >
                <span style={{ ...styles.glyph, width: previewSize, height: previewSize, fontSize: Math.max(14, previewSize * 0.72), fontFamily: `"${fontFace}", "${metrics.family}", serif` }}>{char}</span>
                <span style={styles.code}>{codeLabel(code)}</span>
              </button>
            );
          })}
          {selectionBox && <div style={{
            ...styles.selectionBox,
            left: Math.min(selectionBox.x1, selectionBox.x2),
            top: Math.min(selectionBox.y1, selectionBox.y2),
            width: Math.abs(selectionBox.x2 - selectionBox.x1),
            height: Math.abs(selectionBox.y2 - selectionBox.y1),
          }} />}
        </div>

        <div style={styles.footer}>
          <div style={styles.helpTitle}>操作说明</div>
          <div style={styles.helpText}>
            1. 选定 TTF/OTF 字体后点击【字形分析】，弹出大窗口直观展示全部字符 Uni 码；2. 支持鼠标拖拽框选、Ctrl 点选、Shift 范围多选，右键菜单快捷操作；3. 点击【导出所选】选择格式 PNG/JPG/SVG/EPS 与尺寸 200*200 至 1800*1800，批量导出到指定目录；4. 文件名直接采用汉字命名，如 我.png、你.png，特殊字符回退为 uniXXXX，便于检索与后续按文件名合成字体。
          </div>
          <div style={styles.historyPanel}>
            <select value={historyValue} onChange={event => {
              setHistoryValue(event.target.value);
              const parts = event.target.value.split(' | ');
              const dir = parts.slice(3).join(' | ');
              if (dir) setOutputDir(dir);
            }} style={styles.historySelect}>
              <option value="">历史记录：选择上次导出目录/参数</option>
              {history.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <div style={styles.history}>
              {records.length === 0 ? <span style={styles.muted}>本次操作日志显示在这里。</span> : records.map((record, index) => <div key={`${record.time}-${index}`}>[{record.time}] {record.text}</div>)}
            </div>
          </div>
        </div>

        {contextMenu && <div style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }} onClick={event => event.stopPropagation()}>
          <button style={styles.menuItem} onClick={() => { setExportOpen(true); setContextMenu(null); }}>导出所选...</button>
          <button style={styles.menuItem} onClick={() => { selectPage(); setContextMenu(null); }}>本页全选</button>
          <button style={styles.menuItem} onClick={() => { selectAllFiltered(); setContextMenu(null); }}>全部选择（当前筛选）</button>
          <button style={styles.menuItem} onClick={() => { invertPage(); setContextMenu(null); }}>反选（本页）</button>
          <button style={styles.menuItem} onClick={() => { clearSelection(); setContextMenu(null); }}>清除选择</button>
        </div>}

        {exportOpen && <div style={styles.exportBackdrop} onClick={() => setExportOpen(false)}>
          <div style={styles.exportDialog} onClick={event => event.stopPropagation()}>
            <LoadingOverlay visible={busy} />
            <h3 style={styles.exportTitle}>批量导出字形</h3>
            <div style={styles.exportSummary}>已选择 {selected.size} 个字形，文件名将采用字符本身，例如 我.{format.toLowerCase()}。</div>
            <label style={styles.fieldLabel}>导出格式</label>
            <select value={format} onChange={event => setFormat(event.target.value as ExportFormat)} style={styles.fullInput}>
              {(EXPORT_FORMATS as ExportFormat[]).map(value => <option key={value}>{value}</option>)}
            </select>
            <label style={styles.fieldLabel}>文件大小</label>
            <select value={exportSize} onChange={event => setExportSize(Number(event.target.value))} style={styles.fullInput}>
              {EXPORT_SIZES.map(value => <option key={value} value={value}>{value}*{value}</option>)}
            </select>
            <label style={styles.fieldLabel}>目标目录</label>
            <PathTools value={outputDir} placeholder="点击重选导出目录" isDir onBrowse={chooseOutputDir} />
            <div style={styles.exportActions}>
              <button style={styles.secondaryButton} disabled={busy} onClick={() => setExportOpen(false)}>取消</button>
              <button style={styles.primaryButton} disabled={busy} onClick={exportSelected}>{busy ? '导出中...' : '开始导出'}</button>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', left: 0, right: 0, top: 112, bottom: 0, zIndex: 1000, background: COLORS.BG, display: 'flex', alignItems: 'stretch', justifyContent: 'stretch', padding: 0 },
  dialog: { width: '100%', height: '100%', background: '#fff', borderRadius: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', borderTop: `1px solid ${COLORS.BORDER}` },
  header: { padding: '12px 16px', borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  title: { margin: 0, color: COLORS.TEXT, fontSize: 18 },
  muted: { color: COLORS.TEXT_LIGHT, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toolbar: { padding: 10, borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  pager: { padding: 8, borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, color: COLORS.TEXT },
  grid: { flex: 1, overflow: 'auto', padding: '14px 24px 14px 14px', background: '#f5f8fc', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(124px, 124px))', gap: 8, alignContent: 'start', position: 'relative', userSelect: 'none', touchAction: 'none' },
  cell: { boxSizing: 'border-box', border: '2px solid', borderRadius: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: '#000', padding: 6, fontFamily: UI_FONT, userSelect: 'none' },
  glyph: { display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, overflow: 'hidden' },
  code: { marginTop: 5, color: COLORS.TEXT_LIGHT, fontSize: 10 },
  label: { color: COLORS.TEXT_LIGHT, fontSize: 13 },
  input: { padding: '7px 9px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT, background: '#fff' },
  fullInput: { padding: '8px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT, background: '#fff', minWidth: 0 },
  selectedText: { marginLeft: 'auto', color: COLORS.TEXT, fontWeight: 600 },
  primaryButton: { padding: '8px 15px', border: 0, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', fontFamily: UI_FONT, cursor: 'pointer' },
  secondaryButton: { padding: '7px 12px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, fontFamily: UI_FONT, cursor: 'pointer' },
  smallButton: { padding: '5px 12px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, fontFamily: UI_FONT },
  footer: { borderTop: `1px solid ${COLORS.BORDER}`, background: '#fff', padding: '8px 12px', display: 'grid', gridTemplateColumns: '88px minmax(0, 1.2fr) minmax(340px, .9fr)', gap: 10, alignItems: 'start' },
  helpTitle: { color: COLORS.TEXT, fontWeight: 700, paddingTop: 2 },
  helpText: { color: COLORS.TEXT, fontSize: 12, lineHeight: 1.65 },
  historyPanel: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  historySelect: { padding: '6px 8px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT, color: COLORS.TEXT, background: '#fff' },
  history: { maxHeight: 56, overflow: 'auto', background: '#f7fbff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, padding: 6, color: COLORS.TEXT, fontSize: 12, lineHeight: 1.5 },
  selectionBox: { position: 'fixed', zIndex: 1500, border: `1px dashed ${COLORS.ACCENT}`, background: 'rgba(43,135,240,.16)', pointerEvents: 'none' },
  contextMenu: { position: 'fixed', zIndex: 1700, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.18)', padding: 5, display: 'flex', flexDirection: 'column', minWidth: 170 },
  menuItem: { padding: '8px 10px', border: 0, background: '#fff', color: COLORS.TEXT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT },
  exportBackdrop: { position: 'absolute', inset: 0, zIndex: 1600, background: 'rgba(0,0,0,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  exportDialog: { width: 520, background: '#fff', borderRadius: 8, boxShadow: '0 16px 42px rgba(0,0,0,.24)', padding: 18, display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' },
  exportTitle: { margin: 0, color: COLORS.TEXT, fontSize: 18 },
  exportSummary: { color: COLORS.TEXT_LIGHT, fontSize: 13, marginBottom: 4 },
  fieldLabel: { color: COLORS.TEXT, fontSize: 13, fontWeight: 600 },
  exportActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
};

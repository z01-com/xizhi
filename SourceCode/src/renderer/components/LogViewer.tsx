import React, { useCallback, useEffect, useRef, useState } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';

interface LogEntry {
  id: number;
  created: Date;
  message: string;
}

interface LogViewerProps {
  logs: LogEntry[];
  onClose: () => void;
  onRefresh: () => void;
}

const styles: Record<string, any> = {
  backdrop: { position: 'fixed', top: 112, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 },
  dialog: { width: '88vw', maxWidth: 1100, height: '78vh', backgroundColor: '#fff', borderRadius: 8, display: 'flex', flexDirection: 'column', boxShadow: '0 12px 48px rgba(0,0,0,.25)' },
  dialogMax: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#fff', borderRadius: 0, display: 'flex', flexDirection: 'column', boxShadow: '0 12px 48px rgba(0,0,0,.35)' },
  header: { padding: '12px 16px', borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  title: { margin: 0, fontSize: 15, fontWeight: 600, color: COLORS.TEXT, flex: 1 },
  toolBtn: { padding: '6px 14px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 5 },
  toolBtnPrimary: { padding: '6px 14px', border: `1px solid ${COLORS.ACCENT}`, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 5 },
  toolBtnDanger: { padding: '6px 14px', border: `1px solid #e0c0c0`, borderRadius: 4, background: '#fff5f5', color: '#c0392b', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 5 },
  headerIconBtn: { width: 32, height: 32, border: 'none', borderRadius: 4, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  filterBar: { padding: '10px 16px', borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, background: '#f9fbfd' },
  filterLabel: { fontSize: 13, color: COLORS.TEXT, fontWeight: 500 },
  dateInput: { padding: '5px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontSize: 13, fontFamily: UI_FONT, color: COLORS.TEXT, background: '#fff', width: 148 },
  separator: { color: COLORS.TEXT_LIGHT, fontSize: 13 },
  filterHint: { fontSize: 12, color: COLORS.TEXT_LIGHT, marginLeft: 4 },
  body: { flex: 1, overflow: 'auto', minHeight: 0 },
  row: { display: 'flex', minHeight: 28, alignItems: 'center', borderBottom: `1px solid #eef3f8` },
  rowEvenBg: '#f9fbfd',
  rowOddBg: '#ffffff',
  rowHoverBg: '#eaf1fb',
  rowSelectBg: COLORS.SELECT,
  time: { color: COLORS.TEXT_LIGHT, fontSize: 12, fontFamily: 'Consolas, monospace', padding: '0 10px', whiteSpace: 'nowrap', flexShrink: 0 },
  msg: { color: COLORS.TEXT, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, paddingRight: 10 },
  empty: { textAlign: 'center', color: COLORS.TEXT_LIGHT, fontSize: 13, padding: '40px 0' },
  footer: { padding: '8px 16px', borderTop: `1px solid ${COLORS.BORDER}`, fontSize: 12, color: COLORS.TEXT_LIGHT, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16 },
  ctxMenu: { position: 'fixed', zIndex: 3100, minWidth: 130, padding: 4, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 5, boxShadow: '0 8px 24px rgba(0,0,0,.22)', display: 'flex', flexDirection: 'column' as const },
  ctxItem: { padding: '8px 16px', border: 0, borderRadius: 3, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, textAlign: 'left' as const, display: 'flex', alignItems: 'center', gap: 6 },
  ctxItemDanger: { padding: '8px 16px', border: 0, borderRadius: 3, background: 'transparent', color: '#c0392b', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, textAlign: 'left' as const, display: 'flex', alignItems: 'center', gap: 6 },
};

/** 获取今日日期字符串 YYYY-MM-DD */
const todayStr = (): string => new Date().toISOString().slice(0, 10);

export const LogViewer: React.FC<LogViewerProps> = ({ logs, onClose, onRefresh }) => {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 日期筛选状态
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [filteredLogs, setFilteredLogs] = useState<LogEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [maximized, setMaximized] = useState(false);

  // 实际展示的日志
  const displayLogs = filteredLogs ?? logs;

  // 默认滚动到顶部
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
  }, [displayLogs]);

  // 按时间段检索
  const doSearch = useCallback(async () => {
    if (!startDate || !endDate) return;
    setSearching(true);
    try {
      const result = await window.electronAPI.dbGetLogsByDateRange(startDate, endDate, 2000);
      setFilteredLogs(result);
      setSelectedIds(new Set());
    } finally {
      setSearching(false);
    }
  }, [startDate, endDate]);

  // 清除筛选，显示全部
  const clearFilter = useCallback(() => {
    setStartDate('');
    setEndDate('');
    setFilteredLogs(null);
    setSelectedIds(new Set());
    onRefresh();
  }, [onRefresh]);

  // 快捷筛选：今天
  const filterToday = useCallback(async () => {
    const t = todayStr();
    setStartDate(t);
    setEndDate(t);
    setSearching(true);
    try {
      const result = await window.electronAPI.dbGetLogsByDateRange(t, t, 2000);
      setFilteredLogs(result);
      setSelectedIds(new Set());
    } finally {
      setSearching(false);
    }
  }, []);

  // 快捷筛选：最近7天
  const filterWeek = useCallback(async () => {
    const end = todayStr();
    const d = new Date();
    d.setDate(d.getDate() - 6);
    const start = d.toISOString().slice(0, 10);
    setStartDate(start);
    setEndDate(end);
    setSearching(true);
    try {
      const result = await window.electronAPI.dbGetLogsByDateRange(start, end, 2000);
      setFilteredLogs(result);
      setSelectedIds(new Set());
    } finally {
      setSearching(false);
    }
  }, []);

  const toggleSelect = useCallback((id: number, event: React.MouseEvent) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (event.ctrlKey || event.metaKey) {
        next.has(id) ? next.delete(id) : next.add(id);
      } else if (event.shiftKey && lastClicked !== null) {
        const ids = displayLogs.map(l => l.id);
        const a = ids.indexOf(lastClicked);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]);
        }
      } else {
        next.clear();
        next.add(id);
      }
      return next;
    });
    setLastClicked(id);
  }, [displayLogs, lastClicked]);

  const handleCtx = useCallback((event: React.MouseEvent, id: number) => {
    event.preventDefault();
    setSelectedIds(prev => {
      if (!prev.has(id)) return new Set<number>([id]);
      return prev;
    });
    setCtxMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const dismissCtx = useCallback(() => setCtxMenu(null), []);

  const copySelected = useCallback(() => {
    const lines = displayLogs.filter(l => selectedIds.has(l.id)).map(l => `[${l.created.toLocaleString('zh-CN')}] ${l.message}`);
    if (lines.length) navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
  }, [displayLogs, selectedIds]);

  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    await window.electronAPI.dbDeleteLogsByIds([...selectedIds]);
    setSelectedIds(new Set());
    // 如果当前是筛选状态，重新查询；否则刷新全部
    if (filteredLogs && startDate && endDate) {
      const result = await window.electronAPI.dbGetLogsByDateRange(startDate, endDate, 2000);
      setFilteredLogs(result);
    } else {
      onRefresh();
    }
  }, [selectedIds, onRefresh, filteredLogs, startDate, endDate]);

  const exportLogs = useCallback(async () => {
    const lines = (selectedIds.size > 0 ? displayLogs.filter(l => selectedIds.has(l.id)) : displayLogs).map(l => `[${l.created.toLocaleString('zh-CN')}] ${l.message}`);
    if (lines.length === 0) return;
    const filePath = await window.electronAPI.saveFile({
      title: '导出日志文件',
      defaultPath: `zoomlaxizhi_logs_${todayStr()}.log`,
      filters: [{ name: '日志文件', extensions: ['log'] }],
    });
    if (!filePath) return;
    await window.electronAPI.fsWriteFile(filePath, lines.join('\r\n'));
    await window.electronAPI.dbAddLog(`导出 ${lines.length} 条日志至 ${filePath}`);
    onRefresh();
  }, [displayLogs, selectedIds, onRefresh]);

  const deleteByToday = useCallback(async () => {
    await window.electronAPI.dbDeleteLogsByDate(todayStr());
    setSelectedIds(new Set());
    onRefresh();
  }, [onRefresh]);

  const clearAll = useCallback(async () => {
    await window.electronAPI.dbClearLogs();
    setSelectedIds(new Set());
    onRefresh();
  }, [onRefresh]);

  const refresh = useCallback(() => {
    setSelectedIds(new Set());
    if (filteredLogs && startDate && endDate) {
      doSearch();
    } else {
      onRefresh();
    }
  }, [onRefresh, filteredLogs, startDate, endDate, doSearch]);

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={maximized ? styles.dialogMax : styles.dialog} onClick={e => e.stopPropagation()}>
        {/* 顶部工具栏 */}
        <div style={styles.header}>
          <h3 style={styles.title}>📋 日志查看器</h3>
          <button style={styles.toolBtn} onClick={refresh} title="刷新日志列表"><i className="ri-refresh-line" /> 刷新</button>
          <button style={styles.toolBtn} onClick={copySelected} disabled={selectedIds.size === 0} title="复制选中的日志"><i className="ri-file-copy-line" /> 复制选中</button>
          <button style={styles.toolBtn} onClick={exportLogs} title="导出日志到 .log 文件"><i className="ri-download-2-line" /> 导出</button>
          <button style={styles.toolBtnDanger} onClick={deleteByToday} title="删除今天及之前的所有日志"><i className="ri-calendar-close-line" /> 按天删除</button>
          <button style={styles.toolBtnDanger} onClick={clearAll} title="清空全部日志"><i className="ri-delete-bin-line" /> 清空全部</button>
          <button style={styles.headerIconBtn} onClick={() => setMaximized(m => !m)} title={maximized ? '还原窗口大小' : '最大化至母窗体'}>
            <i className={maximized ? 'ri-collapse-diagonal-line' : 'ri-expand-diagonal-line'} />
          </button>
          <button style={styles.headerIconBtn} onClick={onClose} title="关闭"><i className="ri-close-line" /></button>
        </div>

        {/* 日期筛选栏 */}
        <div style={styles.filterBar}>
          <span style={styles.filterLabel}><i className="ri-calendar-check-line" /> 时间段检索：</span>
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            max={endDate || todayStr()}
            style={styles.dateInput}
            title="开始日期"
          />
          <span style={styles.separator}>至</span>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            min={startDate || undefined}
            max={todayStr()}
            style={styles.dateInput}
            title="结束日期"
          />
          <button
            style={styles.toolBtnPrimary}
            onClick={doSearch}
            disabled={!startDate || !endDate || searching}
            title="按选定时间段检索日志"
          >
            <i className="ri-search-line" /> 检索
          </button>
          <button
            style={styles.toolBtn}
            onClick={clearFilter}
            disabled={!filteredLogs}
            title="清除筛选，显示全部日志"
          >
            <i className="ri-close-circle-line" /> 显示全部
          </button>
          <button style={styles.toolBtn} onClick={filterToday} title="仅查看今日日志">
            <i className="ri-calendar-line" /> 今天
          </button>
          <button style={styles.toolBtn} onClick={filterWeek} title="查看最近7天日志">
            <i className="ri-calendar-2-line" /> 近7天
          </button>
          {filteredLogs && (
            <span style={styles.filterHint}>
              已筛选 {displayLogs.length} 条（{startDate} ~ {endDate}）
            </span>
          )}
        </div>

        {/* 日志列表 */}
        <div ref={bodyRef} style={styles.body} onClick={dismissCtx}>
          {displayLogs.length === 0 ? (
            <div style={styles.empty}>{filteredLogs ? '该时间段内暂无日志' : '暂无日志'}</div>
          ) : (
            displayLogs.map((log, index) => {
              const selected = selectedIds.has(log.id);
              const bg = selected ? styles.rowSelectBg : (index % 2 === 0 ? styles.rowEvenBg : styles.rowOddBg);
              return (
                <div
                  key={log.id}
                  style={{ ...styles.row, background: bg }}
                  onClick={e => toggleSelect(log.id, e)}
                  onContextMenu={e => handleCtx(e, log.id)}
                  onMouseEnter={e => { if (!selected) e.currentTarget.style.background = styles.rowHoverBg; }}
                  onMouseLeave={e => { if (!selected) e.currentTarget.style.background = bg; }}
                >
                  <span style={styles.time}>{log.created.toLocaleString('zh-CN')}</span>
                  <span style={styles.msg} title={log.message}>{log.message}</span>
                </div>
              );
            })
          )}
        </div>

        {/* 底部状态栏 */}
        <div style={styles.footer}>
          <span>共 {displayLogs.length} 条日志{selectedIds.size > 0 ? `，已选中 ${selectedIds.size} 条` : ''}</span>
          {filteredLogs && <span style={{ color: COLORS.ACCENT }}>（时间段筛选模式）</span>}
        </div>

        {/* 右键菜单 */}
        {ctxMenu && (
          <div style={{ ...styles.ctxMenu, left: ctxMenu.x, top: ctxMenu.y }} onClick={e => { e.stopPropagation(); dismissCtx(); }}>
            <button style={styles.ctxItem} onClick={() => { copySelected(); dismissCtx(); }}><i className="ri-file-copy-line" /> 复制 ({selectedIds.size})</button>
            <button style={styles.ctxItem} onClick={() => { exportLogs(); dismissCtx(); }}><i className="ri-download-2-line" /> 导出 ({selectedIds.size})</button>
            <button style={styles.ctxItemDanger} onClick={() => { deleteSelected(); dismissCtx(); }}><i className="ri-delete-bin-line" /> 删除 ({selectedIds.size})</button>
          </div>
        )}
      </div>
    </div>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { COLORS } from '@shared/constants';

interface LogEntry {
  id: number;
  created: Date;
  message: string;
}

interface LiveLogPanelProps {
  logs: LogEntry[];
  onClose: () => void;
}

type PanelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PointerState = {
  pointerId: number;
  startX: number;
  startY: number;
  startRect: PanelRect;
};

const ROW_H = 26;
const EDGE = 8;
const TOP_MARGIN = 120;
const MIN_WIDTH = 520;
const MIN_HEIGHT = 150;

const getInitialRect = (): PanelRect => {
  const viewportWidth = window.innerWidth || 1280;
  const viewportHeight = window.innerHeight || 720;
  const width = Math.max(MIN_WIDTH, viewportWidth - 56);
  const height = 220;
  return clampRect({
    left: 28,
    top: Math.max(TOP_MARGIN, viewportHeight - height - 26),
    width,
    height,
  });
};

const clampRect = (rect: PanelRect): PanelRect => {
  const viewportWidth = window.innerWidth || 1280;
  const viewportHeight = window.innerHeight || 720;
  const maxWidth = Math.max(260, viewportWidth - EDGE * 2);
  const maxHeight = Math.max(MIN_HEIGHT, viewportHeight - TOP_MARGIN - EDGE);
  const width = Math.min(Math.max(rect.width, Math.min(MIN_WIDTH, maxWidth)), maxWidth);
  const height = Math.min(Math.max(rect.height, MIN_HEIGHT), maxHeight);
  const left = Math.min(Math.max(rect.left, EDGE), Math.max(EDGE, viewportWidth - width - EDGE));
  const top = Math.min(Math.max(rect.top, TOP_MARGIN), Math.max(TOP_MARGIN, viewportHeight - height - EDGE));
  return { left, top, width, height };
};

const getMaximizedRect = (): PanelRect => ({
  left: EDGE,
  top: TOP_MARGIN,
  width: Math.max(260, (window.innerWidth || 1280) - EDGE * 2),
  height: Math.max(MIN_HEIGHT, (window.innerHeight || 720) - TOP_MARGIN - EDGE),
});

export const LiveLogPanel: React.FC<LiveLogPanelProps> = ({ logs, onClose }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PointerState | null>(null);
  const resizeRef = useRef<PointerState | null>(null);
  const [rect, setRect] = useState<PanelRect>(() => getInitialRect());
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
  }, [logs]);

  useEffect(() => {
    const handleResize = () => setRect(current => clampRect(current));
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        setRect(clampRect({
          ...drag.startRect,
          left: drag.startRect.left + dx,
          top: drag.startRect.top + dy,
        }));
        return;
      }

      const resize = resizeRef.current;
      if (resize) {
        const dx = event.clientX - resize.startX;
        const dy = event.clientY - resize.startY;
        setRect(clampRect({
          ...resize.startRect,
          width: resize.startRect.width + dx,
          height: resize.startRect.height + dy,
        }));
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  const panelRect = useMemo(() => maximized ? getMaximizedRect() : rect, [maximized, rect]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (maximized || event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (maximized || event.button !== 0) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  };

  return (
    <div style={{ ...styles.panel, ...panelRect }}>
      <div style={styles.titleBar} onPointerDown={startDrag}>
        <span style={styles.title}><i className="ri-bubble-chart-line" /> 实时控制台 / 执行日志</span>
        <button
          type="button"
          title={maximized ? '恢复窗口' : '放大全屏'}
          style={styles.iconButton}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => setMaximized(current => !current)}
        >
          <i className={maximized ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line'} />
        </button>
        <button
          type="button"
          title="隐藏"
          style={styles.iconButton}
          onPointerDown={event => event.stopPropagation()}
          onClick={onClose}
        >
          <i className="ri-subtract-line" />
        </button>
      </div>
      <div ref={bodyRef} style={styles.body}>
        {logs.length === 0 ? (
          <div style={styles.empty}>暂无日志，等待操作...</div>
        ) : (
          logs.slice(0, 500).map((log, index) => {
            const bg = index % 2 === 0 ? styles.rowEvenBg : styles.rowOddBg;
            return (
              <div
                key={log.id}
                style={{ ...styles.row, background: bg }}
                onMouseEnter={e => { e.currentTarget.style.background = styles.rowHoverBg; }}
                onMouseLeave={e => { e.currentTarget.style.background = bg; }}
              >
                <span style={styles.time}>{log.created.toLocaleString('zh-CN')}</span>
                <span style={styles.message} title={log.message}>{log.message}</span>
              </div>
            );
          })
        )}
      </div>
      {!maximized && <div title="拖拽调整大小" style={styles.resizeGrip} onPointerDown={startResize} />}
    </div>
  );
};

const styles: Record<string, any> = {
  panel: {
    position: 'fixed',
    background: '#fff',
    border: `1px solid ${COLORS.BORDER}`,
    borderRadius: 7,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 2600,
    boxShadow: '0 16px 42px rgba(31, 53, 78, .22)',
  },
  titleBar: {
    height: 34,
    padding: '0 8px 0 11px',
    background: '#f4f7fb',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    borderBottom: `1px solid ${COLORS.BORDER}`,
    cursor: 'move',
    userSelect: 'none',
  },
  title: { color: COLORS.TEXT, fontWeight: 600, fontSize: 13, flex: 1, display: 'inline-flex', alignItems: 'center', gap: 6 },
  iconButton: {
    width: 28,
    height: 26,
    border: 0,
    borderRadius: 4,
    background: 'transparent',
    color: COLORS.TEXT,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
  },
  body: { flex: 1, overflow: 'auto', minHeight: 0 },
  row: { display: 'flex', height: ROW_H, alignItems: 'center', borderBottom: `1px solid #eef3f8` },
  rowEvenBg: '#f9fbfd',
  rowOddBg: '#ffffff',
  rowHoverBg: '#eef4fb',
  time: { color: COLORS.TEXT_LIGHT, fontSize: 12, fontFamily: 'Consolas, monospace', padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0 },
  message: { color: COLORS.TEXT, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, paddingRight: 8 },
  empty: { textAlign: 'center', color: COLORS.TEXT_LIGHT, fontSize: 12, padding: '16px 0' },
  resizeGrip: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 18,
    height: 18,
    cursor: 'nwse-resize',
    background: 'linear-gradient(135deg, transparent 0 45%, #c3cfdd 46% 54%, transparent 55% 100%)',
  },
};

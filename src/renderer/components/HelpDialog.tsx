import React, { useMemo, useState } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';

export const HelpDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [content, setContent] = useState('正在加载帮助...');
  const [maximized, setMaximized] = useState(false);
  const [keyword, setKeyword] = useState('');

  // 加载帮助内容
  React.useEffect(() => {
    window.electronAPI.readHelp().then(setContent).catch(error => setContent(`# 帮助\n\n${error.message}`));
  }, []);

  const lines = useMemo(() => content.split(/\r?\n/), [content]);

  // 按关键字过滤
  const filtered = useMemo(() => {
    if (!keyword.trim()) return lines;
    const kw = keyword.toLowerCase();
    return lines.filter(line => line.toLowerCase().includes(kw));
  }, [lines, keyword]);

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={maximized ? styles.dialogMax : styles.dialog} onClick={e => e.stopPropagation()}>
        {/* 顶部工具栏 */}
        <div style={styles.header}>
          <h3 style={styles.title}>❓ 帮助</h3>
          <div style={styles.searchBox}>
            <i className="ri-search-line" style={styles.searchIcon} />
            <input
              type="text"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="搜索帮助内容..."
              style={styles.searchInput}
            />
            {keyword && (
              <button
                style={styles.searchClear}
                onClick={() => setKeyword('')}
                title="清除搜索"
              >
                <i className="ri-close-line" />
              </button>
            )}
          </div>
          <div style={styles.rightActions}>
            <button
              style={styles.headerIconBtn}
              onClick={() => setMaximized(m => !m)}
              title={maximized ? '还原窗口大小' : '最大化至母窗体'}
            >
              <i className={maximized ? 'ri-collapse-diagonal-line' : 'ri-expand-diagonal-line'} />
            </button>
            <button style={styles.headerIconBtn} onClick={onClose} title="关闭"><i className="ri-close-line" /></button>
          </div>
        </div>

        {/* 内容区 */}
        <div style={styles.body}>
          {filtered.length === 0 ? (
            <div style={styles.empty}>未找到匹配"{keyword}"的内容</div>
          ) : (
            filtered.map((line, index) => renderLine(line, index))
          )}
        </div>

        {/* 底部状态栏 */}
        <div style={styles.footer}>
          <span>{lines.length} 行</span>
          {keyword && <span style={{ color: COLORS.ACCENT }}>匹配 {filtered.length} 行</span>}
        </div>
      </div>
    </div>
  );
};

function renderLine(line: string, index: number) {
  if (line.startsWith('# ')) return <h1 key={index} style={styles.h1}>{line.slice(2)}</h1>;
  if (line.startsWith('## ')) return <h2 key={index} style={styles.h2}>{line.slice(3)}</h2>;
  if (line.startsWith('- ')) return <div key={index} style={styles.li}>• {line.slice(2)}</div>;
  if (!line.trim()) return <div key={index} style={{ height: 8 }} />;
  return <p key={index} style={styles.p}>{line}</p>;
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', left: 0, right: 0, top: 112, bottom: 0, zIndex: 1200, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dialog: { width: 860, maxWidth: '92vw', maxHeight: '88vh', background: '#fff', borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  dialogMax: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: '#fff', borderRadius: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  header: { padding: '12px 16px', borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  title: { margin: 0, fontSize: 15, fontWeight: 600, color: COLORS.TEXT },
  rightActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 },
  headerIconBtn: { width: 32, height: 32, border: 'none', borderRadius: 4, background: 'transparent', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  searchBox: { position: 'relative', display: 'flex', alignItems: 'center', width: 300, flexShrink: 0 },
  searchIcon: { position: 'absolute', left: 10, fontSize: 14, color: COLORS.TEXT_LIGHT, pointerEvents: 'none' },
  searchInput: { width: '100%', padding: '6px 32px 6px 30px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontSize: 13, fontFamily: UI_FONT, color: COLORS.TEXT, background: '#fff', outline: 'none' },
  searchClear: { position: 'absolute', right: 4, width: 24, height: 24, border: 0, borderRadius: 3, background: 'transparent', color: COLORS.TEXT_LIGHT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 },
  body: { flex: 1, padding: 22, overflow: 'auto', lineHeight: 1.7, color: COLORS.TEXT, fontFamily: UI_FONT, minHeight: 0 },
  footer: { padding: '8px 16px', borderTop: `1px solid ${COLORS.BORDER}`, fontSize: 12, color: COLORS.TEXT_LIGHT, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16 },
  empty: { textAlign: 'center', color: COLORS.TEXT_LIGHT, fontSize: 13, padding: '40px 0' },
  h1: { fontSize: 22, margin: '0 0 12px', color: COLORS.TEXT },
  h2: { fontSize: 16, margin: '18px 0 8px', color: COLORS.TEXT },
  p: { margin: '4px 0', fontSize: 14 },
  li: { margin: '3px 0 3px 12px', fontSize: 14 },
};

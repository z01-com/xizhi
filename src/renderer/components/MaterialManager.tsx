import React, { useEffect, useState } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';
import { LoadingOverlay } from './LoadingOverlay';
import { PathTools } from './PathTools';

interface MaterialManagerProps {
  showToast: (message: string, type: 'info' | 'success' | 'error') => void;
}

type MaterialRecent = { time: string; operation: string; dir: string; outputPath?: string; count?: number; detail?: string };

const SHAPES = [
  { id: 'circle', label: '圆点' },
  { id: 'square', label: '方点' },
  { id: 'triangle', label: '三角形' },
  { id: 'rect12', label: '1:2矩形' },
  { id: 'ellipse12', label: '1:2椭圆' },
  { id: 'custom', label: '自定义' },
];

const DIRECTION_OPTIONS = [
  { id: 'random', label: '随机' },
  { id: 'vertical', label: '竖向' },
  { id: 'horizontal', label: '横向' },
  { id: 'free', label: '自由方向不规则' },
];

export const MaterialManager: React.FC<MaterialManagerProps> = ({ showToast }) => {
  const [dir, setDir] = useState('');
  const [pattern, setPattern] = useState('*');
  const [element, setElement] = useState('');
  const [customNoise, setCustomNoise] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [resize, setResize] = useState({ width: '', height: '' });
  const [noise, setNoise] = useState({ shapes: ['circle', 'square'], direction: 'random', size: '10', density: '8' });
  const [recent, setRecent] = useState<MaterialRecent[]>([]);
  const [recentCollapsed, setRecentCollapsed] = useState(false);

  useEffect(() => {
    Promise.all([
      window.electronAPI.dbGetSetting('tab2_dir', ''),
      window.electronAPI.dbGetSetting('materialRecent', '[]'),
      window.electronAPI.dbGetSetting('ui.materialRecentCollapsed', 'false'),
    ]).then(([savedDir, rawRecent, collapsed]) => {
      if (savedDir) setDir(savedDir);
      setRecentCollapsed(collapsed === 'true');
      try {
        const parsed = JSON.parse(rawRecent);
        setRecent(Array.isArray(parsed) ? parsed.slice(0, 20) : []);
      } catch {
        setRecent([]);
      }
    });
  }, []);

  const toggleRecentCollapsed = async () => {
    const next = !recentCollapsed;
    setRecentCollapsed(next);
    await window.electronAPI.dbSetSetting('ui.materialRecentCollapsed', String(next));
  };

  const addRecent = async (item: Omit<MaterialRecent, 'time'>) => {
    const record = { ...item, time: new Date().toLocaleString() };
    const next = [record, ...recent].slice(0, 20);
    setRecent(next);
    await window.electronAPI.dbSetSetting('materialRecent', JSON.stringify(next));
  };

  const openExistingPath = async (target?: string) => {
    if (!target || !(await window.electronAPI.fsExists(target))) {
      showToast(`目标资源不存在或已被移动/删除：${target || '空路径'}`, 'error');
      return;
    }
    const result = await window.electronAPI.openPath(target);
    if (!result.success) showToast(result.error || `无法打开：${target}`, 'error');
  };

  const locateExistingPath = async (target?: string) => {
    if (!target || !(await window.electronAPI.fsExists(target))) {
      showToast(`目标资源不存在或已被移动/删除：${target || '空路径'}`, 'error');
      return;
    }
    await window.electronAPI.showItemInFolder(target);
  };

  const chooseDir = async () => {
    const selected = await window.electronAPI.openDirectory({ defaultPath: dir || undefined });
    if (selected) {
      setDir(selected);
      await window.electronAPI.dbSetSetting('tab2_dir', selected);
    }
  };

  const chooseElement = async () => {
    const selected = await window.electronAPI.openFile({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    });
    if (selected) setElement(selected);
  };

  const chooseCustomNoise = async () => {
    const selected = await window.electronAPI.openFile({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    });
    if (selected) setCustomNoise(selected);
  };

  const run = async (operation: string, label: string, options: Record<string, any>, detail = '') => {
    if (!dir) {
      showToast('请先选择素材目录', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.processMaterials(operation, { dir, pattern, ...options });
      if (result.success) {
        setOutput(result.outputPath);
        await addRecent({ operation: label, dir, outputPath: result.outputPath, count: result.count, detail });
        showToast(`处理完成：${result.count} 个文件`, 'success');
      } else {
        showToast(result.error || '素材处理失败', 'error');
      }
    } catch (error: any) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleShape = (id: string) => {
    setNoise(prev => {
      const exists = prev.shapes.includes(id);
      const shapes = exists ? prev.shapes.filter(item => item !== id) : [...prev.shapes, id];
      return { ...prev, shapes };
    });
  };

  const runNoise = () => {
    if (!noise.shapes.length) {
      showToast('请至少勾选一种麻点形状', 'error');
      return;
    }
    if (noise.shapes.includes('custom') && !customNoise) {
      showToast('已勾选自定义，请先选择自定义麻点元素', 'error');
      return;
    }
    const labels = SHAPES.filter(item => noise.shapes.includes(item.id)).map(item => item.label).join('/');
    const directionLabel = DIRECTION_OPTIONS.find(item => item.id === noise.direction)?.label || '随机';
    run('material-noise', '字形装饰(批量加麻点)', {
      shapes: noise.shapes,
      direction: noise.direction,
      custom: customNoise,
      size: noise.size,
      density: noise.density,
    }, `形状 ${labels} | 方向 ${directionLabel} | ${noise.size}px | 覆盖 ${noise.density}%`);
  };

  return (
    <div style={styles.container}>
      <LoadingOverlay visible={busy} />
      <h2 style={styles.sectionTitle}>素材管理</h2>

      <section style={styles.card}>
        <h3 style={styles.subTitle}>素材目录与筛选</h3>
        <div style={styles.row}>
          <PathTools value={dir} placeholder="选择 PNG/JPG 素材目录" isDir onBrowse={chooseDir} />
          <label style={styles.inlineLabel}>文件筛选</label>
          <input value={pattern} onChange={event => setPattern(event.target.value)} style={{ ...styles.input, width: 130 }} />
        </div>
        {output && <button style={styles.outputButton} onClick={() => void openExistingPath(output)}>最近输出：{output}</button>}
      </section>

      <section style={styles.card}>
        <h3 style={styles.subTitle}>格式转换</h3>
        <div style={styles.row}>
          {['PNG', 'JPG', 'EPS'].map(format => (
            <button key={format} style={styles.primaryButton} disabled={busy} onClick={() => run('material-convert', `转为 ${format}`, { format }, `格式 ${format}`)}>转为 {format}</button>
          ))}
        </div>
      </section>

      <section style={styles.card}>
        <h3 style={styles.subTitle}>无损缩放</h3>
        <div style={styles.row}>
          <label style={styles.inlineLabel}>宽度</label>
          <input value={resize.width} onChange={event => setResize({ ...resize, width: event.target.value })} placeholder="自动" style={{ ...styles.input, width: 100 }} />
          <label style={styles.inlineLabel}>高度</label>
          <input value={resize.height} onChange={event => setResize({ ...resize, height: event.target.value })} placeholder="自动" style={{ ...styles.input, width: 100 }} />
          <button style={styles.primaryButton} disabled={busy} onClick={() => run('material-resize', '无损缩放', resize, `宽 ${resize.width || '自动'} | 高 ${resize.height || '自动'}`)}>执行缩放</button>
        </div>
      </section>

      <section style={styles.card}>
        <h3 style={styles.subTitle}>引入第三方元素(覆盖 / 取代 / 加印)</h3>
        <div style={styles.row}>
          <PathTools value={element} placeholder="选择元素图片" onBrowse={chooseElement} />
          {[
            ['overlay', '覆盖'],
            ['replace', '取代'],
            ['stamp', '加印'],
          ].map(([mode, label]) => (
            <button key={mode} style={styles.primaryButton} disabled={busy || !element} onClick={() => run('material-element', `第三方元素-${label}`, { element, mode }, `元素 ${element}`)}>{label}</button>
          ))}
        </div>
        <div style={styles.tip}>覆盖 = 元素拉伸至全图叠加；取代 = 用元素替换原图内容并保留文件名；加印 = 元素缩小盖印右下角。</div>
      </section>

      <section style={styles.card}>
        <h3 style={styles.subTitle}>字形装饰(批量加麻点)</h3>
        <div style={styles.shapeRow}>
          <span style={styles.inlineLabel}>形状(可多选)</span>
          {SHAPES.map(shape => (
            <label key={shape.id} style={styles.checkLabel}>
              <input type="checkbox" checked={noise.shapes.includes(shape.id)} onChange={() => toggleShape(shape.id)} />
              <span>{shape.label}</span>
            </label>
          ))}
        </div>
        <div style={styles.row}>
          <PathTools value={customNoise} placeholder="选择自定义麻点元素" onBrowse={chooseCustomNoise} />
        </div>
        <div style={styles.row}>
          <label style={styles.inlineLabel}>方向</label>
          <select value={noise.direction} onChange={event => setNoise({ ...noise, direction: event.target.value })} style={styles.input}>
            {DIRECTION_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <label style={styles.inlineLabel}>大小(px)</label>
          <input value={noise.size} onChange={event => setNoise({ ...noise, size: event.target.value })} style={{ ...styles.input, width: 80 }} />
          <label style={styles.inlineLabel}>密度/覆盖(%)</label>
          <input value={noise.density} onChange={event => setNoise({ ...noise, density: event.target.value })} style={{ ...styles.input, width: 80 }} />
          <button style={styles.primaryButton} disabled={busy} onClick={runNoise}>执行装饰</button>
        </div>
        <div style={styles.tip}>圆点/方点仅随机方向；三角形、矩形、椭圆、自定义按“方向”摆放。白色元素与原图黑色笔画重叠处变白镂空，落在白底处不可见。</div>
      </section>

      <section style={styles.card}>
        <h3 style={styles.subTitle}>最近操作<button type="button" title={recentCollapsed ? '展开' : '折叠'} style={styles.collapseButton} onClick={toggleRecentCollapsed}><i className={recentCollapsed ? 'ri-arrow-up-wide-fill' : 'ri-arrow-down-wide-fill'} /></button></h3>
        {!recentCollapsed && (
          <div style={styles.recentList}>
            {recent.length === 0 && <div style={styles.empty}>暂无素材操作记录</div>}
            {recent.map((item, index) => (
              <div key={`${item.time}-${index}`} style={styles.recentRow}>
                <div style={styles.recentMain} title={item.outputPath || item.dir}>
                  <span style={styles.recentTime}>{item.time}</span>
                  <span style={styles.recentPath}>{item.operation} | {item.count ?? 0} 个 | {item.detail || item.dir}</span>
                </div>
                {item.outputPath && <button style={styles.smallButton} onClick={() => void openExistingPath(item.outputPath)}>open</button>}
                {item.outputPath && <button style={styles.smallButton} onClick={() => void locateExistingPath(item.outputPath)}>定位</button>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 1200, margin: '0 auto', position: 'relative', minHeight: 320 },
  sectionTitle: { fontSize: 20, color: COLORS.TEXT, marginBottom: 16 },
  card: { backgroundColor: COLORS.CARD, borderRadius: 8, padding: 18, marginBottom: 14, boxShadow: `0 2px 8px ${COLORS.BORDER}` },
  subTitle: { fontSize: 16, color: COLORS.TEXT, margin: '0 0 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  collapseButton: { width: 26, height: 24, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 },
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 },
  shapeRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 },
  checkLabel: { display: 'inline-flex', alignItems: 'center', gap: 4, color: COLORS.TEXT, fontSize: 13, padding: '5px 8px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff' },
  inlineLabel: { fontSize: 13, color: COLORS.TEXT_LIGHT },
  input: { padding: '8px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT, fontSize: 14 },
  primaryButton: { padding: '9px 17px', backgroundColor: COLORS.ACCENT, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT },
  outputButton: { marginTop: 8, padding: 8, width: '100%', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: COLORS.SELECT, textAlign: 'left', color: COLORS.TEXT, cursor: 'pointer' },
  tip: { color: COLORS.TEXT_LIGHT, fontSize: 12, lineHeight: 1.6, marginTop: 4 },
  recentList: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' },
  recentRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 62px 62px', gap: 8, alignItems: 'center' },
  recentMain: { display: 'grid', gridTemplateColumns: '155px minmax(0, 1fr)', gap: 8, padding: 8, borderRadius: 4, background: COLORS.SELECT, color: COLORS.TEXT, minWidth: 0 },
  recentTime: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  recentPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  smallButton: { padding: '8px 9px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 12 },
  empty: { color: COLORS.TEXT_LIGHT, fontSize: 13, padding: 8 },
};

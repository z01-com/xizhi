import React, { useEffect, useState } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';
import { LoadingOverlay } from './LoadingOverlay';
import { PathTools } from './PathTools';

interface ProductionCenterProps {
  showToast: (message: string, type: 'info' | 'success' | 'error') => void;
}

interface MaterialItem {
  path: string;
  name: string;
  char: string;
  code: number;
  size: string;
}

type ViewMode = 'thumb' | 'list';

function fileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, '/').replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

export const ProductionCenter: React.FC<ProductionCenterProps> = ({ showToast }) => {
  const [baseFontPath, setBaseFontPath] = useState('');
  const [materialDir, setMaterialDir] = useState('');
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [prodRecords, setProdRecords] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('thumb');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const [recordsCollapsed, setRecordsCollapsed] = useState(false);
  const [fontNames, setFontNames] = useState({
    englishName: 'Zoomla Hand Font',
    chineseName: '逐浪手迹体',
    version: 'Version 1.00',
    copyright: 'Zoomla!CMS Corporation. All rights reserved.',
  });

  useEffect(() => {
    loadRecords();
    Promise.all([
      window.electronAPI.dbGetSetting('tab3_base', ''),
      window.electronAPI.dbGetSetting('tab3_dir', ''),
      window.electronAPI.dbGetSetting('ui.productionRecordsCollapsed', 'false'),
    ]).then(([base, dir, collapsed]) => {
      if (base) setBaseFontPath(base);
      if (dir) setMaterialDir(dir);
      setRecordsCollapsed(collapsed === 'true');
    });
  }, []);

  const loadRecords = async () => setProdRecords(await window.electronAPI.dbGetProdRecords());

  const toggleRecordsCollapsed = async () => {
    const next = !recordsCollapsed;
    setRecordsCollapsed(next);
    await window.electronAPI.dbSetSetting('ui.productionRecordsCollapsed', String(next));
  };

  const openExistingPath = async (target: string) => {
    if (!target || !(await window.electronAPI.fsExists(target))) {
      showToast(`目标资源不存在或已被移动/删除：${target || '空路径'}`, 'error');
      await loadRecords();
      return;
    }
    const result = await window.electronAPI.openPath(target);
    if (!result.success) showToast(result.error || `无法打开：${target}`, 'error');
  };

  const openExistingDirOf = async (target: string) => {
    if (!target || !(await window.electronAPI.fsExists(target))) {
      showToast(`目标资源不存在或已被移动/删除：${target || '空路径'}`, 'error');
      await loadRecords();
      return;
    }
    await openExistingPath(target.replace(/[^\\/]+$/, ''));
  };

  const selectBaseFont = async () => {
    const file = await window.electronAPI.openFile({ properties: ['openFile'], filters: [{ name: 'Font files', extensions: ['ttf', 'otf'] }] });
    if (file) {
      setBaseFontPath(file);
      await window.electronAPI.dbSetSetting('tab3_base', file);
    }
  };

  const selectMaterialDir = async () => {
    const dir = await window.electronAPI.openDirectory({ defaultPath: materialDir || undefined });
    if (dir) {
      setMaterialDir(dir);
      await window.electronAPI.dbSetSetting('tab3_dir', dir);
    }
  };

  const analyzeMaterials = async () => {
    if (!materialDir) {
      showToast('请先选择素材目录', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.scanMaterials(materialDir, '*');
      if (result.success) {
        setMaterials(result.items);
        setSelectedIndex(result.items.length ? 0 : -1);
        setViewMode('thumb');
        showToast(`分析完成：有效素材 ${result.items.length} 个，跳过 ${result.skipped} 个`, 'success');
      } else {
        showToast(result.error || '素材分析失败', 'error');
      }
    } catch (error: any) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeMaterial = (index: number) => {
    setMaterials(prev => prev.filter((_item, idx) => idx !== index));
    setSelectedIndex(prev => Math.min(prev, Math.max(-1, materials.length - 2)));
  };

  const produceFont = async () => {
    if (!baseFontPath) {
      showToast('请先选择基础 TTF 字体', 'error');
      return;
    }
    if (!materialDir) {
      showToast('请先选择素材目录', 'error');
      return;
    }
    const sourceMaterials = materials.length > 0 ? materials : undefined;
    setBusy(true);
    try {
      const result = await window.electronAPI.composeFont({
        baseFont: baseFontPath,
        materialDir,
        materials: sourceMaterials?.map(item => ({ path: item.path, code: item.code, char: item.char })),
        ...fontNames,
      });
      if (result.success) {
        showToast(`生产成功：覆盖 ${result.glyphCount} 个字形`, 'success');
        await loadRecords();
      } else {
        showToast(result.error || '字体生产失败', 'error');
      }
    } catch (error: any) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const currentPreview = previewIndex !== null ? materials[previewIndex] : null;
  const currentZoom = zoomIndex !== null ? materials[zoomIndex] : null;
  const navPreview = (delta: number) => {
    if (previewIndex === null || !materials.length) return;
    setPreviewIndex((previewIndex + delta + materials.length) % materials.length);
  };

  return (
    <div style={styles.container}>
      <LoadingOverlay visible={busy} />
      <h2 style={styles.sectionTitle}>生产中心 - 骨架注入法</h2>

      <div style={styles.card}>
        <h3 style={styles.subTitle}>字形素材分析</h3>
        <div style={styles.controls}>
          <PathTools value={materialDir} placeholder="选择 PNG/JPG 字形素材目录" isDir onBrowse={selectMaterialDir} />
          <button style={styles.actionButton} onClick={analyzeMaterials} disabled={busy}>分析素材</button>
        </div>
        <div style={styles.viewBar}>
          <span style={styles.label}>视图：</span>
          <label style={styles.radioLabel}><input type="radio" checked={viewMode === 'thumb'} onChange={() => setViewMode('thumb')} />缩图</label>
          <label style={styles.radioLabel}><input type="radio" checked={viewMode === 'list'} onChange={() => setViewMode('list')} />列表</label>
          <span style={styles.tip}>右键可移除单项；缩图双击可预览，预览中支持上一张/下一张/放大查看。</span>
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.subTitle}>素材列表 ({materials.length})</h3>
        {viewMode === 'thumb' ? (
          <div style={styles.thumbGrid}>
            {materials.map((item, index) => (
              <button
                key={item.path}
                style={index === selectedIndex ? styles.thumbCellSelected : styles.thumbCell}
                onClick={() => setSelectedIndex(index)}
                onDoubleClick={() => setPreviewIndex(index)}
                onContextMenu={event => { event.preventDefault(); removeMaterial(index); }}
                title={`${item.name} | ${item.char} U+${item.code.toString(16).toUpperCase().padStart(4, '0')}`}
              >
                <img src={fileUrl(item.path)} style={styles.thumbImage} />
                <span style={styles.thumbCaption}>{item.char} {item.code}</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={styles.table}>
            <div style={styles.tableHead}><span style={styles.tableCell}>文件名</span><span style={styles.smallCell}>字符</span><span style={styles.smallCell}>Unicode</span><span style={styles.smallCell}>图像尺寸</span></div>
            {materials.map((item, index) => (
              <div key={item.path} style={index === selectedIndex ? styles.tableRowSelected : styles.tableRow} onClick={() => setSelectedIndex(index)} onDoubleClick={() => setPreviewIndex(index)} onContextMenu={event => { event.preventDefault(); removeMaterial(index); }}>
                <span style={styles.tableCell}>{item.name}</span>
                <span style={styles.smallCell}>{item.char}</span>
                <span style={styles.smallCell}>U+{item.code.toString(16).toUpperCase().padStart(4, '0')}</span>
                <span style={styles.smallCell}>{item.size}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={styles.card}>
        <h3 style={styles.subTitle}>字体属性定义与 TTF 合成</h3>
        <div style={styles.formGrid}>
          {Object.entries(fontNames).map(([key, value]) => (
            <label key={key} style={styles.formItem}>
              <span style={styles.label}>{labelMap[key]}</span>
              <input value={value} onChange={event => setFontNames({ ...fontNames, [key]: event.target.value })} style={styles.input} />
            </label>
          ))}
        </div>
        <div style={{ ...styles.controls, marginTop: 14 }}>
          <PathTools value={baseFontPath} placeholder="选择基础 TTF 字体" onBrowse={selectBaseFont} />
          <button style={styles.primaryButton} onClick={produceFont} disabled={busy}>{busy ? '处理中...' : '生产新字体'}</button>
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.subTitle}>最近记录({prodRecords.length})<button type="button" title={recordsCollapsed ? '展开' : '折叠'} style={styles.collapseButton} onClick={toggleRecordsCollapsed}><i className={recordsCollapsed ? 'ri-arrow-up-wide-fill' : 'ri-arrow-down-wide-fill'} /></button></h3>
        {!recordsCollapsed && (
          <div style={styles.table}>
            {prodRecords.map(record => (
              <div key={record.id} style={styles.recordRow}>
                <span style={styles.smallCell}>{record.timestamp}</span>
                <span style={styles.tableCell}>{record.output_file}</span>
                <span style={styles.smallCell}>{record.glyph_count} 字</span>
                {record.output_file && <button style={styles.smallButton} onClick={() => void openExistingPath(record.output_file)}>view</button>}
                {record.output_file && <button style={styles.smallButton} onClick={() => void openExistingDirOf(record.output_file)}>open</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {currentPreview && previewIndex !== null && <div style={styles.previewBackdrop} onClick={() => setPreviewIndex(null)}>
        <div style={styles.previewDialog} onClick={event => event.stopPropagation()}>
          <div style={styles.previewImageWrap}>
            <img src={fileUrl(currentPreview.path)} style={styles.previewImage} />
            <div style={styles.previewInfo}>{currentPreview.char} U+{currentPreview.code.toString(16).toUpperCase().padStart(4, '0')} | {currentPreview.size}</div>
          </div>
          <div style={styles.previewActions}>
            <button style={styles.smallButton} onClick={() => navPreview(-1)}>上一张</button>
            <button style={styles.smallButton} onClick={() => navPreview(1)}>下一张</button>
            <button style={styles.primaryButton} onClick={() => setZoomIndex(previewIndex)}>放大查看</button>
            <button style={styles.smallButton} onClick={() => setPreviewIndex(null)}>关闭</button>
          </div>
        </div>
      </div>}

      {currentZoom && <div style={styles.zoomBackdrop} onClick={() => setZoomIndex(null)}>
        <div style={styles.zoomWrap}>
          <img src={fileUrl(currentZoom.path)} style={styles.zoomImage} />
          <div style={styles.previewInfo}>{currentZoom.char} U+{currentZoom.code.toString(16).toUpperCase().padStart(4, '0')} | {currentZoom.size}</div>
        </div>
      </div>}
    </div>
  );
};

const labelMap: Record<string, string> = {
  englishName: '英文名称',
  chineseName: '中文名称',
  version: '版本',
  copyright: '版权',
};

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 1200, margin: '0 auto', position: 'relative', minHeight: 360 },
  sectionTitle: { fontSize: 20, color: COLORS.TEXT, marginBottom: 16 },
  card: { backgroundColor: COLORS.CARD, borderRadius: 8, padding: 20, marginBottom: 16, boxShadow: `0 2px 8px ${COLORS.BORDER}` },
  subTitle: { fontSize: 16, color: COLORS.TEXT, margin: '0 0 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  collapseButton: { width: 26, height: 24, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 },
  controls: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' },
  viewBar: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  radioLabel: { color: COLORS.TEXT, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 },
  tip: { color: COLORS.TEXT_LIGHT, fontSize: 12 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 },
  formItem: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, color: COLORS.TEXT_LIGHT },
  input: { padding: '8px 12px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT, fontSize: 14 },
  primaryButton: { padding: '10px 20px', backgroundColor: COLORS.ACCENT, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  actionButton: { padding: '9px 18px', backgroundColor: COLORS.GREEN, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  thumbGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 8, maxHeight: 360, overflow: 'auto', padding: 4 },
  thumbCell: { height: 112, border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, background: '#fff', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, padding: 6 },
  thumbCellSelected: { height: 112, border: `2px solid #777`, borderRadius: 6, background: '#e5e5e5', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, padding: 6 },
  thumbImage: { maxWidth: 72, maxHeight: 72, objectFit: 'contain' },
  thumbCaption: { fontSize: 12, color: COLORS.TEXT, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  table: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflow: 'auto' },
  tableHead: { display: 'grid', gridTemplateColumns: '1fr 80px 120px 100px', gap: 8, padding: 8, backgroundColor: '#e3eefb', borderRadius: 4, fontWeight: 700 },
  tableRow: { display: 'grid', gridTemplateColumns: '1fr 80px 120px 100px', gap: 8, padding: 8, backgroundColor: COLORS.SELECT, borderRadius: 4, cursor: 'pointer' },
  tableRowSelected: { display: 'grid', gridTemplateColumns: '1fr 80px 120px 100px', gap: 8, padding: 8, backgroundColor: '#e5e5e5', borderRadius: 4, cursor: 'pointer', outline: '2px solid #777' },
  recordRow: { display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr) 80px 62px 62px', gap: 8, padding: 8, backgroundColor: COLORS.SELECT, borderRadius: 4, alignItems: 'center' },
  tableCell: { fontSize: 13, color: COLORS.TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  smallCell: { fontSize: 13, color: COLORS.TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  smallButton: { padding: '8px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT },
  previewBackdrop: { position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  previewDialog: { background: '#fff', borderRadius: 8, padding: 12, boxShadow: '0 16px 42px rgba(0,0,0,.28)' },
  previewImageWrap: { position: 'relative', background: '#fff' },
  previewImage: { maxWidth: '80vw', maxHeight: '70vh', objectFit: 'contain', display: 'block' },
  previewInfo: { position: 'absolute', left: 4, top: 4, background: '#333', color: '#fff', fontSize: 12, padding: '4px 6px', borderRadius: 3 },
  previewActions: { display: 'flex', justifyContent: 'center', gap: 8, marginTop: 10 },
  zoomBackdrop: { position: 'fixed', inset: 0, zIndex: 1200, background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  zoomWrap: { position: 'relative', maxWidth: '96vw', maxHeight: '94vh' },
  zoomImage: { maxWidth: '96vw', maxHeight: '94vh', objectFit: 'contain', display: 'block' },
};

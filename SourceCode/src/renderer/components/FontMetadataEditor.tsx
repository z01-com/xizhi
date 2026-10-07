import React, { useMemo, useState } from 'react';
import { COLORS, FX_EXT_SCHEMA, UI_FONT } from '@shared/constants';
import { LoadingOverlay } from './LoadingOverlay';
import { PathTools } from './PathTools';

interface FontMetadataEditorProps {
  showToast: (message: string, type: 'info' | 'success' | 'error') => void;
}

type ExtValue = { en: string; zh: string; clear: boolean };

export const FontMetadataEditor: React.FC<FontMetadataEditorProps> = ({ showToast }) => {
  const [inputPath, setInputPath] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [base, setBase] = useState({
    ename: 'Zoomla Font',
    cname: '逐浪字库',
    styleEn: 'Regular',
    styleZh: '常规',
    created: '',
    modified: '',
  });
  const [ext, setExt] = useState<Record<string, ExtValue>>(() => {
    const values: Record<string, ExtValue> = {};
    for (const item of FX_EXT_SCHEMA) {
      values[String(item.id)] = { en: item.defEn || item.default || '', zh: item.defZh || '', clear: false };
    }
    return values;
  });
  const [busy, setBusy] = useState(false);

  const psName = useMemo(() => base.ename.replace(/[^A-Za-z0-9-]/g, '') || 'ZoomlaFont', [base.ename]);

  const selectInput = async () => {
    const file = await window.electronAPI.openFile({
      properties: ['openFile'],
      filters: [{ name: 'Font files', extensions: ['ttf', 'otf'] }],
    });
    if (file) {
      setInputPath(file);
      setOutputPath(file.replace(/\.(ttf|otf)$/i, '_fix.ttf'));
    }
  };

  const selectOutput = async () => {
    const file = await window.electronAPI.saveFile({
      defaultPath: outputPath || inputPath.replace(/\.(ttf|otf)$/i, '_fix.ttf'),
      filters: [{ name: 'Font files', extensions: ['ttf', 'otf'] }],
    });
    if (file) {
      setOutputPath(file);
    }
  };

  const buildPayload = () => {
    const nameMetadata: Record<string, Record<string, string>> = {
      '1': { en: base.ename, zh: base.cname },
      '2': { en: base.styleEn, zh: base.styleZh },
      '3': { en: psName, zh: psName },
      '4': { en: `${base.ename} ${base.styleEn}`, zh: `${base.cname} ${base.styleZh}` },
      '6': { en: `${psName}-${base.styleEn.replace(/\s+/g, '') || 'Regular'}` },
      '16': { en: base.ename, zh: base.cname },
      '17': { en: base.styleEn, zh: base.styleZh },
    };
    const advancedMetadata: Record<string, any> = {
      created: base.created,
      modified: base.modified,
    };
    for (const item of FX_EXT_SCHEMA) {
      const key = String(item.id);
      const value = ext[key];
      if (!value) {
        continue;
      }
      if (key === 'vendor') {
        if (value.clear) {
          advancedMetadata.clear_vendor = true;
        } else {
          advancedMetadata.vendor_id = value.en;
        }
      } else if (value.clear) {
        nameMetadata[key] = { en: '', zh: '' };
      } else if (item.type === 'link' || item.type === 'single') {
        nameMetadata[key] = { en: value.en };
      } else {
        nameMetadata[key] = { en: value.en, zh: value.zh };
      }
    }
    return { nameMetadata, advancedMetadata };
  };

  const saveMetadata = async () => {
    if (!inputPath || !outputPath) {
      showToast('请先选择输入字体和输出路径', 'error');
      return;
    }
    setBusy(true);
    try {
      const { nameMetadata, advancedMetadata } = buildPayload();
      const result = await window.electronAPI.modifyFontMetadata({
        inputPath,
        outputPath,
        nameMetadata,
        advancedMetadata,
      });
      if (result.success) {
        showToast(`字性处理完成：${result.outputPath}`, 'success');
      } else {
        showToast(result.error || '字性处理失败', 'error');
      }
    } catch (error: any) {
      showToast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const updateExt = (key: string, patch: Partial<ExtValue>) => {
    setExt({ ...ext, [key]: { ...ext[key], ...patch } });
  };

  return (
    <div style={styles.container}>
      <LoadingOverlay visible={busy} />
      <h2 style={styles.sectionTitle}>字性处理 - 字体元数据编辑</h2>

      <div style={styles.card}>
        <h3 style={styles.subTitle}>输入输出</h3>
        <div style={styles.controls}>
          <PathTools value={inputPath} placeholder="选择原始 TTF 字体" onBrowse={selectInput} />
        </div>
        <div style={styles.controls}>
          <PathTools value={outputPath} placeholder="输出 TTF 路径" onBrowse={selectOutput} />
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.subTitle}>基础 Name 表</h3>
        <div style={styles.formGrid}>
          {baseFields.map(field => (
            <label key={field.key} style={styles.formItem}>
              <span style={styles.label}>{field.label}</span>
              <input
                value={base[field.key as keyof typeof base]}
                onChange={event => setBase({ ...base, [field.key]: event.target.value })}
                style={styles.input}
              />
            </label>
          ))}
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.subTitle}>扩展参数</h3>
        <div style={styles.extGrid}>
          {FX_EXT_SCHEMA.map(item => {
            const key = String(item.id);
            const value = ext[key];
            return (
              <div key={key} style={styles.extItem}>
                <label style={styles.checkRow}>
                  <input type="checkbox" checked={value.clear} onChange={event => updateExt(key, { clear: event.target.checked })} />
                  <span style={styles.label}>{item.name}</span>
                </label>
                <input disabled={value.clear} value={value.en} onChange={event => updateExt(key, { en: event.target.value })} placeholder="English" style={styles.input} />
                {item.type === 'dual' && (
                  <input disabled={value.clear} value={value.zh} onChange={event => updateExt(key, { zh: event.target.value })} placeholder="中文" style={styles.input} />
                )}
              </div>
            );
          })}
        </div>
        <button style={{ ...styles.primaryButton, marginTop: 16 }} onClick={saveMetadata} disabled={busy}>
          {busy ? '处理中...' : '编译双语全属性'}
        </button>
      </div>
    </div>
  );
};

const baseFields = [
  { key: 'ename', label: '英文家族名' },
  { key: 'cname', label: '中文家族名' },
  { key: 'styleEn', label: '英文样式' },
  { key: 'styleZh', label: '中文样式' },
  { key: 'created', label: '创建时间 YYYY-MM-DD HH:MM:SS' },
  { key: 'modified', label: '修改时间 YYYY-MM-DD HH:MM:SS' },
];

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 1200, margin: '0 auto', position: 'relative', minHeight: 360 },
  sectionTitle: { fontSize: 20, color: COLORS.TEXT, marginBottom: 16 },
  card: { backgroundColor: COLORS.CARD, borderRadius: 8, padding: 20, marginBottom: 16, boxShadow: `0 2px 8px ${COLORS.BORDER}` },
  subTitle: { fontSize: 16, color: COLORS.TEXT, marginBottom: 12 },
  controls: { display: 'flex', gap: 12, marginBottom: 12 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 },
  extGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 },
  formItem: { display: 'flex', flexDirection: 'column', gap: 4 },
  extItem: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, border: `1px solid ${COLORS.BORDER}`, borderRadius: 6 },
  checkRow: { display: 'flex', gap: 8, alignItems: 'center' },
  label: { fontSize: 12, color: COLORS.TEXT_LIGHT },
  input: { padding: '8px 12px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT, fontSize: 14 },
  actionButton: { padding: '9px 18px', backgroundColor: COLORS.GREEN, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  primaryButton: { padding: '10px 24px', backgroundColor: COLORS.ACCENT, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
};

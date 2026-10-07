import React, { useEffect, useState } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

export type SettingsTab = 'general' | 'reference' | 'publish' | 'print';

export const DEFAULT_PREVIEW_SAMPLES = [
  '汉字之美，逐浪而来。中国《论语》千古传育！',
  '标点符号*+-/:;<=>?@[\\]^_`{|}~',
  'abcdefgABCDEFGHIJKLMN0123456789',
];

const REF_FONT_MODES = [
  { value: 'empty', label: '仅空白显示' },
  { value: 'background', label: '背衬显示' },
  { value: 'overlay', label: '上衬显示' },
] as const;

const FONT_TYPES = [
  { value: 'ttf', label: 'TTF' },
  { value: 'woff', label: 'WOFF' },
  { value: 'woff2', label: 'WOFF2' },
] as const;

export function parseSmallJsonSetting<T>(raw: string, fallback: T, maxLength = 100_000): T {
  if (!raw || raw.length > maxLength) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const COLOR_MODES = [
  { value: 'mono', label: '黑白模式', spec: 'NO' },
  { value: 'colr', label: '图层式彩色（微软规范）', spec: 'COLR (layered glyphs)' },
  { value: 'svg-fixed', label: 'SVG无色板固定颜色（Adobe、Mozilla规范）', spec: 'SVG without color palettes' },
  { value: 'svg-palette', label: 'SVG带色板可变颜色', spec: 'SVG with color palettes' },
  { value: 'compatible', label: '全兼容彩色', spec: 'Both COLR and SVG' },
] as const;

export function normalizeColorMode(value: string): string {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase().replace(/[\s_]+/g, '-');
  const aliases: Record<string, string> = {
    '': 'compatible',
    no: 'mono',
    none: 'mono',
    'black-white': 'mono',
    'black-and-white': 'mono',
    mono: 'mono',
    monochrome: 'mono',
    'one-color': 'mono',
    '1-color': 'mono',
    colr: 'colr',
    layered: 'colr',
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
    compatible: 'compatible',
    both: 'compatible',
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
  return COLOR_MODES.some(item => item.value === raw) ? raw : 'mono';
}

export function colorModeLabel(value: string): string {
  const mode = COLOR_MODES.find(item => item.value === normalizeColorMode(value));
  return mode ? `${mode.label} / ${mode.spec}` : COLOR_MODES[0].label;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ onClose, initialTab = 'general' }) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [settings, setSettings] = useState({
    exportDir: '',
    thumbSize: 120,
    pageSize: 200,
    refFont: '微软雅黑',
    refFontMode: 'empty',
    publishFontType: 'ttf',
    publishColorMode: 'compatible',
    previewSamples: DEFAULT_PREVIEW_SAMPLES,
    printShowUni: true,
    printCharSize: 48,
    printPageFormat: '1 / N',
    startupTab: 'start',
  });
  const [systemFonts, setSystemFonts] = useState<Array<{ family: string; path: string }>>([]);
  const [hardwareAccelEnabled, setHardwareAccelEnabled] = useState(true);
  const [hardwareAccelChanged, setHardwareAccelChanged] = useState(false);
  const [fileAssocStatus, setFileAssocStatus] = useState<'idle' | 'registering' | 'success' | 'error'>('idle');
  const [fileAssocError, setFileAssocError] = useState('');

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    Promise.all([
      window.electronAPI.dbGetSetting('exportDir', ''),
      window.electronAPI.dbGetSetting('thumbSize', '120'),
      window.electronAPI.dbGetSetting('pageSize', '200'),
      window.electronAPI.dbGetSetting('refFont', '微软雅黑'),
      window.electronAPI.dbGetSetting('refFontMode', 'empty'),
      window.electronAPI.dbGetSetting('publishFontType', 'ttf'),
      window.electronAPI.dbGetSetting('publishColorMode', 'compatible'),
      window.electronAPI.dbGetSetting('previewSamples', JSON.stringify(DEFAULT_PREVIEW_SAMPLES)),
      window.electronAPI.dbGetSetting('printShowUni', 'true'),
      window.electronAPI.dbGetSetting('printCharSize', '48'),
      window.electronAPI.dbGetSetting('printPageFormat', '1 / N'),
      window.electronAPI.dbGetSetting('startupTab', 'start'),
      window.electronAPI.listSystemFonts(),
      window.electronAPI.getHardwareAcceleration(),
    ]).then(([exportDir, thumbSize, pageSize, refFont, refFontMode, publishFontType, publishColorMode, previewSamplesRaw, printShowUni, printCharSize, printPageFormat, startupTabRaw, fonts, hwAccel]) => {
      let previewSamples = DEFAULT_PREVIEW_SAMPLES;
      try {
        const parsed = parseSmallJsonSetting<unknown>(String(previewSamplesRaw || '[]'), []);
        if (Array.isArray(parsed) && parsed.some(item => String(item || '').trim())) {
          previewSamples = parsed.map(item => String(item || '').slice(0, 500)).filter(Boolean).slice(0, 20);
        }
      } catch {
        previewSamples = DEFAULT_PREVIEW_SAMPLES;
      }

      setSettings(prev => ({
        ...prev,
        exportDir,
        thumbSize: Number(thumbSize) || 120,
        pageSize: Number(pageSize) || 200,
        refFont,
        refFontMode,
        publishFontType,
        publishColorMode: normalizeColorMode(publishColorMode),
        previewSamples,
        printShowUni: printShowUni === 'true' || printShowUni === '',
        printCharSize: Number(printCharSize) || 48,
        printPageFormat: printPageFormat || '1 / N',
        startupTab: startupTabRaw || 'start',
      }));
      setSystemFonts(fonts || []);
      setHardwareAccelEnabled(!!hwAccel);
    }).catch(() => {});
  }, []);

  const chooseExportDir = async () => {
    const dir = await window.electronAPI.openDirectory({ defaultPath: settings.exportDir || undefined });
    if (dir) setSettings({ ...settings, exportDir: dir });
  };

  const updateSample = (index: number, value: string) => {
    const next = [...settings.previewSamples];
    next[index] = value;
    setSettings({ ...settings, previewSamples: next });
  };

  const deleteSample = (index: number) => {
    setSettings({ ...settings, previewSamples: settings.previewSamples.filter((_item, itemIndex) => itemIndex !== index) });
  };

  const save = async () => {
    await Promise.all([
      window.electronAPI.dbSetSetting('exportDir', settings.exportDir),
      window.electronAPI.dbSetSetting('thumbSize', String(settings.thumbSize)),
      window.electronAPI.dbSetSetting('pageSize', String(settings.pageSize)),
      window.electronAPI.dbSetSetting('refFont', settings.refFont),
      window.electronAPI.dbSetSetting('refFontMode', settings.refFontMode),
      window.electronAPI.dbSetSetting('publishFontType', settings.publishFontType),
      window.electronAPI.dbSetSetting('publishColorMode', normalizeColorMode(settings.publishColorMode)),
      window.electronAPI.dbSetSetting('previewSamples', JSON.stringify(settings.previewSamples.map(item => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20))),
      window.electronAPI.dbSetSetting('printShowUni', String(settings.printShowUni)),
      window.electronAPI.dbSetSetting('printCharSize', String(settings.printCharSize)),
      window.electronAPI.dbSetSetting('printPageFormat', settings.printPageFormat),
      window.electronAPI.dbSetSetting('startupTab', settings.startupTab),
    ]);
    onClose();
  };

  return (
    <div style={styles.backdrop}>
      <div style={styles.dialog}>
        <header style={styles.header}>
          <h3 style={styles.title}>设置</h3>
          <button style={styles.closeButton} onClick={onClose}>关闭</button>
        </header>

        <div style={styles.tabs}>
          <button style={activeTab === 'general' ? styles.tabActive : styles.tab} onClick={() => setActiveTab('general')}>常规</button>
          <button style={activeTab === 'reference' ? styles.tabActive : styles.tab} onClick={() => setActiveTab('reference')}>设计参数</button>
          <button style={activeTab === 'publish' ? styles.tabActive : styles.tab} onClick={() => setActiveTab('publish')}>字体发布</button>
          <button style={activeTab === 'print' ? styles.tabActive : styles.tab} onClick={() => setActiveTab('print')}>打印输出</button>
        </div>

        <div style={styles.body}>
          {activeTab === 'general' && (
            <div style={styles.panel}>
              <label style={styles.item}>
                <span>默认导出目录</span>
                <div style={styles.row}>
                  <input value={settings.exportDir} onChange={event => setSettings({ ...settings, exportDir: event.target.value })} style={{ ...styles.input, flex: 1 }} />
                  <button style={styles.actionButton} onClick={chooseExportDir}>选择</button>
                </div>
              </label>

              <label style={styles.item}>
                <span>默认预览大小</span>
                <select value={settings.thumbSize} onChange={event => setSettings({ ...settings, thumbSize: Number(event.target.value) })} style={styles.input}>
                  {[72, 96, 120, 150, 200].map(value => <option key={value} value={value}>{value}px</option>)}
                </select>
              </label>

              <label style={styles.item}>
                <span>每页信息显示数</span>
                <select value={settings.pageSize} onChange={event => setSettings({ ...settings, pageSize: Number(event.target.value) })} style={styles.input}>
                  {[100, 200, 500, 1000, 2000].map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>

              <label style={styles.item}>
                <span>硬件加速</span>
                <select
                  value={hardwareAccelEnabled ? 'enabled' : 'disabled'}
                  onChange={async event => {
                    const enabled = event.target.value === 'enabled';
                    setHardwareAccelEnabled(enabled);
                    await window.electronAPI.setHardwareAcceleration(enabled);
                    setHardwareAccelChanged(true);
                  }}
                  style={styles.input}
                >
                  <option value="enabled">开启（默认，界面更流畅，需显卡支持）</option>
                  <option value="disabled">关闭（兼容性更好，减少进程数）</option>
                </select>
                {hardwareAccelChanged && (
                  <div style={styles.restartHint}>
                    <span>⚠ 更改将在重启后生效</span>
                    <button style={styles.restartButton} onClick={() => window.electronAPI.restartApp()}>立即重启</button>
                  </div>
                )}
              </label>
              <label style={styles.item}>
                <span>默认启动选项卡</span>
                <select value={settings.startupTab} onChange={event => setSettings({ ...settings, startupTab: event.target.value })} style={styles.input}>
                  <option value="start">开始</option>
                  <option value="materials">素材管理</option>
                  <option value="production">生产中心</option>
                  <option value="metadata">字性处理</option>
                  <option value="design">设计台</option>
                  <option value="look">观字</option>
                </select>
              </label>

              <div style={styles.shortcut}>快捷键：F1 帮助，Alt+1~6 切换主模块，Ctrl+Tab / Ctrl+Shift+Tab 切换设计台字形标签。</div>
              <div style={styles.item}>
                <button
                  style={styles.fileAssocButton}
                  disabled={fileAssocStatus === 'registering' || fileAssocStatus === 'success'}
                  onClick={async () => {
                    setFileAssocStatus('registering');
                    setFileAssocError('');
                    try {
                      const result = await window.electronAPI.registerFileAssociation();
                      if (result.success) {
                        setFileAssocStatus('success');
                      } else {
                        setFileAssocStatus('error');
                        setFileAssocError(result.error || '注册失败');
                      }
                    } catch (err: any) {
                      setFileAssocStatus('error');
                      setFileAssocError(err?.message || String(err));
                    }
                  }}
                >
                  {fileAssocStatus === 'idle' && '文件类型注册-将【逐浪羲之】.z01工程文件设为默认双击打开。'}
                  {fileAssocStatus === 'registering' && '正在注册...'}
                  {fileAssocStatus === 'success' && '✓ 已注册 —— .z01 文件已关联图标与打开方式'}
                  {fileAssocStatus === 'error' && '注册失败，点击重试'}
                </button>
                {fileAssocStatus === 'success' && (
                  <span style={{ color: COLORS.TEXT_LIGHT, fontSize: 12 }}>注册使用当前用户权限（HKCU），无需管理员。注册后自动刷新资源管理器使图标立即生效。</span>
                )}
                {fileAssocError && (
                  <span style={{ color: '#b42318', fontSize: 12 }}>{fileAssocError}</span>
                )}
              </div>

            </div>
          )}

          {activeTab === 'reference' && (
            <div style={styles.panel}>
              <label style={styles.item}>
                <span>参考字体</span>
                <select value={settings.refFont} onChange={event => setSettings({ ...settings, refFont: event.target.value })} style={styles.input}>
                  {systemFonts.length === 0 && <option value="微软雅黑">微软雅黑</option>}
                  {systemFonts.map(font => <option key={font.path} value={font.family}>{font.family}</option>)}
                </select>
              </label>

              <div style={styles.item}>
                <span>参考字体显示方式</span>
                <div style={styles.modeRow}>
                  {REF_FONT_MODES.map(mode => (
                    <button key={mode.value} style={settings.refFontMode === mode.value ? styles.modeActive : styles.modeButton} onClick={() => setSettings({ ...settings, refFontMode: mode.value })}>
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={styles.hint}>
                <p style={{ margin: 0 }}>仅空白显示：字符为空时以参考字体显示。</p>
                <p style={{ margin: 0 }}>背衬显示：参考字体在字形下方显示。</p>
                <p style={{ margin: 0 }}>上衬显示：参考字体在字形上方显示。</p>
              </div>

              <div style={styles.item}>
                <span>快速试字样本</span>
                <div style={styles.sampleList}>
                  {settings.previewSamples.map((sample, index) => (
                    <div key={index} style={styles.sampleRow}>
                      <textarea style={styles.sampleInput} value={sample} onChange={event => updateSample(index, event.target.value)} />
                      <button style={styles.sampleDelete} onClick={() => deleteSample(index)}>删除</button>
                    </div>
                  ))}
                </div>
                <button style={styles.actionButton} onClick={() => setSettings({ ...settings, previewSamples: [...settings.previewSamples, ''] })}>增加条目</button>
              </div>

              <div style={styles.hint}>这些文本会显示在字体设计-制版器输入框右侧的下拉菜单中，可用于快速试字，也可以在制版器中自由输入临时文本。</div>
            </div>
          )}

          {activeTab === 'publish' && (
            <div style={styles.panel}>
              <label style={styles.item}>
                <span>默认字体类型</span>
                <select value={settings.publishFontType} onChange={event => setSettings({ ...settings, publishFontType: event.target.value })} style={styles.input}>
                  {FONT_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <span style={styles.spec}>当前工程发布引擎基于 TrueType glyf 轮廓，支持 TTF/WOFF/WOFF2 彩色字体；真 OTF/CFF 彩色发布需要另行接入 CFF 构建链路。</span>
              </label>

              <div style={styles.item}>
                <span>色彩模式</span>
                <div style={styles.radioList}>
                  {COLOR_MODES.map(mode => (
                    <label key={mode.value} style={settings.publishColorMode === mode.value ? styles.radioActive : styles.radioItem}>
                      <input type="radio" name="publishColorMode" checked={settings.publishColorMode === mode.value} onChange={() => setSettings({ ...settings, publishColorMode: mode.value })} />
                      <span>{mode.label}</span>
                      <em style={styles.spec}>{mode.spec}</em>
                    </label>
                  ))}
                </div>
              </div>

              <div style={styles.hint}>发布字体时，设计台会在发布前显示当前字体类型与色彩模式。若需要调整，可从发布确认窗直接返回设置页。</div>
            </div>
          )}

          {activeTab === 'print' && (
            <div style={styles.panel}>
              <label style={styles.item}>
                <span>显示 Uni 码</span>
                <select value={settings.printShowUni ? 'true' : 'false'} onChange={event => setSettings({ ...settings, printShowUni: event.target.value === 'true' })} style={styles.input}>
                  <option value="true">是 —— 每个字符下方显示 Uni 码</option>
                  <option value="false">否 —— 仅显示字符</option>
                </select>
              </label>

              <label style={styles.item}>
                <span>打印字符大小</span>
                <select value={settings.printCharSize} onChange={event => setSettings({ ...settings, printCharSize: Number(event.target.value) })} style={styles.input}>
                  {[24, 32, 40, 48, 64, 80, 96, 120].map(value => <option key={value} value={value}>{value}px</option>)}
                </select>
              </label>

              <label style={styles.item}>
                <span>页码格式</span>
                <select value={settings.printPageFormat} onChange={event => setSettings({ ...settings, printPageFormat: event.target.value })} style={styles.input}>
                  <option value="1 / N">第 1 页 / 共 N 页</option>
                  <option value="1">仅当前页码</option>
                  <option value="-1-">- 1 -</option>
                </select>
              </label>

              <div style={styles.hint}>
                <p style={{ margin: 0 }}>打印样本将按观字右侧筛选器所选范围输出字体字符样本。</p>
                <p style={{ margin: 0 }}>打印结果包含字体标题、分页、页码，每页按所选字符大小自动排版。</p>
                <p style={{ margin: 0 }}>打印操作入口：观字 → 字体列表行右键 → 打印样本。</p>
              </div>
            </div>
          )}
        </div>

        <footer style={styles.footer}>
          <button style={styles.cancelButton} onClick={onClose}>取消</button>
          <button style={styles.primary} onClick={save}>保存设置</button>
        </footer>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
  dialog: { width: 760, maxWidth: '94vw', maxHeight: '88vh', background: '#fff', borderRadius: 8, boxShadow: '0 18px 54px rgba(20,36,60,.28)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { padding: '14px 16px', borderBottom: `1px solid ${COLORS.BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 },
  title: { margin: 0, color: COLORS.TEXT, fontSize: 18 },
  closeButton: { padding: '6px 12px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  tabs: { display: 'flex', gap: 0, borderBottom: `1px solid ${COLORS.BORDER}`, background: '#fff', flexShrink: 0 },
  tab: { padding: '10px 18px', border: 0, borderRight: `1px solid ${COLORS.BORDER}`, background: '#f6f9fd', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14 },
  tabActive: { padding: '10px 18px', border: 0, borderRight: `1px solid ${COLORS.BORDER}`, background: '#fff', color: COLORS.ACCENT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14, fontWeight: 700 },
  body: { padding: 16, overflow: 'auto', minHeight: 0, flex: 1 },
  panel: { display: 'flex', flexDirection: 'column', gap: 14 },
  item: { display: 'flex', flexDirection: 'column', gap: 6, color: COLORS.TEXT, fontSize: 13 },
  row: { display: 'flex', gap: 8 },
  input: { padding: 8, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, fontFamily: UI_FONT, background: '#fff' },
  modeRow: { display: 'flex', gap: 0, flexWrap: 'wrap' },
  modeButton: { padding: '8px 16px', border: `1px solid ${COLORS.BORDER}`, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  modeActive: { padding: '8px 16px', border: `1px solid ${COLORS.ACCENT}`, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  radioList: { display: 'flex', flexDirection: 'column', gap: 8 },
  radioItem: { display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) minmax(180px, .8fr)', gap: 8, alignItems: 'center', padding: '9px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 5, color: COLORS.TEXT, background: '#fff' },
  radioActive: { display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) minmax(180px, .8fr)', gap: 8, alignItems: 'center', padding: '9px 10px', border: `1px solid ${COLORS.ACCENT}`, borderRadius: 5, color: COLORS.TEXT, background: '#eef6ff' },
  spec: { color: COLORS.TEXT_LIGHT, fontStyle: 'normal', fontSize: 12 },
  hint: { padding: 10, background: '#f0f4fa', borderRadius: 4, color: COLORS.TEXT_LIGHT, fontSize: 12, lineHeight: 1.7 },
  shortcut: { padding: 10, background: COLORS.SELECT, borderRadius: 4, color: COLORS.TEXT_LIGHT, fontSize: 12 },
  sampleList: { display: 'flex', flexDirection: 'column', gap: 8 },
  sampleRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 64px', gap: 8, alignItems: 'stretch' },
  sampleInput: { minHeight: 54, padding: 8, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, resize: 'vertical', fontFamily: UI_FONT, fontSize: 13, lineHeight: 1.5 },
  sampleDelete: { border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: '#b42318', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  footer: { padding: 12, borderTop: `1px solid ${COLORS.BORDER}`, display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0, background: '#fff' },
  actionButton: { padding: '8px 14px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#f5f8fc', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  fileAssocButton: { padding: '10px 10px', border: `1px solid ${COLORS.GRID_LIGHT}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT_LIGHT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 12, textAlign: 'left' as const },
  cancelButton: { padding: '8px 16px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  primary: { padding: '8px 16px', border: 0, borderRadius: 4, background: COLORS.ACCENT, color: '#fff', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13 },
  restartHint: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: '#fff8e1', borderRadius: 4, border: '1px solid #f9a825', color: '#5d4037', fontSize: 13, marginTop: 4 },
  restartButton: { padding: '6px 14px', border: 0, borderRadius: 4, background: '#f57c00', color: '#fff', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, fontWeight: 700 },
};

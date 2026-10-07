import React, { useCallback, useEffect, useState } from 'react';
import { COLORS, DEFAULT_THUMB_SIZE, UI_FONT } from '@shared/constants';
import { DesignStudio } from './components/DesignStudio';
import { FontMetadataEditor } from './components/FontMetadataEditor';
import { FontLook } from './components/FontLook';
import { GlyphBrowser } from './components/GlyphBrowser';
import { HelpDialog } from './components/HelpDialog';
import { LoadingOverlay } from './components/LoadingOverlay';
import { LiveLogPanel } from './components/LiveLogPanel';
import { LogViewer } from './components/LogViewer';
import { MaterialManager } from './components/MaterialManager';
import { PathTools } from './components/PathTools';
import { ProductionCenter } from './components/ProductionCenter';
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog';
import { Toast } from './components/Toast';

const appIcon = new URL('./assets/app.ico', import.meta.url).href;

type TabType = 'start' | 'materials' | 'production' | 'metadata' | 'design' | 'look';
type ThemeTone = 'white' | 'gray' | 'red' | 'black';

type ToastState = { message: string; type: 'info' | 'success' | 'error' } | null;
type GlyphAnalysisRecord = { path: string; family: string; glyphCount: number; time: string };

const THEME_TONES: Array<{ id: ThemeTone; title: string; swatch: string }> = [
  { id: 'white', title: '默认白', swatch: '#ffffff' },
  { id: 'gray', title: '灰色系', swatch: '#8b96a3' },
  { id: 'red', title: '红色系', swatch: '#d13f3f' },
  { id: 'black', title: '黑色系', swatch: '#1b1f26' },
];

const THEME_VARS: Record<ThemeTone, React.CSSProperties> = {
  white: { '--app-bg': COLORS.BG, '--app-title-bg': '#ffffff', '--app-title-symbol': COLORS.TEXT, '--app-menu-bg': COLORS.CARD, '--app-menu-text': COLORS.TEXT, '--app-menu-muted': COLORS.TEXT_LIGHT, '--app-button-bg': '#ffffff', '--app-tab-bg': '#eef4fb', '--app-accent': COLORS.ACCENT, '--app-border': COLORS.BORDER } as React.CSSProperties,
  gray: { '--app-bg': '#edf0f3', '--app-title-bg': '#e7ebef', '--app-title-symbol': '#29313a', '--app-menu-bg': '#f8f9fa', '--app-menu-text': '#29313a', '--app-menu-muted': '#6b7682', '--app-button-bg': '#ffffff', '--app-tab-bg': '#e2e6ea', '--app-accent': '#5f6f82', '--app-border': '#c7cdd4' } as React.CSSProperties,
  red: { '--app-bg': '#fff1f1', '--app-title-bg': '#ffe1e1', '--app-title-symbol': '#4d1d1d', '--app-menu-bg': '#fff8f8', '--app-menu-text': '#4d1d1d', '--app-menu-muted': '#9b6b6b', '--app-button-bg': '#ffffff', '--app-tab-bg': '#ffe2e2', '--app-accent': '#d13f3f', '--app-border': '#efc6c6' } as React.CSSProperties,
  black: { '--app-bg': '#171a1f', '--app-title-bg': '#22262d', '--app-title-symbol': '#edf0f4', '--app-menu-bg': '#22262d', '--app-menu-text': '#f5f7fa', '--app-menu-muted': '#c7ced8', '--app-button-bg': '#2f3640', '--app-tab-bg': '#303640', '--app-accent': '#4f8cff', '--app-border': '#56606c' } as React.CSSProperties,
};

const parseJsonSetting = <T,>(raw: string, fallback: T, maxLength = 100_000): T => {
  if (!raw || raw.length > maxLength) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('start');
  const [isTopmost, setIsTopmost] = useState(false);
  const [fontPath, setFontPath] = useState('');
  const [fontMetrics, setFontMetrics] = useState<any>(null);
  const [glyphCodes, setGlyphCodes] = useState<number[]>([]);
  const [showBrowser, setShowBrowser] = useState(false);
  const [logs, setLogs] = useState<Array<{ id: number; created: Date; message: string }>>([]);
  const [showLog, setShowLog] = useState(false);
  const [showLiveLog, setShowLiveLog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general');
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [glyphRecent, setGlyphRecent] = useState<GlyphAnalysisRecord[]>([]);
  const [glyphRecentCollapsed, setGlyphRecentCollapsed] = useState(false);
  const [recentMenu, setRecentMenu] = useState<{ x: number; y: number; record: GlyphAnalysisRecord } | null>(null);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [themeTone, setThemeTone] = useState<ThemeTone>('white');
  const [fontStatus, setFontStatus] = useState<{ path: string; name: string } | null>(null);
  const [designProjectPath, setDesignProjectPath] = useState('');

  const showToast = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const openSettings = useCallback((tab: SettingsTab = 'general') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  const changeThemeTone = useCallback(async (tone: ThemeTone) => {
    setThemeTone(tone);
    await window.electronAPI.dbSetSetting('ui.themeTone', tone);
    const vars = THEME_VARS[tone] as Record<string, string>;
    await window.electronAPI.setTitleBarTheme({ color: vars['--app-title-bg'], symbolColor: vars['--app-title-symbol'] }).catch(() => ({ success: false }));
  }, []);

  const openOfficialSite = useCallback(async () => {
    setHelpMenuOpen(false);
    const result = await window.electronAPI.openExternal('http://www.z01.cn');
    if (!result.success) showToast(result.error || '无法打开官方网站', 'error');
  }, [showToast]);

  const openDesignProjectFromLook = useCallback((projectPath: string) => {
    setDesignProjectPath(projectPath);
    setActiveTab('design');
  }, []);

  const loadLogs = useCallback(async () => {
    setLogs(await window.electronAPI.dbGetLogs(500));
  }, []);

  const loadGlyphRecent = useCallback(async () => {
    try {
      const [raw, collapsed] = await Promise.all([
        window.electronAPI.dbGetSetting('glyphAnalysisRecent', '[]'),
        window.electronAPI.dbGetSetting('ui.startRecentCollapsed', 'false'),
      ]);
      const parsed = parseJsonSetting<unknown>(raw, []);
      setGlyphRecent(Array.isArray(parsed) ? parsed.slice(0, 30) : []);
      setGlyphRecentCollapsed(collapsed === 'true');
    } catch {
      setGlyphRecent([]);
    }
  }, []);

  const toggleGlyphRecentCollapsed = useCallback(async () => {
    const next = !glyphRecentCollapsed;
    setGlyphRecentCollapsed(next);
    await window.electronAPI.dbSetSetting('ui.startRecentCollapsed', String(next));
  }, [glyphRecentCollapsed]);

  const saveGlyphRecent = useCallback(async (record: GlyphAnalysisRecord) => {
    const next = [record, ...glyphRecent.filter(item => item.path !== record.path)].slice(0, 30);
    setGlyphRecent(next);
    await window.electronAPI.dbSetSetting('glyphAnalysisRecent', JSON.stringify(next));
  }, [glyphRecent]);

  const deleteGlyphRecent = useCallback(async (path: string) => {
    const next = glyphRecent.filter(item => item.path !== path);
    setGlyphRecent(next);
    setRecentMenu(null);
    await window.electronAPI.dbSetSetting('glyphAnalysisRecent', JSON.stringify(next));
    showToast('记录已删除', 'success');
  }, [glyphRecent, showToast]);

  const analyzeFont = useCallback(async (path: string) => {
    if (!(await window.electronAPI.fsExists(path))) {
      showToast(`目标资源不存在或已被移动/删除：${path}`, 'error');
      return;
    }
    setLoadingMessage('系统数据加载中...');
    try {
      const result = await window.electronAPI.analyzeFont(path);
      if (result.success) {
        setFontPath(path);
        setFontMetrics(result.metrics);
        setGlyphCodes(result.codes);
        setShowBrowser(true);
        await saveGlyphRecent({ path, family: result.metrics.family, glyphCount: result.codes.length, time: new Date().toLocaleString() });
        showToast(`字体分析完成：${result.codes.length} 个字符`, 'success');
      } else {
        showToast(result.error || '字体分析失败', 'error');
      }
    } finally {
      setLoadingMessage('');
    }
  }, [saveGlyphRecent, showToast]);

  const openExistingPath = useCallback(async (target: string, fallbackMessage = '目标资源不存在或已被移动/删除') => {
    if (!target || !(await window.electronAPI.fsExists(target))) {
      showToast(`${fallbackMessage}：${target || '空路径'}`, 'error');
      return;
    }
    const result = await window.electronAPI.openPath(target);
    if (!result.success) showToast(result.error || `无法打开：${target}`, 'error');
  }, [showToast]);

  const openExistingDirOf = useCallback(async (target: string) => {
    if (!target || !(await window.electronAPI.fsExists(target))) {
      showToast(`目标资源不存在或已被移动/删除：${target || '空路径'}`, 'error');
      return;
    }
    await openExistingPath(await window.electronAPI.pathDirname(target), '目标目录不存在或无法访问');
  }, [openExistingPath, showToast]);

  useEffect(() => {
    loadLogs();
    loadGlyphRecent();
    // 默认启动选项卡
    window.electronAPI.dbGetSetting('startupTab', 'start').then(value => {
      const tabs: TabType[] = ['start', 'materials', 'production', 'metadata', 'design', 'look'];
      if (tabs.includes(value as TabType)) setActiveTab(value as TabType);
    }).catch(() => {});
    window.electronAPI.dbGetSetting('ui.themeTone', 'white').then(value => {
      if (THEME_TONES.some(item => item.id === value)) {
        const tone = value as ThemeTone;
        const vars = THEME_VARS[tone] as Record<string, string>;
        setThemeTone(tone);
        void window.electronAPI.setTitleBarTheme({ color: vars['--app-title-bg'], symbolColor: vars['--app-title-symbol'] }).catch(() => ({ success: false }));
      }
    }).catch(() => {});
    const unsubTopmost = window.electronAPI.on('menu:topmost', async () => {
      setIsTopmost(await window.electronAPI.setAlwaysOnTop(!isTopmost));
    });
    const unsubLog = window.electronAPI.on('menu:log', () => setShowLog(true));
    const unsubSettings = window.electronAPI.on('menu:settings', () => openSettings());
    const unsubHelp = window.electronAPI.on('menu:help', () => setShowHelp(true));
    const unsubStart = window.electronAPI.on('menu:start', () => setActiveTab('start'));
    return () => {
      unsubTopmost?.unsubscribe();
      unsubLog?.unsubscribe();
      unsubSettings?.unsubscribe();
      unsubHelp?.unsubscribe();
      unsubStart?.unsubscribe();
    };
  }, [isTopmost, loadGlyphRecent, loadLogs, openSettings]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F1') {
        event.preventDefault();
        setShowHelp(true);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const keyMap: Record<string, () => void> = {
        '1': () => setActiveTab('start'),
        '2': () => setActiveTab('materials'),
        '3': () => setActiveTab('production'),
        '4': () => setActiveTab('metadata'),
        '5': () => setActiveTab('design'),
        '6': () => setActiveTab('look'),
        '7': () => setShowLog(true),
      };
      const action = keyMap[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const selectFontFile = async () => {
    const path = await window.electronAPI.openFile({
      properties: ['openFile'],
      defaultPath: fontPath || undefined,
      filters: [{ name: 'Font files', extensions: ['ttf', 'otf'] }],
    });
    if (path) setFontPath(path);
  };

  const runGlyphAnalysis = async () => {
    if (!fontPath) {
      const path = await window.electronAPI.openFile({
        properties: ['openFile'],
        filters: [{ name: 'Font files', extensions: ['ttf', 'otf'] }],
      });
      if (path) await analyzeFont(path);
      return;
    }
    await analyzeFont(fontPath);
  };

  const renderStart = () => (
    <div style={styles.container} onClick={() => setRecentMenu(null)}>
      <div style={styles.card}>
        <h2 style={styles.sectionTitle}>起手 - 分析字体</h2>
        <div style={styles.controls}>
          <PathTools value={fontPath} placeholder="点击选择 TTF/OTF 字体文件" onBrowse={selectFontFile} inputStyle={{ minWidth: 360 }} />
          <button style={styles.actionButton} onClick={runGlyphAnalysis}>字形分析</button>
        </div>
        {fontMetrics && (
          <div style={styles.info}>
            <span>家族：{fontMetrics.family}</span>
            <span>字符：{glyphCodes.length}</span>
            <span>UPM：{fontMetrics.upm}</span>
            <span>Asc：{fontMetrics.ascent}</span>
            <span>Desc：{fontMetrics.descent}</span>
          </div>
        )}
        <div style={styles.startHelp}>
          <strong>操作说明</strong>
          <p>1. 选定 TTF/OTF 字体后点击【字形分析】，弹出大窗口直观展示全部字符 Uni 码。</p>
          <p>2. 字形浏览器支持鼠标拖拽框选、Ctrl 点选、Shift 范围多选，右键菜单快捷操作。</p>
          <p>3. 点击【导出所选】选择格式 PNG/JPG/SVG/EPS 与尺寸 200*200 到 1800*1800，批量导出到指定目录。</p>
          <p>4. 文件名直接采用汉字命名，如 我.png、你.png、他.png，特殊字符自动回退为 uniXXXX，便于检索与后续合成。</p>
        </div>
        <div style={styles.recentBox}>
          <h3 style={styles.recentTitle}>最近操作<button type="button" title={glyphRecentCollapsed ? '展开' : '折叠'} style={styles.collapseButton} onClick={toggleGlyphRecentCollapsed}><i className={glyphRecentCollapsed ? 'ri-arrow-up-wide-fill' : 'ri-arrow-down-wide-fill'} /></button></h3>
          {!glyphRecentCollapsed && (
            <div style={styles.recentList}>
              {glyphRecent.length === 0 && <div style={styles.emptyRecent}>暂无字形分析记录</div>}
              {glyphRecent.map(record => (
                <div key={record.path} style={styles.recentRow}>
                  <button style={styles.recentMain} onDoubleClick={() => analyzeFont(record.path)} onContextMenu={event => { event.preventDefault(); setRecentMenu({ x: event.clientX, y: event.clientY, record }); }} title={record.path}>
                    <span style={styles.recentTime}>{record.time}</span>
                    <span style={styles.recentPath}>{record.family || '字体'} | {record.glyphCount || 0} 字 | {record.path}</span>
                  </button>
                  <button style={styles.recentButton} onClick={() => analyzeFont(record.path)}>字形分析</button>
                  <button style={styles.recentButton} onClick={() => void openExistingDirOf(record.path)}>open</button>
                  <button style={styles.recentButton} onClick={() => void openExistingPath(record.path)}>view</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderTab = () => {
    if (activeTab === 'start') return renderStart();
    if (activeTab === 'materials') return <MaterialManager showToast={showToast} />;
    if (activeTab === 'production') return <ProductionCenter showToast={showToast} />;
    if (activeTab === 'metadata') return <FontMetadataEditor showToast={showToast} />;
    return null;
  };

  return (
    <div style={{ ...styles.app, ...THEME_VARS[themeTone] }}>
      {helpMenuOpen && <div style={styles.menuDismissLayer} onClick={() => setHelpMenuOpen(false)} />}
      <div style={styles.titleBar}>
        <div style={styles.titleDragRegion}>
          <img src={appIcon} alt="" style={styles.titleIcon} />
          <span style={styles.titleBrand}>逐浪羲之{appVersion} - 仓颉造字开华夏·逐浪字库团队荣耀出品z01.cn</span>
        </div>
        <div style={styles.windowControls}>
          <button style={styles.windowButton} title="最小化" onClick={() => void window.electronAPI.minimizeWindow()}><i className="ri-subtract-line" /></button>
          <button style={styles.windowButton} title="最大化/还原" onClick={() => void window.electronAPI.toggleMaximizeWindow()}><i className="ri-checkbox-blank-line" /></button>
          <button style={styles.windowCloseButton} title="关闭" onClick={() => void window.electronAPI.closeWindow()}><i className="ri-close-line" /></button>
        </div>
      </div>
      <div style={styles.textMenuBar}>
        <button style={styles.textMenuItem} onClick={() => setActiveTab('start')}>开始</button>
        {/* <button style={styles.textMenuItem} onClick={() => setActiveTab('materials')}>素材管理</button>
        <button style={styles.textMenuItem} onClick={() => setActiveTab('production')}>生产中心</button>
        <button style={styles.textMenuItem} onClick={() => setActiveTab('metadata')}>字性处理</button>
        <button style={styles.textMenuItem} onClick={() => setActiveTab('design')}>设计台</button>
        <button style={styles.textMenuItem} onClick={() => setActiveTab('look')}>观字</button> */}
        <button style={styles.textMenuItem} onClick={() => setShowLog(true)}>日志</button>
        <button style={styles.textMenuItem} onClick={() => openSettings()}>设置</button>
        <div style={styles.textMenuGroup}>
          <button style={styles.textMenuItem} onClick={() => setHelpMenuOpen(value => !value)}>帮助</button>
          {helpMenuOpen && (
            <div style={styles.helpDropdown} onClick={event => event.stopPropagation()}>
              <button style={styles.contextMenuItem} onClick={() => { setHelpMenuOpen(false); setShowHelp(true); }}>使用手册</button>
              <button style={styles.contextMenuItem} onClick={() => void openOfficialSite()}>官方网站</button>
              <button style={styles.contextMenuItem} onClick={async () => { setHelpMenuOpen(false); setAppVersion(await window.electronAPI.getAppVersion()); setShowAbout(true); }}>关于</button>
            </div>
          )}
        </div>
        {/* <button style={styles.textMenuItem} onClick={async () => setIsTopmost(await window.electronAPI.setAlwaysOnTop(!isTopmost))}>钉住</button> */}
      </div>
      <div style={styles.menuBar}>
        <button title="Alt+1" style={tabButton(activeTab === 'start')} onClick={() => setActiveTab('start')}><i className="ri-font-size-2" />开始</button>
        <button title="Alt+2" style={tabButton(activeTab === 'materials')} onClick={() => setActiveTab('materials')}><i className="ri-gallery-upload-line" />素材管理</button>
        <button title="Alt+3" style={tabButton(activeTab === 'production')} onClick={() => setActiveTab('production')}><i className="ri-tools-line" />生产中心</button>
        <button title="Alt+4" style={tabButton(activeTab === 'metadata')} onClick={() => setActiveTab('metadata')}><i className="ri-file-list-3-line" />字性处理</button>
        <button title="Alt+5" style={tabButton(activeTab === 'design')} onClick={() => setActiveTab('design')}><i className="ri-pencil-ruler-2-line" />设计台</button>
        <button title="Alt+6" style={tabButton(activeTab === 'look')} onClick={() => setActiveTab('look')}><i className="ri-eye-2-line" />观字</button>
        <span style={{ flex: 1 }} />
        {/* <button title="Alt+7" style={styles.menuButton} onClick={() => setShowLog(true)}><i className="ri-terminal-box-line" />日志</button>
        <button style={styles.menuButton} onClick={() => setShowHelp(true)}><i className="ri-question-line" />帮助</button> */}
        <button style={styles.menuButton} onClick={() => openSettings()}><i className="ri-settings-3-line" /></button>
        <div style={styles.themeCapsule} aria-label="主题换色">
          {THEME_TONES.map((item, index) => (
            <button
              key={item.id}
              type="button"
              title={item.title}
              style={{
                ...(themeTone === item.id ? styles.themeSegmentActive : styles.themeSegment),
                background: item.swatch,
                ...(index === 0 ? { borderTopLeftRadius: 16, borderBottomLeftRadius: 16 } : {}),
              }}
              onClick={() => void changeThemeTone(item.id)}
            >
              <span style={styles.themeSegmentLabel} />
            </button>
          ))}
        </div>
        <button style={styles.menuButton} onClick={async () => setIsTopmost(await window.electronAPI.setAlwaysOnTop(!isTopmost))}><i className={isTopmost ? 'ri-pushpin-2-line' : 'ri-unpin-line'} /></button>
        {/* <button style={styles.menuButton} onClick={() => window.electronAPI.quitApp()}><i className="ri-logout-box-r-line" />退出</button> */}
      </div>

      <div style={{ ...styles.content, display: activeTab === 'design' || activeTab === 'look' ? 'none' : 'block' }}>{renderTab()}</div>
      <div style={{ ...styles.content, ...styles.designContent, display: activeTab === 'design' ? 'block' : 'none' }}>
        <DesignStudio showToast={showToast} onOpenSettings={openSettings} openProjectPath={designProjectPath} />
      </div>
      {activeTab === 'look' && (
        <div style={{ ...styles.content, ...styles.designContent }}>
          <FontLook showToast={showToast} onFontSelect={setFontStatus} onCreateProject={openDesignProjectFromLook} />
        </div>
      )}
      <button
        type="button"
        title="实时控制台 / 执行日志"
        style={{ ...styles.liveLogLauncher, ...(showLiveLog ? styles.liveLogLauncherActive : {}) }}
        onClick={() => setShowLiveLog(current => !current)}
      >
        <i className="ri-bubble-chart-line" />
      </button>
      {fontStatus && (
        <div style={styles.statusBar} title={fontStatus.path}>
          <i className="ri-font-size-2" style={{ fontSize: 14 }} />
          <span style={styles.statusName}>{fontStatus.name}</span>
          <span style={styles.statusPath}>{fontStatus.path}</span>
        </div>
      )}
      {showLiveLog && <LiveLogPanel logs={logs} onClose={() => setShowLiveLog(false)} />}

      {activeTab === 'start' && showBrowser && fontMetrics && (
        <GlyphBrowser
          fontPath={fontPath}
          metrics={fontMetrics}
          codes={glyphCodes}
          thumbSize={DEFAULT_THUMB_SIZE}
          onClose={() => setShowBrowser(false)}
          onEdit={() => showToast('字形编辑请进入「设计台」创建或打开 .z01 工程后操作', 'info')}
          showToast={showToast}
          onExport={async (codes, format, size, outputDir) => {
            const result = await window.electronAPI.batchExportGlyphs({ fontPath, codes, format, size, outputDir });
            await window.electronAPI.dbAddLog(`字形浏览导出完成：${format} ${size}*${size}，成功 ${result.success}，失败 ${result.failed}，目录：${outputDir}`);
            await loadLogs();
            return result;
          }}
        />
      )}

      {recentMenu && (
        <div style={{ ...styles.contextMenu, left: recentMenu.x, top: recentMenu.y }} onClick={event => event.stopPropagation()}>
          <button style={styles.contextMenuItem} onClick={() => { const target = recentMenu.record.path; setRecentMenu(null); void analyzeFont(target); }}>字形分析</button>
          <button style={styles.contextMenuItem} onClick={() => void deleteGlyphRecent(recentMenu.record.path)}>删除记录</button>
        </div>
      )}

      {showLog && <LogViewer logs={logs} onClose={() => setShowLog(false)} onRefresh={loadLogs} />}
      {showSettings && <SettingsDialog initialTab={settingsInitialTab} onClose={() => setShowSettings(false)} />}
      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
      {showAbout && (
        <div style={aboutStyles.backdrop} onClick={() => setShowAbout(false)}>
          <div style={aboutStyles.dialog} onClick={e => e.stopPropagation()}>
            <h2 style={aboutStyles.title}>逐浪羲之</h2>
            <div style={aboutStyles.scroll}>
              <p style={aboutStyles.line}>新一代中文字体创作者软件！</p>
              <p style={aboutStyles.line}>基于逐浪字库独家原创的.z01格式，20年经验算法总成。</p>
              <p style={aboutStyles.line}>当前版本号：{appVersion}</p>
              {/* <p style={aboutStyles.spacer} />
              <p style={aboutStyles.line}><strong>上海逐一软件科技有限公司</strong></p>
              <p style={aboutStyles.line}><strong>江西逐浪软件科技有限公司</strong></p>
              <p style={aboutStyles.line}>联合研发</p> */}
              <p style={aboutStyles.spacer} />
              <h3 style={aboutStyles.subtitle}>第三方开源组件</h3>
              <table style={aboutStyles.table}>
                <thead>
                  <tr><th style={aboutStyles.th}>组件</th><th style={aboutStyles.th}>协议</th><th style={aboutStyles.th}>用途</th></tr>
                </thead>
                <tbody>
                  <tr><td style={aboutStyles.td}>React / React-DOM</td><td style={aboutStyles.td}>MIT</td><td style={aboutStyles.td}>UI 框架</td></tr>
                  <tr><td style={aboutStyles.td}>Konva / React-Konva</td><td style={aboutStyles.td}>MIT</td><td style={aboutStyles.td}>矢量画布渲染</td></tr>
                  <tr><td style={aboutStyles.td}>fontkit</td><td style={aboutStyles.td}>MIT</td><td style={aboutStyles.td}>字体文件解析引擎</td></tr>
                  <tr><td style={aboutStyles.td}>@napi-rs/canvas</td><td style={aboutStyles.td}>MIT</td><td style={aboutStyles.td}>图像处理</td></tr>
                  <tr><td style={aboutStyles.td}>sql.js</td><td style={aboutStyles.td}>MIT</td><td style={aboutStyles.td}>SQLite 数据库</td></tr>
                  <tr><td style={aboutStyles.td}>iconv-lite</td><td style={aboutStyles.td}>MIT</td><td style={aboutStyles.td}>字符编码转换</td></tr>
                  <tr><td style={aboutStyles.td}>zico</td><td style={aboutStyles.td}>MIT</td><td style={aboutStyles.td}>逐浪生态图标库</td></tr>
                  <tr><td style={aboutStyles.td}>Remix Icon</td><td style={aboutStyles.td}>Apache-2.0</td><td style={aboutStyles.td}>通用图标库</td></tr>
                </tbody>
              </table>
              <p style={aboutStyles.note}>以上组件的完整许可文本随软件发行包提供，版权归各自原作者所有。</p>
              <p style={aboutStyles.note}>Electron / Vite / TypeScript / electron-builder 等开发工具为构建时依赖,不含在发行包中。</p>
              <p style={aboutStyles.spacer} />
              <p style={aboutStyles.line}>逐浪科技产业集群旗下</p>
              <p style={aboutStyles.line}>基于 Zoomla!逐浪CMS 软件内核</p>
              <p style={aboutStyles.line}>官网：<span style={{ cursor: 'pointer', color: COLORS.ACCENT, textDecoration: 'underline' }} onClick={() => void window.electronAPI.openExternal('http://www.z01.cn')}>www.z01.cn</span></p>

            </div>
            <button style={aboutStyles.closeBtn} onClick={() => setShowAbout(false)}>确定</button>
          </div>
        </div>
      )}
      <LoadingOverlay visible={Boolean(loadingMessage)} message={loadingMessage || '系统数据加载中...'} />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
};

const tabButton = (active: boolean): React.CSSProperties => ({
  ...styles.menuButton,
  backgroundColor: active ? 'var(--app-accent)' : 'var(--app-tab-bg)',
  borderColor: active ? 'var(--app-accent)' : 'var(--app-border)',
  color: active ? '#fff' : 'var(--app-menu-text)',
});

const styles: Record<string, React.CSSProperties> = {
  app: { width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: UI_FONT, backgroundColor: 'var(--app-bg)' },
  titleBar: { height: 32, flexShrink: 0, display: 'flex', alignItems: 'stretch', backgroundColor: 'var(--app-title-bg)', color: 'var(--app-title-symbol)', borderBottom: '1px solid var(--app-border)', position: 'relative', zIndex: 1400 },
  titleDragRegion: { flex: 1, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10, WebkitAppRegion: 'drag' } as React.CSSProperties,
  titleIcon: { width: 18, height: 18, objectFit: 'contain', flexShrink: 0 },
  titleBrand: { fontSize: 13, fontWeight: 600, letterSpacing: 0, color: 'var(--app-title-symbol)', opacity: 0.9 },
  windowControls: { display: 'inline-flex', alignItems: 'stretch', WebkitAppRegion: 'no-drag' } as React.CSSProperties,
  windowButton: { width: 46, height: 32, border: 0, background: 'transparent', color: 'var(--app-title-symbol)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 },
  windowCloseButton: { width: 46, height: 32, border: 0, background: 'transparent', color: 'var(--app-title-symbol)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 },
  textMenuBar: { minHeight: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '0 8px', backgroundColor: 'var(--app-title-bg)', borderBottom: '1px solid var(--app-border)', position: 'relative', zIndex: 3150, WebkitAppRegion: 'no-drag' } as React.CSSProperties,
  textMenuGroup: { position: 'relative', display: 'inline-flex' },
  textMenuItem: { height: 26, padding: '0 10px', border: 0, borderRadius: 3, background: 'transparent', color: 'var(--app-menu-text)', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  helpDropdown: { position: 'absolute', top: 28, left: 0, zIndex: 3200, minWidth: 132, padding: 5, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 5, boxShadow: '0 8px 24px rgba(0,0,0,.2)', display: 'flex', flexDirection: 'column' },
  menuDismissLayer: { position: 'fixed', inset: 0, zIndex: 3000, background: 'transparent' },
  menuBar: { minHeight: 50, flexShrink: 0, display: 'flex', padding: '8px 12px', backgroundColor: 'var(--app-menu-bg)', borderBottom: '1px solid var(--app-border)', gap: 8, alignItems: 'center', position: 'relative', zIndex: 1300, WebkitAppRegion: 'no-drag' } as React.CSSProperties,
  menuButton: { padding: '8px 14px', border: '1px solid var(--app-border)', borderRadius: 4, background: 'var(--app-button-bg)', color: 'var(--app-menu-text)', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 6 },
  themeCapsule: { height: 34, display: 'inline-flex', alignItems: 'center', border: '1px solid var(--app-border)', borderRadius: 999, overflow: 'hidden', background: '#fff', flexShrink: 0 },
  themeSegment: { width: 34, height: 32, padding: 0, border: 0, borderRight: '1px solid rgba(0,0,0,.16)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  themeSegmentActive: { width: 34, height: 32, padding: 0, border: 0, borderRight: '1px solid rgba(0,0,0,.16)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  themeSegmentLabel: { width: 1, height: 1, opacity: 0, display: 'inline-block' },
  content: { flex: 1, padding: 20, overflow: 'auto' },
  designContent: { overflow: 'hidden', minHeight: 0 },
  container: { maxWidth: 1200, margin: '0 auto' },
  card: { backgroundColor: COLORS.CARD, borderRadius: 8, padding: 24, boxShadow: `0 2px 8px ${COLORS.BORDER}` },
  sectionTitle: { fontSize: 20, color: COLORS.TEXT, marginBottom: 16, fontWeight: 500 },
  controls: { display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  primaryButton: { padding: '10px 24px', fontSize: 14, backgroundColor: COLORS.ACCENT, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT },
  actionButton: { padding: '10px 24px', fontSize: 14, backgroundColor: COLORS.GREEN, color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: UI_FONT },
  pathLine: { padding: 12, backgroundColor: '#f7fbff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, color: COLORS.TEXT, marginBottom: 12, wordBreak: 'break-all' },
  info: { display: 'flex', gap: 18, flexWrap: 'wrap', padding: 16, backgroundColor: COLORS.SELECT, borderRadius: 4, color: COLORS.TEXT },
  startHelp: { marginTop: 16, padding: 16, border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, background: '#f7fbff', color: COLORS.TEXT, lineHeight: 1.65 },
  recentBox: { marginTop: 14, border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, background: '#fff', overflow: 'hidden' },
  recentTitle: { margin: 0, padding: '10px 12px', background: '#e3eefb', color: COLORS.TEXT, fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  collapseButton: { width: 26, height: 24, border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 },
  recentList: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, maxHeight: 260, overflow: 'auto' },
  emptyRecent: { color: COLORS.TEXT_LIGHT, fontSize: 13, padding: 8 },
  recentRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px 62px 62px', gap: 8, alignItems: 'center' },
  recentMain: { display: 'grid', gridTemplateColumns: '155px minmax(0, 1fr)', gap: 8, padding: 8, border: 0, borderRadius: 4, background: COLORS.SELECT, color: COLORS.TEXT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT, minWidth: 0 },
  recentTime: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  recentPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  recentButton: { padding: '8px 9px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 12 },
  contextMenu: { position: 'fixed', zIndex: 3000, minWidth: 132, padding: 5, background: '#fff', border: `1px solid ${COLORS.BORDER}`, borderRadius: 5, boxShadow: '0 8px 24px rgba(0,0,0,.2)', display: 'flex', flexDirection: 'column' },
  contextMenuItem: { padding: '8px 10px', border: 0, background: '#fff', color: COLORS.TEXT, textAlign: 'left', cursor: 'pointer', fontFamily: UI_FONT },
  liveLogLauncher: { position: 'fixed', right: 8, bottom: 8, zIndex: 2550, width: 34, height: 34, borderRadius: 17, border: `1px solid ${COLORS.BORDER}`, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', boxShadow: '0 6px 18px rgba(31, 53, 78, .16)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 },
  liveLogLauncherActive: { background: COLORS.ACCENT, color: '#fff', borderColor: COLORS.ACCENT },
  statusBar: { position: 'fixed', left: 8, bottom: 8, zIndex: 2550, maxWidth: 'calc(100vw - 60px)', height: 28, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 14, background: '#fff', color: COLORS.TEXT, boxShadow: '0 4px 14px rgba(31,53,78,.14)', fontFamily: UI_FONT, fontSize: 12 },
  statusName: { fontWeight: 600, whiteSpace: 'nowrap', color: COLORS.ACCENT },
  statusPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: COLORS.TEXT_LIGHT },
};

const aboutStyles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 3200, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dialog: { width: 580, maxHeight: '84vh', background: '#fff', borderRadius: 8, boxShadow: '0 18px 54px rgba(20,36,60,.28)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '28px 32px 20px' },
  title: { margin: '0 0 14px', color: COLORS.TEXT, fontSize: 20, fontWeight: 700, fontFamily: UI_FONT },
  scroll: { flex: 1, minHeight: 0, overflow: 'auto', width: '100%', textAlign: 'center' as const, marginBottom: 20, paddingRight: 4 },
  subtitle: { margin: '6px 0 10px', color: COLORS.TEXT, fontSize: 15, fontWeight: 600, fontFamily: UI_FONT },
  line: { margin: '4px 0', color: COLORS.TEXT, fontSize: 14, fontFamily: UI_FONT, lineHeight: 1.8 },
  spacer: { height: 12 },
  table: { width: '100%', borderCollapse: 'collapse' as const, margin: '10px 0', fontSize: 13, fontFamily: UI_FONT },
  th: { padding: '7px 10px', background: '#f2f6fb', borderBottom: `2px solid ${COLORS.BORDER}`, color: COLORS.TEXT, fontWeight: 600, textAlign: 'left' as const, whiteSpace: 'nowrap' as const },
  td: { padding: '7px 10px', borderBottom: `1px solid #eef2f6`, color: COLORS.TEXT, textAlign: 'left' as const },
  note: { margin: '6px 0 0', color: COLORS.TEXT_LIGHT, fontSize: 12, fontFamily: UI_FONT, lineHeight: 1.6 },
  closeBtn: { padding: '8px 32px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT, fontSize: 14, flexShrink: 0 },
};

export default App;

// 常量定义

// 应用名称
export const APP_NAME = '逐浪羲之';
export const APP_NAME_EN = 'ZoomlaXizhi';
export const APP_VER = '1.0.0';

// UI 字体
export const UI_FONT = 'Microsoft YaHei';

// 配色方案
export const COLORS = {
  // 背景色
  BG: '#eef4fb',           // 页面底色
  CARD: '#ffffff',         // 卡片/面板
  BORDER: '#d4e2f4',       // 边框

  // 主题色
  ACCENT: '#2b87f0',       // 主按钮蓝
  ACCENT_D: '#1668c7',     // 主按钮悬停/选中

  // 动作色
  GREEN: '#21a366',        // 动作按钮绿
  GREEN_D: '#178a54',      // 动作按钮悬停

  // 文本色
  TEXT: '#1e3a5f',         // 正文深蓝灰
  TEXT_DARK: '#0a1a2a',    // 深色文本
  TEXT_LIGHT: '#7a8ba3',   // 浅色文本

  // 选择色
  SELECT: '#d9eaff',       // 选中底色
  SELECT_BORDER: '#2b87f0', // 选中边框

  // 网格色
  GRID_LIGHT: '#e8eef5',   // 浅灰网格
  GRID_DARK: '#d0dbe8',    // 深灰网格

  // 参考线色
  BASELINE: '#e34b4b',     // 基线
  ASCENT: '#9bbce0',       // 升部
  DESCENT: '#9bbce0',      // 降部
  EM_BOX: '#cdddef',       // EM 框

  // 锚点色
  ON_POINT: '#2b87f0',     // on-curve 点 (蓝色实心)
  OFF_POINT: '#21a366',    // off-curve 点 (绿色空心)

  // 轮廓色
  OUTLINE: '#1e3a5f',      // 轮廓线
  FILL: '#000000',         // 填充

  // 进度条
  PROGRESS: '#2b87f0',     // 进度条
  PROGRESS_BG: '#e3eefb',  // 进度条背景
};

// 导出尺寸
export const EXPORT_SIZES = [200, 400, 600, 800, 1000, 1200, 1800, 200, 400, 600, 800, 1000, 1200, 1800];

// 导出格式
export const EXPORT_FORMATS = ['PNG', 'JPG', 'SVG', 'EPS'];

// 默认预览尺寸
export const DEFAULT_THUMB_SIZE = 120;
export const DEFAULT_PAGE_SIZE = 200;

// 字体度量 (内部使用)
export const FONT_METRICS = {
  UPM: 1024,
  ASCENT: 880,
  DESCENT: -144,
};

// 快捷键配置
export const HOTKEY_ACTIONS = [
  { id: 'help', name: '帮助', default: 'F1' },
  { id: 'log', name: '日志', default: 'Ctrl+L' },
  { id: 'settings', name: '设置', default: 'Ctrl+,' },
  { id: 'start', name: '开始', default: 'Ctrl+N' },
  { id: 'jump', name: '跳转', default: 'Ctrl+F' },
];

// 数据库表名
export const DB_TABLES = {
  LOG: 'ZoomlaXizhi_Log',
  SETTING: 'ZoomlaXizhi_Setting',
  PROD_RECORD: 'ZoomlaXizhi_ProdRecord',
  EDITOR_STATE: 'ZoomlaXizhi_EditorState',
};

// 非法文件名字符
export const ILLEGAL_FN_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

// 最大生产记录数
export const MAX_PROD_RECORDS = 200;
export const MAX_UNDO_STEPS = 50;

// 画布边距
export const CANVAS_MARGIN = 50;

// 缩放范围
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 5.0;

// 工具类型
export const TOOLS = {
  SELECT: 'select',
  BRUSH: 'brush',
  ERASER: 'eraser',
};

// 字性处理扩展参数配置
export const FX_EXT_SCHEMA = [
  { id: 'vendor', name: '厂商代码 (Vendor ID)', type: 'single', default: 'Z01' },
  { id: 5, name: '5: 版本字符串 (Version)', type: 'dual', defEn: 'Version1.00 20260124@by v.ziti163.com', defZh: 'Version1.00 20260124@基于逐浪字库大师 v.ziti163.com' },
  { id: 0, name: '0: 版权声明 (Copyright)', type: 'dual', defEn: '2022-forever Zoomla!CMS Corporation. All rights reserved.', defZh: '版权所有：江西逐浪软件科技有限公司 [2021 至永久]' },
  { id: 7, name: '7: 商标信息 (Trademark)', type: 'dual', defEn: 'Zfont By Siisoft.com Team.', defZh: '逐浪 - 专注汉语基础数据元研究与文明基石拓荒者。' },
  { id: 8, name: '8: 厂商名称 (Manufacturer)', type: 'dual', defEn: 'Shanghai ZoomlaCMS co.,LTD Authorized to produce', defZh: '上海逐一软件科技有限公司 承制' },
  { id: 9, name: '9: 设计师 (Designer)', type: 'dual', defEn: 'Zoomla!CMS,☎86-0791-86161900', defZh: 'Zoomla!逐浪 CMS，授权订制☎0791-86161900' },
  { id: 10, name: '10: 描述 (Description)', type: 'dual', defEn: 'zfont:Focus on basic Chinese research and pioneering the foundation of civilization', defZh: '逐浪字库 - 高端出品，江西字研所智慧支持 z01.com' },
  { id: 11, name: '11: 厂商网址 (Vendor URL)', type: 'link', defEn: 'http://www.z01.com' },
  { id: 12, name: '12: 设计师网站 (Designer URL)', type: 'link', defEn: 'http://www.hx008.com' },
  { id: 13, name: '13: 许可协议 (License)', type: 'dual', defEn: 'http://f.ziti163.com down more fonts', defZh: 'http://f.ziti163.com 获取更多字体下载' },
  { id: 14, name: '14: 许可协议网站 (License URL)', type: 'link', defEn: 'http://www.z01.com/corp/about/95.shtml' },
  { id: 19, name: '19: 示例文本 (Sample Text)', type: 'dual', defEn: 'Zoomla CMS Fonts', defZh: '汉字之美逐浪而来' },
];

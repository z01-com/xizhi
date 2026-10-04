import React, { useMemo, useState } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';

const TIP_SETS: Record<string, string[]> = {
  glyphEditor: [
    '点击闭合元素显示变换框，框内拖动移动元素，8 个控制点缩放；Ctrl 为自由缩放，Shift 为同比例缩放。双击字形进入锚点编辑。',
    '支持Ctrl+Z、Ctrl+Shift+Z进行撤销与反撤销。',
    '快速找字Ctrl+F，同时支持字符与uni码检索。',
    '字者新生-逐浪字库专注中文字库表达研发。',
    'Ctrl + 键盘、Ctrl + 键盘支持前后切换字符。',
    'Ctrl+i、ctrl+E 支持导入与导出，也可以直接复制目标元素在编辑器中粘贴，支持PNG、JPG、EPS、SVG等格式',
    'Ctrl+鼠标滑轮可以控制窗口大小与缩放，Ctrl+0恢复百分百适应窗体。',
    '仓颉造字鬼神哭、人十己千，向尊敬的造字师致敬！',
  ],
};

interface WikiTipsProps {
  scope: keyof typeof TIP_SETS;
  style?: React.CSSProperties;
}

export const WikiTips: React.FC<WikiTipsProps> = ({ scope, style }) => {
  const tips = TIP_SETS[scope] || [];
  const initialIndex = useMemo(() => {
    if (!tips.length) return 0;
    return Math.floor(Math.random() * tips.length);
  }, [tips.length]);
  const [index, setIndex] = useState(initialIndex);
  if (!tips.length) return null;

  return (
    <button
      type="button"
      title="切换下一条指引"
      style={{ ...styles.tipButton, ...style }}
      onClick={() => setIndex(value => (value + 1) % tips.length)}
    >
      <strong style={styles.tipTitle}>授业指引➔</strong>{tips[index]}
    </button>
  );
};

const styles: Record<string, React.CSSProperties> = {
  tipButton: {
    border: 0,
    background: 'transparent',
    padding: 0,
    margin: 0,
    color: COLORS.TEXT_LIGHT,
    fontFamily: UI_FONT,
    fontSize: 12,
    lineHeight: 1.7,
    textAlign: 'left',
    cursor: 'pointer',
  },
  tipTitle: {
    color: COLORS.TEXT,
    fontSize: 12,
    fontWeight: 700,
    marginRight: 0,
  },
};

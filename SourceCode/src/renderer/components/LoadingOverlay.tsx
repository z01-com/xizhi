import React from 'react';
import { COLORS, UI_FONT } from '@shared/constants';

interface LoadingOverlayProps {
  visible: boolean;
  message?: string;
  inline?: boolean;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ visible, message = '系统数据加载中...', inline = false }) => {
  if (!visible) return null;
  return (
    <div style={inline ? styles.inline : styles.overlay}>
      <div style={styles.panel}>
        <i className="ri-hourglass-fill" style={styles.icon} />
        <span>{message}</span>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', inset: 0, zIndex: 2600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(248,251,255,.72)', backdropFilter: 'blur(1px)', pointerEvents: 'auto' },
  inline: { position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 46 },
  panel: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 6, background: '#fff', color: COLORS.TEXT, boxShadow: '0 10px 28px rgba(20,36,60,.16)', fontFamily: UI_FONT, fontSize: 14 },
  icon: { color: COLORS.ACCENT, fontSize: 18 },
};

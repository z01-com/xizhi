import React, { useEffect } from 'react';
import { COLORS, UI_FONT } from '@shared/constants';

interface ToastProps {
  message: string;
  type: 'info' | 'success' | 'error';
  onClose: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const bgColors: Record<string, string> = {
    info: COLORS.ACCENT,
    success: COLORS.GREEN,
    error: '#d32f2f',
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        backgroundColor: bgColors[type],
        color: '#fff',
        padding: '12px 24px',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        zIndex: 2000,
        fontFamily: UI_FONT,
        animation: 'slideIn 0.3s ease-out',
      }}
    >
      {message}
    </div>
  );
};

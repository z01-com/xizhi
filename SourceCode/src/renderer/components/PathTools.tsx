import React from 'react';
import { COLORS, UI_FONT } from '@shared/constants';

interface PathToolsProps {
  value: string;
  placeholder?: string;
  isDir?: boolean;
  onBrowse: () => void | Promise<void>;
  inputStyle?: React.CSSProperties;
}

export const PathTools: React.FC<PathToolsProps> = ({ value, placeholder, isDir = false, onBrowse, inputStyle }) => {
  const openFolder = async () => {
    if (!value) return;
    const target = isDir ? value : await window.electronAPI.pathDirname(value);
    await window.electronAPI.openPath(target);
  };

  const viewFile = async () => {
    if (!value || isDir) return;
    await window.electronAPI.openPath(value);
  };

  return (
    <div style={styles.row}>
      <input value={value} readOnly onClick={onBrowse} placeholder={placeholder} style={{ ...styles.input, ...inputStyle }} />
      <button style={styles.button} onClick={onBrowse}>浏览</button>
      {value && <button style={styles.button} onClick={openFolder}>open</button>}
      {!isDir && value && <button style={styles.button} onClick={viewFile}>view</button>}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0, flex: 1 },
  input: { flex: 1, minWidth: 180, padding: '8px 10px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, fontFamily: UI_FONT, cursor: 'pointer' },
  button: { padding: '8px 11px', border: `1px solid ${COLORS.BORDER}`, borderRadius: 4, background: '#fff', color: COLORS.TEXT, cursor: 'pointer', fontFamily: UI_FONT },
};

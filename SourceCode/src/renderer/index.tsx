import React from 'react';
import ReactDOM from 'react-dom/client';
import 'remixicon/fonts/remixicon.css';
import 'zico/css/zico.min.css';
import App from './App';
import './styles/index.css';

const reportRendererError = (source: string, error: unknown, extra = '') => {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = [
    `Renderer ${source}: ${err.name}: ${err.message}`,
    err.stack || '',
    extra,
    `location=${window.location.href}`,
  ].filter(Boolean).join('\n');
  window.electronAPI?.runtimeLog?.(message).catch(() => {});
};

window.addEventListener('error', event => {
  reportRendererError('window.error', event.error || event.message, `filename=${event.filename}:${event.lineno}:${event.colno}`);
});

window.addEventListener('unhandledrejection', event => {
  reportRendererError('unhandledrejection', event.reason);
});

window.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return;
  const selection = window.getSelection();
  const text = selection?.toString() || '';
  if (!text.trim()) return;
  const target = event.target as HTMLElement | null;
  const isEditable = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
  if (isEditable) return;
  event.preventDefault();
  event.stopPropagation();
  void window.electronAPI?.writeClipboardText?.(text);
}, true);

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportRendererError('react-boundary', error, info.componentStack || '');
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div style={{ padding: 32, fontFamily: 'Microsoft YaHei, Segoe UI, sans-serif', color: '#1f2937', background: '#eef4fb', minHeight: '100vh' }}>
        <h1 style={{ fontSize: 22, marginBottom: 12 }}>界面渲染异常</h1>
        <p>程序已记录错误日志，请查看 exe 同目录的 runtime.log。</p>
        <pre style={{ marginTop: 16, whiteSpace: 'pre-wrap', background: '#fff', border: '1px solid #d7e1ec', padding: 16, borderRadius: 6 }}>
          {this.state.error.name}: {this.state.error.message}
        </pre>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>
);

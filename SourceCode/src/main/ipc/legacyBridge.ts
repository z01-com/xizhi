import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function getScriptPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'src/main/legacy_font_bridge.py'),
    path.resolve(__dirname, '..', 'legacy_font_bridge.py'),
    path.resolve(process.resourcesPath ?? '', 'legacy_font_bridge.exe'),
    path.resolve(process.cwd(), 'dist/legacy_font_bridge.exe'),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error('legacy_font_bridge not found');
  }
  return found;
}

export function runLegacy<T>(args: string[]): T {
  const script = getScriptPath();
  const isExe = script.endsWith('.exe');
  // exe 直接执行，py 脚本需要 python 解释器
  const cmd = isExe ? script : 'python';
  const cmdArgs = isExe ? args : ['-X', 'utf8', script, ...args];
  const result = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32,
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  let payload: any = null;
  if (stdout) {
    const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop();
    if (lastLine) {
      payload = JSON.parse(lastLine);
    }
  }

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || !payload?.success) {
    throw new Error(payload?.error || stderr || 'Legacy font operation failed');
  }

  return payload as T;
}

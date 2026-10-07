// 将 EULA.txt 复制到打包输出目录的根层级
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'doc', 'EULA.txt');
if (!fs.existsSync(src)) {
  console.log('[copy-eula] 源文件不存在，跳过:', src);
  process.exit(0);
}

const distDir = path.join(__dirname, '..', 'dist-electron');
if (!fs.existsSync(distDir)) {
  console.log('[copy-eula] dist-electron 不存在，跳过');
  process.exit(0);
}

const entries = fs.readdirSync(distDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory() && entry.name.includes('unpacked')) {
    const dest = path.join(distDir, entry.name, 'EULA.txt');
    fs.copyFileSync(src, dest);
    console.log('[copy-eula] 已复制到', dest);
  }
  // NSIS 安装器输出目录
  if (entry.isDirectory() && entry.name.includes('nsis')) {
    const dest = path.join(distDir, entry.name, 'EULA.txt');
    fs.copyFileSync(src, dest);
    console.log('[copy-eula] 已复制到', dest);
  }
}

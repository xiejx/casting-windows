'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const unpacked = path.join(root, 'dist', 'win-unpacked');
const stagingRoot = path.join(root, 'dist', 'portable');
const staging = path.join(stagingRoot, 'CastReceiver');
const version = require(path.join(root, 'package.json')).version;
const zipFile = path.join(root, 'dist', `CastReceiver-${version}-portable.zip`);

// electron-builder 缓存的 7za 压缩率更好，找不到时退回系统 tar
function find7za() {
  const roots = [
    path.join(root, '.cache', 'eb'),
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache'),
  ];
  for (const rootDir of roots) {
    if (!rootDir || !fs.existsSync(rootDir)) continue;
    const stack = [rootDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === '7za.exe') return full;
      }
    }
  }
  return null;
}

if (!fs.existsSync(path.join(unpacked, 'CastReceiver.exe'))) {
  console.error('未找到 dist/win-unpacked，请先执行 electron-builder --win');
  process.exit(1);
}

console.log('复制程序文件…');
fs.rmSync(stagingRoot, { recursive: true, force: true });
fs.mkdirSync(stagingRoot, { recursive: true });
fs.cpSync(unpacked, staging, { recursive: true });

// 便携标记：程序据此把配置与缓存写入同目录的 CastReceiver-data
fs.writeFileSync(
  path.join(staging, 'portable.flag'),
  '便携模式标记：删除本文件后，配置与缓存将保存在 %APPDATA%\\casting-windows。\r\n',
  'utf8',
);
fs.rmSync(path.join(staging, 'CastReceiver-data'), { recursive: true, force: true });

console.log('压缩为 zip…');
fs.rmSync(zipFile, { force: true });
const sevenZip = find7za();
if (sevenZip) {
  execFileSync(sevenZip, ['a', '-tzip', '-mx=9', zipFile, 'CastReceiver'], {
    cwd: stagingRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} else {
  execFileSync('tar.exe', ['-a', '-c', '-f', zipFile, '-C', stagingRoot, 'CastReceiver'], {
    stdio: 'inherit',
  });
}

const zipMb = (fs.statSync(zipFile).size / 1024 / 1024).toFixed(1);
fs.rmSync(stagingRoot, { recursive: true, force: true });
console.log(`已生成 ${path.relative(root, zipFile)}（${zipMb} MB）`);
console.log('解压后运行 CastReceiver\\CastReceiver.exe，配置与缓存保存在 CastReceiver\\CastReceiver-data。');

'use strict';

const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  loadConfig,
  saveConfig,
  resolveIp,
  listInterfaces,
  defaultConfig,
} = require('../core/config');
const { DlnaReceiver } = require('../core/receiver');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.casting.dlna.windows');

// 便携模式：程序目录下存在 portable.flag 时，配置与缓存都写在程序目录内，整体拷贝即可迁移
const isPortable = setupPortableMode();

function setupPortableMode() {
  if (!app.isPackaged) return false;
  const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  if (!fs.existsSync(path.join(portableRoot, 'portable.flag'))) return false;
  const dataDir = path.join(portableRoot, 'CastReceiver-data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    return true;
  } catch (error) {
    console.error(`便携数据目录不可写，改用默认目录：${error.message}`);
    return false;
  }
}

let win = null;
let receiver = null;
let config = null;
let configFile = '';
const logs = [];
let serviceLock = Promise.resolve();

function pushLog(level, message) {
  const entry = { time: Date.now(), level, message: String(message) };
  logs.push(entry);
  if (logs.length > 400) logs.shift();
  if (level === 'error') console.error(message);
  else console.log(message);
  if (win && !win.isDestroyed()) {
    win.webContents.send('device:log', entry);
  }
}

const logger = {
  info: (message) => pushLog('info', message),
  warn: (message) => pushLog('warn', message),
  error: (message) => pushLog('error', message),
};

function statusPayload() {
  const snapshot = receiver ? receiver.device.getSnapshot() : null;
  const ip = receiver ? receiver.ip : resolveIp(config);
  const port = receiver ? receiver.port : config.port;
  return {
    config: {
      deviceName: config.deviceName,
      port: config.port,
      interfaceIp: config.interfaceIp,
      udn: config.udn,
    },
    ip,
    port,
    portable: isPortable,
    descriptionUrl: `http://${ip}:${port}/description.xml`,
    interfaces: listInterfaces(),
    snapshot,
    logs: logs.slice(),
    version: app.getVersion(),
    ready: Boolean(receiver && receiver.http),
  };
}

function broadcastStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('device:status', statusPayload());
  }
}

function proxyUrl(url, hls) {
  const port = receiver ? receiver.port : config.port;
  const base = `http://127.0.0.1:${port}/proxy?url=${encodeURIComponent(url)}`;
  return hls ? `${base}&hls=1` : base;
}

function sendCommand(command) {
  if (!win || win.isDestroyed()) return;
  const payload = { ...command };
  if (command.type === 'load') {
    payload.url = proxyUrl(command.url, command.isHls && !command.isImage);
    payload.sources = Array.isArray(command.sources)
      ? command.sources.map((source) => ({
          ...source,
          url: proxyUrl(source.url, Boolean(source.isHls)),
        }))
      : [];
    if (command.artwork) {
      payload.artwork = proxyUrl(command.artwork, false);
    }
  }
  win.webContents.send('player:command', payload);
}

async function stopServices() {
  const current = receiver;
  receiver = null;
  if (!current) return;
  try {
    await current.stop();
  } catch (error) {
    logger.warn(`停止服务时出错：${error.message}`);
  }
}

async function startServices() {
  await stopServices();
  const ip = resolveIp(config);
  const next = new DlnaReceiver({ config, ip, logger });
  next.onCommand(sendCommand);
  next.device.on('state', () => broadcastStatus());
  try {
    await next.start();
  } catch (error) {
    await next.stop().catch(() => {});
    throw error;
  }
  receiver = next;
  logger.info(`手机与电脑需连接同一 Wi-Fi；设备名：${config.deviceName}`);
  broadcastStatus();
  return next;
}

function withServiceLock(task) {
  const result = serviceLock.then(task, task);
  serviceLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function sanitizeConfig(input) {
  const source = input || {};
  const name = String(source.deviceName != null ? source.deviceName : config.deviceName)
    .trim()
    .slice(0, 60);
  const portNumber = Number(source.port != null ? source.port : config.port);
  const interfaceIp = String(
    source.interfaceIp != null ? source.interfaceIp : config.interfaceIp || ''
  );
  return {
    ...config,
    deviceName: name || defaultConfig().deviceName,
    port:
      Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535
        ? portNumber
        : config.port,
    interfaceIp: listInterfaces().some((item) => item.address === interfaceIp)
      ? interfaceIp
      : '',
  };
}

function openFirewall() {
  return new Promise((resolve) => {
    const port = receiver ? receiver.port : config.port;
    const inner = [
      `netsh advfirewall firewall delete rule name="CastReceiver TCP ${port}" | Out-Null`,
      `netsh advfirewall firewall add rule name="CastReceiver TCP ${port}" dir=in action=allow protocol=TCP localport=${port} | Out-Null`,
      'netsh advfirewall firewall delete rule name="CastReceiver SSDP" | Out-Null',
      'netsh advfirewall firewall add rule name="CastReceiver SSDP" dir=in action=allow protocol=UDP localport=1900 | Out-Null',
      'Write-Output DONE',
    ].join('; ');
    const innerEncoded = Buffer.from(inner, 'utf16le').toString('base64');
    const outer = `Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-EncodedCommand','${innerEncoded}') -Wait`;
    const outerEncoded = Buffer.from(outer, 'utf16le').toString('base64');

    const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', outerEncoded], {
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      logger.error(`防火墙规则添加失败：${error.message}`);
      resolve({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      if (code === 0) {
        logger.info(`已放行防火墙端口 TCP ${port} / UDP 1900`);
        resolve({ ok: true, message: '防火墙规则已添加' });
      } else {
        logger.warn('未能添加防火墙规则，可能取消了管理员授权');
        resolve({ ok: false, error: '未能添加规则，可能取消了管理员授权' });
      }
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: '投屏接收器',
    backgroundColor: '#070b17',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('console-message', (details) => {
    // Electron 45 起改为事件对象参数，level 为 info / warning / error / debug
    if (!details) return;
    const level = details.level;
    if (level !== 'warning' && level !== 'error') return;
    const location = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : '';
    const text = `界面异常：${details.message}${location}`;
    if (level === 'error') logger.error(text);
    else logger.warn(text);
  });

  win.webContents.on('did-fail-load', (event, code, description) => {
    logger.error(`界面加载失败：${description} (${code})`);
  });

  if (process.env.CAST_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

ipcMain.handle('app:status', async () => statusPayload());
ipcMain.handle('app:save-config', async (event, input) => {
  try {
    const nextConfig = sanitizeConfig(input);
    saveConfig(configFile, nextConfig);
    config = nextConfig;
    logger.info('配置已保存，正在重启投屏服务…');
    await withServiceLock(startServices);
    return { ok: true, status: statusPayload() };
  } catch (error) {
    logger.error(`重启投屏服务失败：${error.message}`);
    return { ok: false, error: error.message, status: statusPayload() };
  }
});

ipcMain.handle('app:open-firewall', async () => openFirewall());

const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
  'VideoDecodeStats',
];

async function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += (await fs.promises.stat(full)).size;
      } catch {
        // 文件可能在统计过程中被删除，忽略
      }
    }
  }
  return total;
}

async function cacheInfo() {
  const dir = app.getPath('userData');
  const bytes = await directorySize(dir);
  return { dir, bytes };
}

async function clearCache() {
  const before = await cacheInfo();
  try {
    await session.defaultSession.clearCache();
  } catch (error) {
    logger.warn(`清理网络缓存失败：${error.message}`);
  }
  const dir = app.getPath('userData');
  for (const name of CACHE_DIRS) {
    try {
      await fs.promises.rm(path.join(dir, name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    } catch {
      // 正在被 Chromium 占用的文件会在下次启动时被覆盖，忽略即可
    }
  }
  const after = await cacheInfo();
  const freed = Math.max(0, before.bytes - after.bytes);
  logger.info(`已清理缓存，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`);
  return { dir: after.dir, bytes: after.bytes, freed };
}

ipcMain.handle('app:cache-info', async () => cacheInfo());

ipcMain.handle('app:clear-cache', async () => {
  try {
    return { ok: true, ...(await clearCache()) };
  } catch (error) {
    logger.error(`清理缓存失败：${error.message}`);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('app:open-cache-dir', async () => {
  const error = await shell.openPath(app.getPath('userData'));
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.on('app:quit', () => app.quit());

ipcMain.on('player:event', (event, payload) => {
  if (!receiver || !payload || !payload.name) return;
  const device = receiver.device;
  const data = payload.data || {};
  switch (payload.name) {
    case 'state':
      device.updateFromPlayer({ state: data.state, position: data.position, duration: data.duration });
      break;
    case 'time':
      device.updatePosition(data.position, data.duration);
      break;
    case 'volume':
      device.updateVolumeFromPlayer(data.volume, data.muted);
      break;
    case 'ended':
      device.updateFromPlayer({ state: 'ENDED' });
      break;
    case 'error':
      device.reportError(data.message);
      break;
    case 'log':
      logger.info(data.message || '');
      break;
    default:
      break;
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    configFile = path.join(app.getPath('userData'), 'config.json');
    config = loadConfig(configFile);
    saveConfig(configFile, config);
    createWindow();
    withServiceLock(startServices).catch((error) => {
      logger.error(`启动失败：${error.message}`);
      broadcastStatus();
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    if (receiver) {
      const current = receiver;
      receiver = null;
      current.stop().catch(() => {});
    }
  });
}

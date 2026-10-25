'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function listInterfaces() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(nets)) {
    for (const item of addresses || []) {
      if (item.family === 'IPv4' && !item.internal) {
        result.push({ name, address: item.address, netmask: item.netmask, mac: item.mac });
      }
    }
  }
  return result;
}

function defaultDeviceName() {
  return `Windows 投屏 (${os.hostname()})`;
}

function defaultConfig() {
  return {
    deviceName: defaultDeviceName(),
    port: 8811,
    udn: `uuid:${crypto.randomUUID()}`,
    interfaceIp: '',
  };
}

function loadConfig(file) {
  const config = defaultConfig();
  try {
    if (file && fs.existsSync(file)) {
      Object.assign(config, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  } catch {
    // 配置损坏时回退到默认值
  }

  if (!/^uuid:[0-9a-f-]{8,}$/i.test(String(config.udn || ''))) {
    config.udn = `uuid:${crypto.randomUUID()}`;
  }
  const port = Number(config.port);
  config.port = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8811;
  if (!config.deviceName || typeof config.deviceName !== 'string') {
    config.deviceName = defaultDeviceName();
  }
  config.deviceName = config.deviceName.trim().slice(0, 60) || defaultDeviceName();
  config.interfaceIp = typeof config.interfaceIp === 'string' ? config.interfaceIp : '';
  if (config.interfaceIp && !listInterfaces().some((item) => item.address === config.interfaceIp)) {
    config.interfaceIp = '';
  }
  return config;
}

function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
}

function resolveIp(config) {
  if (config && config.interfaceIp) return config.interfaceIp;
  const interfaces = listInterfaces();
  const preferred = interfaces.find((item) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)
  );
  return (preferred || interfaces[0] || { address: '127.0.0.1' }).address;
}

module.exports = {
  listInterfaces,
  defaultConfig,
  loadConfig,
  saveConfig,
  resolveIp,
};

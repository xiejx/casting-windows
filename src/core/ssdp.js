'use strict';

const dgram = require('dgram');

const MULTICAST_ADDRESS = '239.255.255.250';
const MULTICAST_PORT = 1900;
const SERVER = 'Windows/10.0 UPnP/1.1 CastReceiver/1.0';
const MAX_AGE = 1800;

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

class SsdpServer {
  constructor({ udn, ip, location, deviceType, services, logger }) {
    this.udn = udn;
    this.ip = ip;
    this.location = location;
    this.deviceType = deviceType;
    this.services = services || [];
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.socket = null;
    this.timer = null;
    this.bootId = Math.floor(Date.now() / 1000) % 2147483647;

    this.types = ['upnp:rootdevice', udn, deviceType, ...this.services];
  }

  start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (error) => {
      this.logger.error(`SSDP 服务异常：${error.message}`);
    });

    socket.on('message', (message, rinfo) => {
      this._onMessage(message, rinfo);
    });

    socket.bind({ port: MULTICAST_PORT, address: '0.0.0.0', exclusive: false }, () => {
      try {
        socket.setMulticastTTL(2);
        socket.setMulticastLoopback(true);
      } catch {
        // 某些网卡不支持组播参数
      }
      try {
        socket.addMembership(MULTICAST_ADDRESS, this.ip);
      } catch (error) {
        this.logger.warn(`加入 SSDP 组播失败：${error.message}`);
      }
      try {
        socket.setMulticastInterface(this.ip);
      } catch {
        // 忽略
      }

      this.logger.info(`SSDP 发现服务已启动（${this.ip}:${MULTICAST_PORT}）`);
      this._alive();
      this.timer = setInterval(() => this._alive(), 180000);
      this.timer.unref?.();
    });
  }

  stop() {
    if (!this.socket) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._byebye();
    const socket = this.socket;
    this.socket = null;
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // 已关闭
      }
    }, 120);
    timer.unref?.();
  }

  _alive() {
    for (const type of this.types) {
      this._sendNotify('ssdp:alive', type);
    }
  }

  _byebye() {
    for (const type of this.types) {
      this._sendNotify('ssdp:byebye', type);
    }
  }

  _sendNotify(nts, nt) {
    const usn = nt === this.udn ? this.udn : `${this.udn}::${nt}`;
    const lines = [
      'NOTIFY * HTTP/1.1',
      `HOST: ${MULTICAST_ADDRESS}:${MULTICAST_PORT}`,
      `NT: ${nt}`,
      `NTS: ${nts}`,
      `USN: ${usn}`,
      `BOOTID.UPNP.ORG: ${this.bootId}`,
      'CONFIGID.UPNP.ORG: 1',
    ];
    if (nts === 'ssdp:alive') {
      lines.splice(2, 0, `CACHE-CONTROL: max-age=${MAX_AGE}`, `LOCATION: ${this.location}`, `SERVER: ${SERVER}`);
    }
    lines.push('', '');
    this._send(lines.join('\r\n'));
  }

  _send(text) {
    const socket = this.socket;
    if (!socket) return;
    const payload = Buffer.from(text, 'utf8');
    try {
      socket.send(payload, 0, payload.length, MULTICAST_PORT, MULTICAST_ADDRESS, (error) => {
        if (error) this.logger.warn(`SSDP 通知发送失败：${error.message}`);
      });
    } catch (error) {
      this.logger.warn(`SSDP 通知发送失败：${error.message}`);
    }
  }

  _onMessage(message, rinfo) {
    const text = message.toString('utf8');
    if (!/^M-SEARCH\b/i.test(text)) return;
    const headers = parseHeaders(text);
    if (headers.man && !String(headers.man).toLowerCase().includes('ssdp:discover')) {
      return;
    }
    const searchTarget = String(headers.st || 'ssdp:all').trim();
    const lower = searchTarget.toLowerCase();

    let targets;
    if (lower === 'ssdp:all') {
      targets = this.types.slice();
    } else {
      targets = this.types.filter((type) => type.toLowerCase() === lower);
    }
    if (!targets.length) return;

    targets.forEach((type, index) => {
      const delay = 20 + Math.floor(Math.random() * 80) + index * 10;
      const timer = setTimeout(() => this._respond(type, rinfo), delay);
      timer.unref?.();
    });
  }

  _respond(st, rinfo) {
    const usn = st === this.udn ? this.udn : `${this.udn}::${st}`;
    const lines = [
      'HTTP/1.1 200 OK',
      `CACHE-CONTROL: max-age=${MAX_AGE}`,
      'DATE: ' + new Date().toUTCString(),
      'EXT:',
      `LOCATION: ${this.location}`,
      `SERVER: ${SERVER}`,
      `ST: ${st}`,
      `USN: ${usn}`,
      `BOOTID.UPNP.ORG: ${this.bootId}`,
      'CONFIGID.UPNP.ORG: 1',
      '',
    ];
    this._sendTo(lines.join('\r\n'), rinfo.address, rinfo.port);
  }

  _sendTo(text, address, port) {
    const socket = this.socket;
    if (!socket) return;
    const payload = Buffer.from(text, 'utf8');
    try {
      socket.send(payload, 0, payload.length, port, address, (error) => {
        if (error) this.logger.warn(`SSDP 响应发送失败：${error.message}`);
      });
    } catch (error) {
      this.logger.warn(`SSDP 响应发送失败：${error.message}`);
    }
  }
}

module.exports = {
  SsdpServer,
  MULTICAST_ADDRESS,
  MULTICAST_PORT,
};

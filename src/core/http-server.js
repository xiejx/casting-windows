'use strict';

const http = require('http');
const { URL } = require('url');
const { SubscriptionManager } = require('./gena');
const {
  buildDescriptionXml,
  SCPD,
  SINK_PROTOCOL_INFO,
} = require('./descriptions');
const {
  SoapError,
  parseSoapActionHeader,
  parseSoapBody,
  dispatch,
  buildResponse,
  buildFault,
} = require('./soap');
const { handleProxy } = require('./proxy');
const { escapeXml, formatTime } = require('./util');

const UPnP_SERVER = 'Windows/10.0 UPnP/1.1 CastReceiver/1.0';

function readRequestBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseTimeout(value) {
  const text = String(value || '');
  if (/infinite/i.test(text)) return 86400;
  const match = /Second-(\d+)/i.exec(text);
  if (match) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 86400);
  }
  return 1800;
}

class DlnaHttpServer {
  constructor({ device, ip, port, friendlyName, logger }) {
    this.device = device;
    this.ip = ip;
    this.port = port;
    this.friendlyName = friendlyName;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.server = null;
    this.subscriptions = new SubscriptionManager({ logger: this.logger });
    this._onDeviceState = ({ service }) => {
      if (service === 'AVTransport') {
        this.subscriptions.notify('AVTransport', { LastChange: this._buildAvtLastChange() });
      } else if (service === 'RenderingControl') {
        this.subscriptions.notify('RenderingControl', { LastChange: this._buildRcsLastChange() });
      }
    };
  }

  get baseUrl() {
    return `http://${this.ip}:${this.port}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handle(req, res).catch((error) => {
          this.logger.error(`请求处理失败：${error.message}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Internal Server Error');
          } else {
            res.destroy();
          }
        });
      });
      this.server = server;
      server.on('clientError', (error, socket) => {
        try {
          socket.destroy();
        } catch {
          // 忽略
        }
      });
      server.once('error', (error) => {
        try {
          server.close();
        } catch {
          // 忽略
        }
        reject(error);
      });
      server.listen(this.port, '0.0.0.0', () => {
        server.removeAllListeners('error');
        server.on('error', (error) => this.logger.error(`HTTP 服务异常：${error.message}`));
        this.port = server.address().port;
        this.device.on('state', this._onDeviceState);
        this.logger.info(`DLNA HTTP 服务已监听 0.0.0.0:${this.port}`);
        resolve(this.port);
      });
    });
  }

  stop() {
    this.device.removeListener('state', this._onDeviceState);
    this.subscriptions.close();
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      try {
        server.closeAllConnections?.();
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async _handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `${this.ip}:${this.port}`}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      this._setCors(res);
      res.writeHead(200);
      res.end();
      return;
    }

    if (pathname === '/description.xml' || pathname === '/') {
      if (pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this._statusPage());
        return;
      }
      const xml = buildDescriptionXml({
        friendlyName: this.friendlyName,
        udn: this.device.config.udn || 'uuid:00000000-0000-0000-0000-000000000000',
        port: this.port,
      });
      this._sendXml(res, xml);
      return;
    }

    if (pathname.startsWith('/scpd/')) {
      const name = pathname.slice('/scpd/'.length).replace(/\.xml$/i, '');
      const xml = SCPD[name];
      if (!xml) {
        this._text(res, 404, 'Not Found');
        return;
      }
      this._sendXml(res, xml);
      return;
    }

    if (pathname.startsWith('/control/')) {
      const service = pathname.slice('/control/'.length);
      if (req.method !== 'POST') {
        this._text(res, 405, 'Method Not Allowed');
        return;
      }
      await this._handleControl(req, res, service);
      return;
    }

    if (pathname.startsWith('/event/')) {
      const service = pathname.slice('/event/'.length);
      this._handleEvent(req, res, service);
      return;
    }

    if (pathname === '/proxy') {
      await handleProxy(req, res, url, { port: this.port, logger: this.logger });
      return;
    }

    if (pathname === '/status') {
      this._setCors(res);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          {
            name: this.friendlyName,
            ip: this.ip,
            port: this.port,
            description: `${this.baseUrl}/description.xml`,
            device: this.device.getSnapshot(),
          },
          null,
          2
        )
      );
      return;
    }

    this._text(res, 404, 'Not Found');
  }

  async _handleControl(req, res, service) {
    let xml;
    let status = 200;
    try {
      const body = await readRequestBody(req);
      const header = parseSoapActionHeader(req.headers.soapaction);
      const parsed = parseSoapBody(body, header ? header.action : '');
      const action = (header && header.action) || parsed.action;
      if (!action) throw new SoapError(401, 'Invalid Action');

      const result = dispatch(this.device, service, action, parsed.args);
      xml = buildResponse(service, action, result);
      this.logger.info(`控制指令：${service}.${action}`);
    } catch (error) {
      status = 500;
      if (error instanceof SoapError) {
        xml = buildFault(error.code, error.description);
        this.logger.warn(`控制指令失败：${service} (${error.code})`);
      } else {
        xml = buildFault(501, 'Action Failed');
        this.logger.error(`控制指令异常：${error.message}`);
      }
    }
    this._sendXml(res, xml, status);
  }

  _handleEvent(req, res, service) {
    this._setCors(res);
    if (req.method === 'SUBSCRIBE') {
      const sid = req.headers.sid;
      if (sid) {
        const subscription = this.subscriptions.renew(sid, parseTimeout(req.headers.timeout));
        if (!subscription) {
          this._text(res, 412, 'Precondition Failed');
          return;
        }
        res.writeHead(200, {
          SID: subscription.sid,
          TIMEOUT: `Second-${subscription.timeout}`,
          SERVER: UPnP_SERVER,
        });
        res.end();
        return;
      }

      const nt = String(req.headers.nt || '').toLowerCase();
      if (nt && nt !== 'upnp:event') {
        this._text(res, 412, 'Precondition Failed');
        return;
      }
      const callbackMatch = /<([^>]+)>/.exec(String(req.headers.callback || ''));
      if (!callbackMatch) {
        this._text(res, 412, 'Precondition Failed');
        return;
      }

      const subscription = this.subscriptions.subscribe({
        service,
        callback: callbackMatch[1],
        timeoutSeconds: parseTimeout(req.headers.timeout),
      });
      res.writeHead(200, {
        SID: subscription.sid,
        TIMEOUT: `Second-${subscription.timeout}`,
        SERVER: UPnP_SERVER,
      });
      res.end();
      const timer = setTimeout(() => this._sendInitialEvent(service), 60);
      timer.unref?.();
      return;
    }

    if (req.method === 'UNSUBSCRIBE') {
      const sid = req.headers.sid;
      if (!sid || !this.subscriptions.unsubscribe(sid)) {
        this._text(res, 412, 'Precondition Failed');
        return;
      }
      res.writeHead(200, { SERVER: UPnP_SERVER });
      res.end();
      return;
    }

    this._text(res, 405, 'Method Not Allowed');
  }

  _sendInitialEvent(service) {
    if (service === 'AVTransport') {
      this.subscriptions.notify('AVTransport', { LastChange: this._buildAvtLastChange() });
    } else if (service === 'RenderingControl') {
      this.subscriptions.notify('RenderingControl', { LastChange: this._buildRcsLastChange() });
    } else if (service === 'ConnectionManager') {
      this.subscriptions.notify('ConnectionManager', {
        SourceProtocolInfo: '',
        SinkProtocolInfo: SINK_PROTOCOL_INFO,
        CurrentConnectionIDs: '0',
      });
    }
  }

  _buildAvtLastChange() {
    const device = this.device;
    const fields = {
      TransportState: device.transportState,
      TransportStatus: 'OK',
      CurrentTransportActions: device.getCurrentTransportActions(),
      AVTransportURI: device.uri,
      CurrentTrackURI: device.uri,
      CurrentTrackDuration: formatTime(device.duration),
      CurrentMediaDuration: formatTime(device.duration),
      CurrentTrackMetaData: device.metadata,
    };
    const inner = Object.entries(fields)
      .map(([name, value]) => `<${name} val="${escapeXml(value)}"/>`)
      .join('');
    return `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0">${inner}</InstanceID></Event>`;
  }

  _buildRcsLastChange() {
    const device = this.device;
    return `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0"><Volume channel="Master" val="${device.volume}"/><Mute channel="Master" val="${
      device.mute ? '1' : '0'
    }"/></InstanceID></Event>`;
  }

  _setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, SUBSCRIBE, UNSUBSCRIBE, OPTIONS');
  }

  _sendXml(res, xml, status = 200) {
    this._setCors(res);
    res.setHeader('Content-Type', 'text/xml; charset="utf-8"');
    res.setHeader('Server', UPnP_SERVER);
    res.writeHead(status);
    res.end(xml);
  }

  _text(res, status, text) {
    this._setCors(res);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  _statusPage() {
    const snapshot = this.device.getSnapshot();
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>投屏接收器</title>
<style>body{background:#0b1020;color:#e8eefc;font-family:system-ui,"Microsoft YaHei";display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{text-align:center}h1{font-size:20px}code{color:#8ab4ff}p{color:#8b97b5}</style></head>
<body><main><h1>${escapeXml(this.friendlyName)}</h1>
<p>状态：${escapeXml(snapshot.transportState)}　媒体：${escapeXml(snapshot.title || '无')}</p>
<p>请使用手机 App 内的「投屏」按钮选择该设备。</p>
<p><code>${escapeXml(this.baseUrl)}/description.xml</code></p></main></body></html>`;
  }
}

module.exports = { DlnaHttpServer };

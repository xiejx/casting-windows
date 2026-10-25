'use strict';

const { DlnaDevice } = require('./device');
const { DlnaHttpServer } = require('./http-server');
const { SsdpServer } = require('./ssdp');
const { SERVICE_TYPES } = require('./descriptions');

class DlnaReceiver {
  constructor({ config, ip, logger, enableSsdp = true }) {
    this.config = { ...config };
    this.ip = ip;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.enableSsdp = enableSsdp;
    this.device = new DlnaDevice({ logger: this.logger, config: this.config });
    this.http = null;
    this.ssdp = null;
  }

  async start() {
    let lastError = null;
    for (let offset = 0; offset < 10; offset += 1) {
      const port = this.config.port + offset;
      if (port > 65535) break;
      const server = new DlnaHttpServer({
        device: this.device,
        ip: this.ip,
        port,
        friendlyName: this.config.deviceName,
        logger: this.logger,
      });
      try {
        await server.start();
        this.http = server;
        break;
      } catch (error) {
        if (error.code === 'EADDRINUSE') {
          lastError = error;
          this.logger.warn(`端口 ${port} 被占用，尝试下一个端口`);
          continue;
        }
        throw error;
      }
    }

    if (!this.http) {
      throw new Error(
        `无法监听端口（${this.config.port} 起连续 10 个端口均被占用）：${lastError ? lastError.message : ''}`
      );
    }

    if (this.enableSsdp) {
      this.ssdp = new SsdpServer({
        udn: this.config.udn,
        ip: this.ip,
        location: `${this.http.baseUrl}/description.xml`,
        deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
        services: Object.values(SERVICE_TYPES),
        logger: this.logger,
      });
      this.ssdp.start();
    }

    this.logger.info(`设备「${this.config.deviceName}」已就绪：${this.http.baseUrl}`);
    return this;
  }

  get port() {
    return this.http ? this.http.port : this.config.port;
  }

  onCommand(handler) {
    this.device.on('command', handler);
  }

  async stop() {
    if (this.ssdp) {
      this.ssdp.stop();
      this.ssdp = null;
    }
    if (this.http) {
      await this.http.stop();
      this.http = null;
    }
  }
}

module.exports = { DlnaReceiver };

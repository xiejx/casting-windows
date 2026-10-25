'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { escapeXml } = require('./util');

class SubscriptionManager {
  constructor({ logger, defaultTimeout = 1800 } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.defaultTimeout = defaultTimeout;
    this.subscriptions = new Map();
    this.cleanupTimer = setInterval(() => this._cleanup(), 60000);
    this.cleanupTimer.unref?.();
  }

  subscribe({ service, callback, timeoutSeconds }) {
    const sid = `uuid:${crypto.randomUUID()}`;
    const timeout = Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
      ? Math.min(Number(timeoutSeconds), 86400)
      : this.defaultTimeout;
    const subscription = {
      sid,
      service,
      callback,
      timeout,
      seq: 0,
      expiry: Date.now() + timeout * 1000,
    };
    this.subscriptions.set(sid, subscription);
    return subscription;
  }

  renew(sid, timeoutSeconds) {
    const subscription = this.subscriptions.get(sid);
    if (!subscription) return null;
    const timeout = Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
      ? Math.min(Number(timeoutSeconds), 86400)
      : subscription.timeout;
    subscription.timeout = timeout;
    subscription.expiry = Date.now() + timeout * 1000;
    return subscription;
  }

  unsubscribe(sid) {
    return this.subscriptions.delete(sid);
  }

  notify(service, variables) {
    const entries = Object.entries(variables || {});
    if (!entries.length) return;
    const body = `<?xml version="1.0" encoding="utf-8"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">${entries
      .map(([name, value]) => `<e:property><${name}>${escapeXml(value)}</${name}></e:property>`)
      .join('')}</e:propertyset>`;

    for (const subscription of this.subscriptions.values()) {
      if (subscription.service === service) {
        this._send(subscription, body);
      }
    }
  }

  _send(subscription, body) {
    let target;
    try {
      target = new URL(subscription.callback);
    } catch {
      return;
    }
    if (!/^https?:$/.test(target.protocol)) return;

    const seq = subscription.seq++;
    const lib = target.protocol === 'https:' ? https : http;
    let request;
    try {
      request = lib.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'NOTIFY',
          timeout: 5000,
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            'Content-Length': Buffer.byteLength(body),
            NT: 'upnp:event',
            NTS: 'upnp:propchange',
            SID: subscription.sid,
            SEQ: String(seq),
            Connection: 'close',
          },
        },
        (response) => {
          response.resume();
          if (response.statusCode >= 400) {
            this.logger.warn(`事件通知被拒绝：${response.statusCode}`);
          }
        }
      );
    } catch (error) {
      this.logger.warn(`事件通知失败：${error.message}`);
      return;
    }

    request.on('timeout', () => request.destroy());
    request.on('error', (error) => {
      this.logger.warn(`事件通知失败：${error.message}`);
    });
    request.end(body);
  }

  _cleanup() {
    const now = Date.now();
    for (const [sid, subscription] of this.subscriptions) {
      if (subscription.expiry < now) {
        this.subscriptions.delete(sid);
      }
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.subscriptions.clear();
  }
}

module.exports = { SubscriptionManager };

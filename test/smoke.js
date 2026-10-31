'use strict';

const assert = require('assert');
const http = require('http');
const { DlnaDevice } = require('../src/core/device');
const { DlnaHttpServer } = require('../src/core/http-server');
const { escapeXml } = require('../src/core/util');
const { siteHeaders } = require('../src/core/proxy');

const logger = { info() {}, warn() {}, error: (m) => console.error(m) };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function postSoap(port, service, action, args) {
  const urn = `urn:schemas-upnp-org:service:${service}:1`;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${urn}">${Object.entries(args)
      .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
      .join('')}</u:${action}>
  </s:Body>
</s:Envelope>`;
  return fetch(`http://127.0.0.1:${port}/control/${service}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${urn}#${action}"`,
    },
    body,
  });
}

function tag(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? match[1] : '';
}

async function main() {
  const device = new DlnaDevice({
    logger,
    config: { udn: 'uuid:11111111-2222-3333-4444-555555555555', deviceName: '测试接收器' },
  });
  const commands = [];
  device.on('command', (command) => commands.push(command));

  const server = new DlnaHttpServer({
    device,
    ip: '127.0.0.1',
    port: 0,
    friendlyName: '测试接收器',
    logger,
  });
  await server.start();
  const port = server.port;

  let callbackServer = null;
  let upstreamServer = null;

  try {
    // 1. 设备描述
    const description = await (await fetch(`http://127.0.0.1:${port}/description.xml`)).text();
    assert(description.includes('urn:schemas-upnp-org:device:MediaRenderer:1'), '缺少设备类型');
    assert(description.includes('测试接收器'), '缺少设备名');
    assert(description.includes('/control/AVTransport'), '缺少控制地址');
    assert(description.includes('DMR-1.50'), '缺少 DLNA 文档标识');

    // 2. SCPD
    const scpd = await (await fetch(`http://127.0.0.1:${port}/scpd/AVTransport.xml`)).text();
    assert(scpd.includes('<name>SetAVTransportURI</name>'), 'SCPD 缺少动作');
    assert(scpd.includes('<name>Seek</name>'), 'SCPD 缺少 Seek');

    // 3. 设置投屏地址 + 元数据
    const metadata = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>测试视频</dc:title><upnp:albumArtURI>http://127.0.0.1:9/cover.jpg</upnp:albumArtURI><res protocolInfo="http-get:*:video/mp4:*" duration="0:01:30">http://127.0.0.1:9/media.mp4</res></item></DIDL-Lite>`;
    const setUri = await postSoap(port, 'AVTransport', 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: 'http://127.0.0.1:9/media.mp4',
      CurrentURIMetaData: metadata,
    });
    assert.strictEqual(setUri.status, 200, 'SetAVTransportURI 应成功');

    const load = commands.find((command) => command.type === 'load');
    assert(load, '应产生 load 指令');
    assert.strictEqual(load.title, '测试视频');
    assert.strictEqual(load.url, 'http://127.0.0.1:9/media.mp4');
    assert.strictEqual(load.mime, 'video/mp4');
    assert.strictEqual(load.duration, 90);
    assert.strictEqual(load.isHls, false);

    // 4. 播放 + 状态
    await postSoap(port, 'AVTransport', 'Play', { InstanceID: '0', Speed: '1' });
    assert(commands.some((command) => command.type === 'play'), '应产生 play 指令');

    device.updateFromPlayer({ state: 'PLAYING', position: 12.5, duration: 90 });
    const info = await (await postSoap(port, 'AVTransport', 'GetTransportInfo', { InstanceID: '0' })).text();
    assert.strictEqual(tag(info, 'CurrentTransportState'), 'PLAYING');
    assert.strictEqual(tag(info, 'CurrentSpeed'), '1');

    const position = await (
      await postSoap(port, 'AVTransport', 'GetPositionInfo', { InstanceID: '0' })
    ).text();
    assert.strictEqual(tag(position, 'RelTime'), '0:00:12');
    assert.strictEqual(tag(position, 'TrackDuration'), '0:01:30');

    // 5. 跳转
    await postSoap(port, 'AVTransport', 'Seek', {
      InstanceID: '0',
      Unit: 'REL_TIME',
      Target: '0:00:45',
    });
    const seek = commands.filter((command) => command.type === 'seek').pop();
    assert(seek, '应产生 seek 指令');
    assert.strictEqual(seek.position, 45);

    // 6. 音量
    await postSoap(port, 'RenderingControl', 'SetVolume', {
      InstanceID: '0',
      Channel: 'Master',
      DesiredVolume: '30',
    });
    const volume = await (
      await postSoap(port, 'RenderingControl', 'GetVolume', {
        InstanceID: '0',
        Channel: 'Master',
      })
    ).text();
    assert.strictEqual(tag(volume, 'CurrentVolume'), '30');
    assert(commands.some((command) => command.type === 'volume' && command.volume === 30));

    // 7. GENA 事件订阅
    const notifications = [];
    callbackServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        notifications.push(body);
        res.writeHead(200);
        res.end();
      });
    });
    const callbackPort = await listen(callbackServer);
    const subscribe = await fetch(`http://127.0.0.1:${port}/event/AVTransport`, {
      method: 'SUBSCRIBE',
      headers: {
        CALLBACK: `<http://127.0.0.1:${callbackPort}/notify>`,
        NT: 'upnp:event',
        TIMEOUT: 'Second-300',
      },
    });
    assert.strictEqual(subscribe.status, 200, '订阅应成功');
    const sid = subscribe.headers.get('sid');
    assert(sid, '应返回 SID');

    await delay(350);
    assert(notifications.length >= 1, '应收到初始事件');

    device.pause();
    await delay(350);
    assert(
      notifications.some((body) => body.includes('PAUSED_PLAYBACK')),
      '状态变化应推送事件'
    );

    const unsubscribe = await fetch(`http://127.0.0.1:${port}/event/AVTransport`, {
      method: 'UNSUBSCRIBE',
      headers: { SID: sid },
    });
    assert.strictEqual(unsubscribe.status, 200, '取消订阅应成功');

    // 8. 停止
    await postSoap(port, 'AVTransport', 'Stop', { InstanceID: '0' });
    assert(commands.some((command) => command.type === 'stop'), '应产生 stop 指令');
    const stopped = await (
      await postSoap(port, 'AVTransport', 'GetTransportInfo', { InstanceID: '0' })
    ).text();
    assert.strictEqual(tag(stopped, 'CurrentTransportState'), 'STOPPED');

    // 9. 代理：B 站直播 CDN 防盗链所需请求头
    const biliHeaders = siteHeaders('https://d1--cn-gotcha204.bilivideo.com/live-bvc/1/live_1.flv');
    assert.strictEqual(biliHeaders.Referer, 'https://live.bilibili.com/', 'B 站地址应带 Referer');
    assert.strictEqual(biliHeaders.Origin, 'https://live.bilibili.com', 'B 站地址应带 Origin');
    const plainHeaders = siteHeaders('https://example.com/media.mp4');
    assert.strictEqual(plainHeaders.Referer, undefined, '普通地址不应带 Referer');

    // 10. 代理：Range 透传 + HLS 播放列表重写
    upstreamServer = http.createServer((req, res) => {
      if (req.url === '/master.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvideo/index.m3u8\n');
        return;
      }
      if (req.url === '/video/index.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(
          '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-ENDLIST\n'
        );
        return;
      }
      if (req.url === '/video/seg1.ts') {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end(Buffer.alloc(8, 7));
        return;
      }
      if (req.url === '/media.mp4') {
        const data = Buffer.from('0123456789abcdef');
        const range = req.headers.range;
        if (range) {
          const match = /bytes=(\d+)-(\d+)/.exec(range);
          const start = Number(match[1]);
          const end = Number(match[2]);
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes ${start}-${end}/${data.length}`,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
          });
          res.end(data.subarray(start, end + 1));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': data.length,
          'Accept-Ranges': 'bytes',
        });
        res.end(data);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const upstreamPort = await listen(upstreamServer);
    const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
    const proxyBase = `http://127.0.0.1:${port}/proxy`;

    const rangeResponse = await fetch(`${proxyBase}?url=${encodeURIComponent(`${upstreamBase}/media.mp4`)}`, {
      headers: { Range: 'bytes=2-5' },
    });
    assert.strictEqual(rangeResponse.status, 206, '代理应透传 206');
    assert.strictEqual(await rangeResponse.text(), '2345');
    assert(
      rangeResponse.headers.get('content-range') === 'bytes 2-5/16',
      '应透传 Content-Range'
    );

    const master = await (
      await fetch(`${proxyBase}?url=${encodeURIComponent(`${upstreamBase}/master.m3u8`)}&hls=1`)
    ).text();
    assert(master.includes('#EXTM3U'), '应返回播放列表');
    const variantLine = master
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('http://127.0.0.1:') && line.includes('hls=1'));
    assert(variantLine, '变体播放列表地址应被重写');

    const variant = await (await fetch(variantLine)).text();
    const lines = variant.split('\n').map((line) => line.trim());
    const segment = lines.find((line) => line.includes('seg1.ts'));
    assert(segment && segment.startsWith('http://127.0.0.1:'), '分片地址应被重写');
    const keyLine = lines.find((line) => line.includes('EXT-X-KEY'));
    assert(keyLine && keyLine.includes('/proxy?url='), '密钥地址应被重写');

    const segmentResponse = await fetch(segment);
    assert.strictEqual(segmentResponse.status, 200, '分片应可代理播放');
    assert.strictEqual((await segmentResponse.arrayBuffer()).byteLength, 8);

    console.log('PASS  DLNA 协议与媒体代理全部通过');
  } finally {
    if (callbackServer) await close(callbackServer);
    if (upstreamServer) await close(upstreamServer);
    await server.stop();
  }
}

main().catch((error) => {
  console.error('FAIL', error);
  process.exitCode = 1;
});

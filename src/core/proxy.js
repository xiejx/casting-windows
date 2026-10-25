'use strict';

const http = require('http');
const https = require('https');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

function upstreamRequest(targetUrl, options, redirectsLeft) {
  const { method = 'GET', headers = {} } = options || {};
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(error);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('仅支持 http/https 地址'));
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    let request;
    try {
      request = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers,
          rejectUnauthorized: false,
          timeout: 30000,
        },
        (response) => {
          const status = response.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirectsLeft > 0) {
            response.resume();
            let nextUrl;
            try {
              nextUrl = new URL(response.headers.location, targetUrl).toString();
            } catch {
              resolve({ response, finalUrl: targetUrl });
              return;
            }
            const nextMethod = status === 303 ? 'GET' : method;
            resolve(upstreamRequest(nextUrl, { method: nextMethod, headers }, redirectsLeft - 1));
            return;
          }
          resolve({ response, finalUrl: targetUrl });
        }
      );
    } catch (error) {
      reject(error);
      return;
    }

    request.on('timeout', () => request.destroy(new Error('上游请求超时')));
    request.on('error', reject);
    request.end();
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified'
  );
}

function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function makeProxyUrl(proxyBase, absoluteUrl, hls) {
  return `${proxyBase}/proxy?url=${encodeURIComponent(absoluteUrl)}${hls ? '&hls=1' : ''}`;
}

function rewritePlaylist(text, baseUrl, proxyBase) {
  const isMaster = /#EXT-X-STREAM-INF/i.test(text) || /#EXT-X-I-FRAME-STREAM-INF/i.test(text);
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]*)"/g, (match, uri) => {
          if (!uri) return match;
          let absolute;
          try {
            absolute = new URL(uri, baseUrl).toString();
          } catch {
            return match;
          }
          const playlistTag = /#EXT-X-MEDIA|#EXT-X-I-FRAME-STREAM-INF|#EXT-X-RENDITION-REPORT/i.test(trimmed);
          return `URI="${makeProxyUrl(proxyBase, absolute, playlistTag)}"`;
        });
      }
      let absolute;
      try {
        absolute = new URL(trimmed, baseUrl).toString();
      } catch {
        return line;
      }
      return makeProxyUrl(proxyBase, absolute, isMaster);
    })
    .join('\n');
}

function readBody(response, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        response.destroy(new Error('播放列表过大'));
        reject(new Error('播放列表过大'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.on('error', reject);
  });
}

async function handleProxy(req, res, urlObj, { port, logger }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  const rawUrl = urlObj.searchParams.get('url');
  if (!rawUrl) {
    sendError(res, 400, '缺少 url 参数');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    sendError(res, 400, 'url 参数无效');
    return;
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    sendError(res, 400, '仅支持 http/https 地址');
    return;
  }

  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
  };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

  let upstream;
  try {
    upstream = await upstreamRequest(targetUrl.toString(), { method: req.method, headers }, MAX_REDIRECTS);
  } catch (error) {
    logger.warn(`媒体代理请求失败：${error.message}`);
    sendError(res, 502, `无法访问媒体地址：${error.message}`);
    return;
  }

  const response = upstream.response;
  const finalUrl = upstream.finalUrl;
  const upstreamType = String(response.headers['content-type'] || '').toLowerCase();
  const forcedHls = urlObj.searchParams.get('hls') === '1';
  let finalPath = '';
  try {
    finalPath = new URL(finalUrl).pathname;
  } catch {
    finalPath = '';
  }
  const isPlaylist = forcedHls || /mpegurl/.test(upstreamType) || /\.m3u8(\?|#|$)/i.test(finalPath);

  if (isPlaylist && req.method !== 'HEAD') {
    try {
      const text = await readBody(response, MAX_PLAYLIST_BYTES);
      const proxyBase = `http://127.0.0.1:${port}`;
      const rewritten = rewritePlaylist(text, finalUrl, proxyBase);
      setCors(res);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      });
      res.end(rewritten);
    } catch (error) {
      logger.warn(`播放列表代理失败：${error.message}`);
      sendError(res, 502, `播放列表解析失败：${error.message}`);
    }
    return;
  }

  setCors(res);
  const passHeaders = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
  ];
  for (const name of passHeaders) {
    if (response.headers[name] != null) res.setHeader(name, response.headers[name]);
  }
  if (!response.headers['content-type'] && finalPath) {
    const guessed = require('./util').inferMime(finalUrl);
    if (guessed) res.setHeader('Content-Type', guessed);
  }

  res.writeHead(response.statusCode || 200);
  if (req.method === 'HEAD') {
    response.resume();
    res.end();
    return;
  }

  response.pipe(res);
  response.on('error', (error) => {
    logger.warn(`媒体流读取失败：${error.message}`);
    res.destroy();
  });
  res.on('close', () => {
    response.destroy();
  });
}

module.exports = {
  handleProxy,
  rewritePlaylist,
};

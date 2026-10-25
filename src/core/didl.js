'use strict';

const { XMLParser } = require('fast-xml-parser');
const { inferMime, isPlaylistMime, parseTime } = require('./util');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node).trim();
  }
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') {
    if (node['#text'] != null) return String(node['#text']).trim();
    if (node.__text != null) return String(node.__text).trim();
  }
  return '';
}

function protocolMime(protocolInfo) {
  if (!protocolInfo) return '';
  const parts = String(protocolInfo).split(':');
  const mime = (parts[2] || '').trim().toLowerCase();
  return mime === '*' ? '' : mime;
}

function dlnaProfile(protocolInfo) {
  const match = /DLNA\.ORG_PN=([^;:]+)/i.exec(String(protocolInfo || ''));
  return match ? match[1] : '';
}

function mimeFromProfile(profile) {
  if (!profile) return '';
  if (/^HLS/i.test(profile)) return 'application/vnd.apple.mpegurl';
  if (/^AVC_|^MPEG4_|^MP4_|^AVC_MP4/i.test(profile)) return 'video/mp4';
  if (/^MPEG_TS|^AVC_TS/i.test(profile)) return 'video/mp2t';
  if (/^MP3/i.test(profile)) return 'audio/mpeg';
  if (/^AAC/i.test(profile)) return 'audio/aac';
  if (/^AC3/i.test(profile)) return 'audio/vnd.dlna.adts';
  if (/^JPEG/i.test(profile)) return 'image/jpeg';
  if (/^PNG/i.test(profile)) return 'image/png';
  if (/^GIF/i.test(profile)) return 'image/gif';
  return '';
}

function mediaScore(mime, protocolInfo) {
  if (/^video\//i.test(mime)) return 30;
  if (/mpegurl/i.test(mime) || /dash\+xml/i.test(mime)) return 40;
  if (/^audio\//i.test(mime)) return 20;
  if (/^image\//i.test(mime)) return 10;
  if (/video/i.test(protocolInfo)) return 25;
  if (/audio/i.test(protocolInfo)) return 15;
  if (/image/i.test(protocolInfo)) return 5;
  return 1;
}

function parseMetadata(xml) {
  const result = {
    title: '',
    artist: '',
    album: '',
    artwork: '',
    duration: 0,
    url: '',
    mime: '',
    protocolInfo: '',
    isHls: false,
    isImage: false,
  };

  if (!xml || typeof xml !== 'string' || !xml.trim()) return result;

  let parsed;
  try {
    parsed = parser.parse(xml.replace(/^\uFEFF/, ''));
  } catch {
    return result;
  }

  const container = parsed['DIDL-Lite'] || parsed.DIDL || parsed;
  let item = null;
  if (container && container.item) {
    item = asArray(container.item)[0];
  } else if (container && container['@_id']) {
    item = container;
  }
  if (!item || typeof item !== 'object') return result;

  result.title =
    textOf(item.title) ||
    textOf(item['dc:title']) ||
    textOf(item.name) ||
    '';
  result.artist =
    textOf(item.artist) ||
    textOf(item['upnp:artist']) ||
    textOf(item.creator) ||
    textOf(item['dc:creator']) ||
    '';
  result.album = textOf(item.album) || textOf(item['upnp:album']) || '';

  const artworkNode =
    item.albumArtURI || item['upnp:albumArtURI'] || item.albumArtURI;
  result.artwork = asArray(artworkNode).map(textOf).find(Boolean) || '';

  const resources = asArray(item.res)
    .filter((node) => node && typeof node === 'object')
    .map((node) => {
      const protocolInfo = String(node['@_protocolInfo'] || '');
      const url = textOf(node);
      const profile = dlnaProfile(protocolInfo);
      const mime = protocolMime(protocolInfo) || mimeFromProfile(profile) || inferMime(url);
      const resolution = /^(\d+)\s*[xX]\s*(\d+)$/.exec(String(node['@_resolution'] || '').trim());
      return {
        url,
        protocolInfo,
        mime,
        height: resolution ? Number(resolution[2]) : 0,
        duration: parseTime(node['@_duration']),
        score: mediaScore(mime, protocolInfo),
      };
    })
    .filter((node) => node.url);

  resources.sort((a, b) => b.score - a.score);
  const chosen = resources[0];

  if (chosen) {
    result.url = chosen.url;
    result.protocolInfo = chosen.protocolInfo;
    result.mime = chosen.mime;
    result.duration = chosen.duration;
  }

  const profile = dlnaProfile(result.protocolInfo);
  if (/HLS/i.test(profile) || isPlaylistMime(result.mime) || /\.m3u8(\?|#|$)/i.test(result.url)) {
    result.isHls = true;
    if (!result.mime) result.mime = 'application/vnd.apple.mpegurl';
  }
  result.isImage = /^image\//i.test(result.mime);

  // 同一类型的所有备用地址，供接收端手动切换清晰度
  const kind = String(result.mime || '').split('/')[0];
  const seen = new Set();
  result.sources = resources
    .filter((node) => String(node.mime || '').split('/')[0] === kind)
    .filter((node) => {
      if (seen.has(node.url)) return false;
      seen.add(node.url);
      return true;
    })
    .map((node) => ({
      url: node.url,
      mime: node.mime,
      height: node.height,
      isHls: isPlaylistMime(node.mime) || /\.m3u8(\?|#|$)/i.test(node.url),
    }))
    .sort((a, b) => b.height - a.height);

  return result;
}

module.exports = {
  parseMetadata,
};

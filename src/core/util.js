'use strict';

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseTime(value) {
  if (value == null) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw));
  const parts = raw.split(':');
  if (parts.length === 3) {
    const h = Number(parts[0]) || 0;
    const m = Number(parts[1]) || 0;
    const s = Number(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const m = Number(parts[0]) || 0;
    const s = Number(parts[1]) || 0;
    return m * 60 + s;
  }
  return 0;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const EXT_MIME = {
  m3u8: 'application/vnd.apple.mpegurl',
  mpd: 'application/dash+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function inferMime(url) {
  if (!url) return '';
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url);
  }
  const clean = pathname.toLowerCase().split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return '';
  return EXT_MIME[clean.slice(dot + 1)] || '';
}

function isPlaylistMime(mime) {
  const m = String(mime || '').toLowerCase();
  return m.includes('mpegurl') || m.includes('dash+xml');
}

function guessTitle(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || u.hostname;
    return decodeURIComponent(last);
  } catch {
    return String(url);
  }
}

function truthy(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

module.exports = {
  escapeXml,
  parseTime,
  formatTime,
  inferMime,
  isPlaylistMime,
  guessTitle,
  truthy,
};

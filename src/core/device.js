'use strict';

const { EventEmitter } = require('events');
const { parseMetadata } = require('./didl');
const { inferMime, isPlaylistMime, guessTitle, formatTime, parseTime } = require('./util');

class DlnaDevice extends EventEmitter {
  constructor({ logger, config } = {}) {
    super();
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.config = config || {};

    this.transportState = 'STOPPED';
    this.transportStatus = 'OK';
    this.uri = '';
    this.metadata = '';
    this.media = {
      title: '',
      artist: '',
      artwork: '',
      mime: '',
      isHls: false,
      isImage: false,
      url: '',
    };
    this.position = 0;
    this.duration = 0;

    this.volume = 60;
    this.mute = false;

    this.hasMedia = false;
    this.lastError = '';
  }

  getCurrentTransportActions() {
    if (!this.hasMedia) return '';
    switch (this.transportState) {
      case 'PLAYING':
        return 'Play,Stop,Pause,Seek';
      case 'PAUSED_PLAYBACK':
        return 'Play,Stop,Seek';
      case 'TRANSITIONING':
        return 'Stop';
      case 'STOPPED':
        return 'Play,Seek';
      default:
        return '';
    }
  }

  getSnapshot() {
    return {
      transportState: this.transportState,
      transportStatus: this.transportStatus,
      title: this.media.title,
      artist: this.media.artist,
      artwork: this.media.artwork,
      mime: this.media.mime,
      isHls: this.media.isHls,
      isImage: this.media.isImage,
      position: this.position,
      duration: this.duration,
      volume: this.volume,
      mute: this.mute,
      uri: this.uri,
      hasMedia: this.hasMedia,
      lastError: this.lastError,
    };
  }

  setUri(uri, metadataXml) {
    const meta = parseMetadata(metadataXml);
    const rawUri = String(uri || '').trim();
    const url = /^https?:\/\//i.test(rawUri) ? rawUri : meta.url;
    if (!url) {
      this.logger.warn('收到投屏请求，但媒体地址无效');
      return false;
    }

    const mime = meta.mime || inferMime(url);
    const isHls =
      meta.isHls || isPlaylistMime(mime) || /\.m3u8(\?|#|$)/i.test(url);
    const isImage = meta.isImage || /^image\//i.test(mime);
    const title = meta.title || guessTitle(url);

    this.uri = url;
    this.metadata = metadataXml || '';
    this.media = {
      title,
      artist: meta.artist,
      artwork: meta.artwork,
      mime: isHls ? mime || 'application/vnd.apple.mpegurl' : mime,
      isHls,
      isImage,
      url,
      sources: meta.sources || [],
    };
    this.position = 0;
    this.duration = meta.duration || 0;
    this.hasMedia = true;
    this.lastError = '';
    this.transportState = 'TRANSITIONING';

    this.logger.info(`收到投屏：${title}${isHls ? ' (HLS)' : ''}`);
    this.emit('command', {
      type: 'load',
      url,
      mime: this.media.mime,
      isHls,
      isImage,
      title,
      artist: meta.artist,
      artwork: meta.artwork,
      duration: this.duration,
      sources: this.media.sources,
    });
    this._changed('AVTransport');
    return true;
  }

  play() {
    if (!this.hasMedia) return false;
    this.emit('command', { type: 'play' });
    if (this.transportState !== 'PLAYING') {
      this.transportState = 'PLAYING';
      this._changed('AVTransport');
    }
    return true;
  }

  pause() {
    if (!this.hasMedia) return false;
    this.emit('command', { type: 'pause' });
    if (this.transportState === 'PLAYING' || this.transportState === 'TRANSITIONING') {
      this.transportState = 'PAUSED_PLAYBACK';
      this._changed('AVTransport');
    }
    return true;
  }

  stop() {
    if (this.hasMedia) {
      this.emit('command', { type: 'stop' });
    }
    this.position = 0;
    if (this.transportState !== 'STOPPED') {
      this.transportState = 'STOPPED';
      this._changed('AVTransport');
    }
    return true;
  }

  seek(unit, target) {
    if (!this.hasMedia) return false;
    const mode = String(unit || 'REL_TIME').toUpperCase();
    let seconds = 0;
    if (mode === 'TRACK_NR' || mode === 'TRACK') {
      seconds = 0;
    } else {
      seconds = parseTime(target);
    }
    if (seconds < 0) seconds = 0;
    if (this.duration > 0 && seconds > this.duration) seconds = this.duration;
    this.position = seconds;
    this.emit('command', { type: 'seek', position: seconds });
    return true;
  }

  setVolume(volume, mute) {
    const parsed = Number(volume);
    if (Number.isFinite(parsed)) {
      this.volume = Math.min(100, Math.max(0, Math.round(parsed)));
    }
    if (mute !== undefined) {
      this.mute = Boolean(mute);
    }
    this.emit('command', {
      type: 'volume',
      volume: this.volume,
      muted: this.mute,
    });
    this._changed('RenderingControl');
  }

  updateVolumeFromPlayer(volume, muted) {
    const parsed = Number(volume);
    if (Number.isFinite(parsed)) {
      this.volume = Math.min(100, Math.max(0, Math.round(parsed)));
    }
    if (muted !== undefined) {
      this.mute = Boolean(muted);
    }
    this._changed('RenderingControl');
  }

  updatePosition(position, duration) {
    const pos = Number(position);
    const dur = Number(duration);
    if (Number.isFinite(pos)) this.position = Math.max(0, pos);
    if (Number.isFinite(dur) && dur > 0) this.duration = dur;
  }

  updateFromPlayer(update = {}) {
    if (!this.hasMedia) return;
    this.updatePosition(update.position, update.duration);

    const state = String(update.state || '').toUpperCase();
    let next = null;
    if (state === 'PLAYING') {
      next = 'PLAYING';
    } else if (state === 'PAUSED') {
      next = 'PAUSED_PLAYBACK';
    } else if (state === 'LOADING' || state === 'TRANSITIONING') {
      next = 'TRANSITIONING';
    } else if (state === 'ENDED' || state === 'STOPPED') {
      next = 'STOPPED';
    }

    if (!next) return;
    if (next === 'PAUSED_PLAYBACK' && this.transportState !== 'PLAYING' && this.transportState !== 'TRANSITIONING') {
      return;
    }
    if (next !== this.transportState) {
      this.transportState = next;
      if (next === 'STOPPED' && (state === 'ENDED' || update.resetPosition)) {
        this.position = 0;
      }
      this._changed('AVTransport');
    }
  }

  reportError(message) {
    this.lastError = String(message || '播放失败');
    this.logger.error(`播放失败：${this.lastError}`);
    this.transportState = 'STOPPED';
    this.position = 0;
    this._changed('AVTransport');
  }

  formatDuration() {
    return formatTime(this.duration);
  }

  _changed(service) {
    this.emit('state', { service, snapshot: this.getSnapshot() });
  }
}

module.exports = { DlnaDevice };

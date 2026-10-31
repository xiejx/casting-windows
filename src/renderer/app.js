'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  statusChip: $('statusChip'),
  statusText: $('statusText'),
  settingsBtn: $('settingsBtn'),
  stage: $('stage'),
  playerCard: $('playerCard'),
  video: $('video'),
  imageView: $('imageView'),
  audioView: $('audioView'),
  audioCover: $('audioCover'),
  audioPlaceholder: $('audioPlaceholder'),
  idleView: $('idleView'),
  idleDeviceName: $('idleDeviceName'),
  stateBadge: $('stateBadge'),
  mediaType: $('mediaType'),
  nowTitle: $('nowTitle'),
  nowSub: $('nowSub'),
  playPauseBtn: $('playPauseBtn'),
  stopBtn: $('stopBtn'),
  currentTime: $('currentTime'),
  totalTime: $('totalTime'),
  seekBar: $('seekBar'),
  muteBtn: $('muteBtn'),
  volumeBar: $('volumeBar'),
  speedBtn: $('speedBtn'),
  speedLabel: $('speedLabel'),
  speedMenu: $('speedMenu'),
  qualityBtn: $('qualityBtn'),
  qualityLabel: $('qualityLabel'),
  qualityMenu: $('qualityMenu'),
  fullscreenBtn: $('fullscreenBtn'),
  infoName: $('infoName'),
  infoAddr: $('infoAddr'),
  infoState: $('infoState'),
  cachePath: $('cachePath'),
  cacheSize: $('cacheSize'),
  cacheMode: $('cacheMode'),
  openCacheBtn: $('openCacheBtn'),
  clearCacheBtn: $('clearCacheBtn'),
  firewallBtn: $('firewallBtn'),
  logList: $('logList'),
  clearLogBtn: $('clearLogBtn'),
  settingsModal: $('settingsModal'),
  modalMask: $('modalMask'),
  nameInput: $('nameInput'),
  portInput: $('portInput'),
  interfaceSelect: $('interfaceSelect'),
  cancelBtn: $('cancelBtn'),
  saveBtn: $('saveBtn'),
  toast: $('toast'),
};

const state = {
  status: null,
  mode: 'idle',
  hasMedia: false,
  isPlaying: false,
  ignorePause: false,
  duration: 0,
  volume: 60,
  muted: false,
  rate: 1,
  command: null,
  sources: [],
  sourceIndex: 0,
  qualityOptions: [],
  qualityValue: 'auto',
  pendingSeek: null,
  hls: null,
  mpegts: null,
  scrubbing: false,
  lastTimeSentAt: 0,
  lastError: '',
  resumeTried: false,
  toastTimer: null,
  logsReady: false,
};

let hideUiTimer = null;
let fsIgnoreMoveUntil = 0;

function init() {
  bindEvents();
  syncFullscreenIcon();
  window.cast.onCommand(handleCommand);
  window.cast.onStatus((status) => applyStatus(status));
  window.cast.onLog((entry) => appendLog(entry));

  window.cast
    .getStatus()
    .then((status) => applyStatus(status, true))
    .catch((error) => showToast(`无法获取服务状态：${error.message}`, true));
}

function bindEvents() {
  ui.settingsBtn.addEventListener('click', openSettings);
  ui.cancelBtn.addEventListener('click', closeSettings);
  ui.modalMask.addEventListener('click', closeSettings);
  ui.saveBtn.addEventListener('click', saveSettings);
  ui.firewallBtn.addEventListener('click', requestFirewall);
  ui.clearLogBtn.addEventListener('click', () => {
    ui.logList.innerHTML = '';
  });

  ui.playPauseBtn.addEventListener('click', togglePlay);
  ui.stopBtn.addEventListener('click', () => {
    stopPlayback();
    window.cast.updatePlayer('state', { state: 'STOPPED' });
  });

  ui.seekBar.addEventListener('input', onSeekPreview);
  ui.seekBar.addEventListener('change', onSeekCommit);

  ui.volumeBar.addEventListener('input', () => {
    state.volume = Number(ui.volumeBar.value);
    applyVolumeToMedia();
    window.cast.updatePlayer('volume', { volume: state.volume, muted: state.muted });
  });

  ui.muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    applyVolumeToMedia();
    window.cast.updatePlayer('volume', { volume: state.volume, muted: state.muted });
  });

  ui.fullscreenBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', syncFullscreenIcon);

  ui.speedBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setSpeedMenu(ui.speedMenu.hidden);
  });
  ui.speedMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-rate]');
    if (!option) return;
    setPlaybackRate(Number(option.dataset.rate));
    setSpeedMenu(false);
  });
  ui.qualityBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setQualityMenu(ui.qualityMenu.hidden);
  });
  ui.qualityMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-quality]');
    if (!option) return;
    applyQuality(option.dataset.quality);
    setQualityMenu(false);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.speed')) setSpeedMenu(false);
    if (!event.target.closest('.quality')) setQualityMenu(false);
  });
  ui.openCacheBtn.addEventListener('click', openCacheDir);
  ui.clearCacheBtn.addEventListener('click', clearCache);
  ui.playerCard.addEventListener('mousemove', () => {
    if (document.fullscreenElement && Date.now() >= fsIgnoreMoveUntil) showFullscreenUi();
  });

  ui.video.addEventListener('loadedmetadata', () => {
    const duration = Number(ui.video.duration);
    if (Number.isFinite(duration) && duration > 0) state.duration = duration;
    if (state.pendingSeek != null) {
      const target = state.pendingSeek;
      state.pendingSeek = null;
      try {
        ui.video.currentTime = target;
      } catch {
        // 无法定位时忽略
      }
    }
    updateProgress();
    sendTime(true);
  });
  ui.video.addEventListener('durationchange', () => {
    const duration = Number(ui.video.duration);
    if (Number.isFinite(duration) && duration > 0) state.duration = duration;
    updateProgress();
  });
  ui.video.addEventListener('timeupdate', () => {
    if (!state.scrubbing) updateProgress();
    sendTime(false);
  });
  ui.video.addEventListener('playing', () => {
    state.isPlaying = true;
    state.ignorePause = false;
    state.lastError = '';
    setStateBadge('PLAYING');
    window.cast.updatePlayer('state', {
      state: 'PLAYING',
      position: ui.video.currentTime,
      duration: safeDuration(),
    });
  });
  ui.video.addEventListener('pause', () => {
    state.isPlaying = false;
    if (state.ignorePause) return;
    if (!state.hasMedia || ui.video.ended) return;
    if (!ui.video.paused) return;
    setStateBadge('PAUSED_PLAYBACK');
    window.cast.updatePlayer('state', {
      state: 'PAUSED',
      position: ui.video.currentTime,
      duration: safeDuration(),
    });
  });
  ui.video.addEventListener('ended', () => {
    state.isPlaying = false;
    setStateBadge('STOPPED');
    ui.currentTime.textContent = '0:00';
    ui.seekBar.value = '0';
    ui.seekBar.style.setProperty('--progress', '0%');
    window.cast.updatePlayer('ended', {});
  });
  ui.video.addEventListener('error', () => {
    if (!state.hasMedia || state.mode === 'image') return;
    if (!ui.video.currentSrc && !ui.video.src) return;
    const code = ui.video.error ? ui.video.error.code : 0;
    reportError(`媒体播放失败（错误码 ${code}）`);
  });
}

async function handleCommand(command) {
  if (!command || !command.type) return;
  switch (command.type) {
    case 'load':
      await loadMedia(command);
      break;
    case 'play':
      if (state.mode === 'image') return;
      if (state.hasMedia) {
        ui.video.play().catch((error) => reportError(`无法播放：${error.message}`));
      }
      break;
    case 'pause':
      if (state.hasMedia && state.mode !== 'image') ui.video.pause();
      break;
    case 'stop':
      stopPlayback();
      break;
    case 'seek':
      if (state.hasMedia && state.mode !== 'image' && Number.isFinite(Number(command.position))) {
        try {
          ui.video.currentTime = Math.max(0, Number(command.position));
          updateProgress();
          sendTime(true);
        } catch {
          // 忽略无法定位的流
        }
      }
      break;
    case 'volume':
      state.volume = clampVolume(command.volume);
      state.muted = Boolean(command.muted);
      applyVolumeToMedia();
      break;
    default:
      break;
  }
}

async function loadMedia(command) {
  cleanupHls();
  cleanupMpegts();
  state.command = command;
  state.sources = Array.isArray(command.sources) ? command.sources : [];
  const sourceIndex = state.sources.findIndex((source) => source.url === command.url);
  state.sourceIndex = sourceIndex >= 0 ? sourceIndex : 0;
  state.qualityValue = 'auto';
  setQualityOptions([]);
  state.ignorePause = true;
  state.hasMedia = true;
  state.isPlaying = false;
  state.lastError = '';
  state.duration = Number(command.duration) || 0;
  state.mode = command.isImage
    ? 'image'
    : String(command.mime || '').startsWith('audio/')
      ? 'audio'
      : 'video';

  ui.video.pause();
  ui.video.removeAttribute('src');
  ui.video.load();
  ui.imageView.hidden = true;
  ui.imageView.removeAttribute('src');
  ui.audioView.hidden = true;
  ui.audioCover.hidden = true;
  ui.audioCover.removeAttribute('src');
  ui.audioPlaceholder.hidden = false;

  setStageMode(state.mode);
  ui.nowTitle.textContent = command.title || '正在播放';
  ui.nowSub.textContent = buildSubtitle(command);
  ui.mediaType.textContent = mediaLabel(command);

  setControlsEnabled(true, state.mode !== 'image');
  resetProgress();

  if (command.artwork && state.mode === 'audio') {
    ui.audioCover.src = command.artwork;
    ui.audioCover.hidden = false;
    ui.audioPlaceholder.hidden = true;
  }

  if (state.mode === 'image') {
    ui.imageView.src = command.url;
    ui.imageView.hidden = false;
    state.isPlaying = true;
    setStateBadge('PLAYING');
    window.cast.updatePlayer('state', { state: 'PLAYING', position: 0, duration: 0 });
    return;
  }

  applyVolumeToMedia();

  // FLV 直播流（如 B 站直播）Chromium 原生不支持，需要用 mpegts.js 转封装
  if (isFlvSource(command)) {
    buildSourceQuality();
    startMpegtsPlayback(command.url);
    return;
  }

  if (command.isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true, backBufferLength: 90 });
    state.hls = hls;
    hls.on(window.Hls.Events.ERROR, (event, data) => {
      if (data && data.fatal) {
        reportError(`HLS 流播放失败：${data.details || data.type}`);
      }
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => buildHlsQuality());
    hls.attachMedia(ui.video);
    hls.loadSource(command.url);
  } else {
    ui.video.src = command.url;
    buildSourceQuality();
  }

  try {
    await ui.video.play();
  } catch (error) {
    state.ignorePause = false;
    reportError(`无法开始播放：${error.message || error}`);
  }
}

function stopPlayback() {
  cleanupHls();
  cleanupMpegts();
  state.hasMedia = false;
  state.isPlaying = false;
  state.ignorePause = false;
  state.duration = 0;
  state.mode = 'idle';
  state.lastError = '';
  state.command = null;
  state.sources = [];
  state.pendingSeek = null;
  setQualityOptions([]);

  ui.video.pause();
  ui.video.removeAttribute('src');
  ui.video.load();
  ui.imageView.hidden = true;
  ui.imageView.removeAttribute('src');
  ui.audioView.hidden = true;
  ui.audioCover.hidden = true;
  ui.audioCover.removeAttribute('src');

  setStageMode('idle');
  setControlsEnabled(false, false);
  resetProgress();
  setStateBadge('STOPPED');
  ui.nowTitle.textContent = '暂无播放';
  ui.nowSub.textContent = '等待接收投屏内容';
  ui.mediaType.textContent = '';
}

function togglePlay() {
  if (!state.hasMedia || state.mode === 'image') return;
  if (ui.video.paused || ui.video.ended) {
    ui.video.play().catch((error) => reportError(`无法播放：${error.message}`));
  } else {
    ui.video.pause();
  }
}

function onSeekPreview() {
  if (!state.hasMedia) return;
  state.scrubbing = true;
  const duration = safeDuration();
  const percent = Number(ui.seekBar.value) / 1000;
  ui.seekBar.style.setProperty('--progress', `${percent * 100}%`);
  if (duration > 0) ui.currentTime.textContent = formatTime(percent * duration);
}

function onSeekCommit() {
  state.scrubbing = false;
  if (!state.hasMedia || state.mode === 'image') {
    updateProgress();
    return;
  }
  const duration = safeDuration();
  if (duration <= 0) return;
  const position = (Number(ui.seekBar.value) / 1000) * duration;
  try {
    ui.video.currentTime = position;
    sendTime(true);
  } catch {
    updateProgress();
  }
}

function applyStatus(status, initial = false) {
  if (!status) return;
  state.status = status;
  const { config, ip, port, snapshot } = status;

  ui.infoName.textContent = config.deviceName;
  ui.idleDeviceName.textContent = config.deviceName;
  ui.infoAddr.textContent = `${ip}:${port}`;
  ui.infoState.textContent = status.ready ? '已就绪' : '未启动';
  ui.infoState.className = status.ready ? 'good' : 'bad';
  ui.cacheMode.hidden = !status.portable;

  ui.statusChip.classList.remove('busy', 'offline');
  if (!status.ready) {
    ui.statusChip.classList.add('offline');
    ui.statusText.textContent = '服务启动中…';
  } else if (snapshot && (snapshot.transportState === 'PLAYING' || snapshot.transportState === 'TRANSITIONING')) {
    ui.statusChip.classList.add('busy');
    ui.statusText.textContent = '正在接收投屏';
  } else {
    ui.statusText.textContent = `服务已就绪 · ${ip}`;
  }

  if (snapshot && !state.hasMedia) {
    setStateBadge(snapshot.hasMedia ? snapshot.transportState : 'STOPPED');
    if (snapshot.lastError && snapshot.lastError !== state.lastError) {
      state.lastError = snapshot.lastError;
    }
  }

  if (initial) {
    state.volume = clampVolume(snapshot ? snapshot.volume : 60);
    state.muted = Boolean(snapshot && snapshot.mute);
    ui.volumeBar.value = String(state.volume);
    updateVolumeUI();

    ui.logList.innerHTML = '';
    (status.logs || []).forEach((entry) => appendLog(entry, true));
    state.logsReady = true;
    fillSettings(status);
  }

  maybeResume(status, snapshot);
}

function maybeResume(status, snapshot) {
  if (state.resumeTried || state.hasMedia) return;
  if (!snapshot || !snapshot.hasMedia || !snapshot.uri) return;
  if (snapshot.transportState !== 'PLAYING' && snapshot.transportState !== 'PAUSED_PLAYBACK') return;
  state.resumeTried = true;

  const proxy = (url, hls) =>
    `http://127.0.0.1:${status.port}/proxy?url=${encodeURIComponent(url)}${hls ? '&hls=1' : ''}`;
  loadMedia({
    type: 'load',
    url: proxy(snapshot.uri, snapshot.isHls),
    mime: snapshot.mime,
    isHls: snapshot.isHls,
    isImage: snapshot.isImage,
    title: snapshot.title,
    artist: snapshot.artist,
    artwork: snapshot.artwork ? proxy(snapshot.artwork, false) : '',
    duration: snapshot.duration,
  });
}

// SVG 元素没有 hidden 的 IDL 属性，必须操作属性本身才能生效
function setShown(element, shown) {
  if (!element) return;
  if (shown) element.removeAttribute('hidden');
  else element.setAttribute('hidden', '');
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  ui.playerCard.requestFullscreen().catch((error) => {
    showToast(`无法进入全屏：${error.message}`, true);
  });
}

function showFullscreenUi() {
  ui.playerCard.classList.add('show-ui');
  clearTimeout(hideUiTimer);
  hideUiTimer = setTimeout(() => {
    if (document.fullscreenElement && ui.speedMenu.hidden && ui.qualityMenu.hidden) {
      ui.playerCard.classList.remove('show-ui');
    }
    hideUiTimer = null;
  }, 3000);
}

function setSpeedMenu(open) {
  ui.speedMenu.hidden = !open;
  if (open) {
    clearTimeout(hideUiTimer);
    hideUiTimer = null;
  } else if (document.fullscreenElement && ui.playerCard.classList.contains('show-ui')) {
    showFullscreenUi();
  }
}

function setQualityMenu(open) {
  ui.qualityMenu.hidden = !open || !state.qualityOptions.length;
  if (!ui.qualityMenu.hidden) {
    clearTimeout(hideUiTimer);
    hideUiTimer = null;
  } else if (document.fullscreenElement && ui.playerCard.classList.contains('show-ui')) {
    showFullscreenUi();
  }
}

function setQualityOptions(options, currentValue) {
  state.qualityOptions = options;
  ui.qualityMenu.replaceChildren();
  if (!options.length) {
    ui.qualityBtn.hidden = true;
    ui.qualityMenu.hidden = true;
    ui.qualityLabel.textContent = '自动';
    return;
  }
  ui.qualityBtn.hidden = false;
  for (const option of options) {
    const button = document.createElement('button');
    button.textContent = option.label;
    button.dataset.quality = String(option.value);
    ui.qualityMenu.append(button);
  }
  syncQualityLabel(currentValue);
}

function syncQualityLabel(value) {
  state.qualityValue = String(value);
  const current = state.qualityOptions.find((item) => String(item.value) === String(value));
  ui.qualityLabel.textContent = current ? current.label : '自动';
  for (const button of ui.qualityMenu.children) {
    button.classList.toggle('active', button.dataset.quality === String(value));
  }
}

function buildSourceQuality() {
  if (state.mode !== 'video' || state.sources.length < 2) {
    setQualityOptions([]);
    return;
  }
  const options = state.sources.map((source, index) => ({
    value: index,
    label: source.height ? `${source.height}P` : `清晰度 ${index + 1}`,
  }));
  setQualityOptions(options, state.sourceIndex);
}

function buildHlsQuality() {
  if (!state.hls || !Array.isArray(state.hls.levels) || !state.hls.levels.length) {
    setQualityOptions([]);
    return;
  }
  const levels = state.hls.levels
    .map((level, index) => ({
      value: index,
      label: level.height ? `${level.height}P` : `${Math.round((level.bitrate || 0) / 1000)}K`,
      height: level.height || 0,
    }))
    .sort((a, b) => b.height - a.height);
  setQualityOptions([{ value: 'auto', label: '自动' }, ...levels], 'auto');
}

function applyQuality(value) {
  if (state.hls) {
    state.hls.currentLevel = value === 'auto' ? -1 : Number(value);
    syncQualityLabel(value);
    return;
  }
  const index = Number(value);
  if (Number.isInteger(index) && index >= 0 && index < state.sources.length) {
    switchSource(index);
  }
}

async function switchSource(index) {
  const command = state.command;
  const source = state.sources[index];
  if (!command || !source) return;
  if (index === state.sourceIndex) {
    syncQualityLabel(index);
    return;
  }
  const time = ui.video.currentTime;
  const wasPlaying = !ui.video.paused;
  state.pendingSeek = Number.isFinite(time) ? time : 0;
  await loadMedia({
    ...command,
    url: source.url,
    mime: source.mime || command.mime,
    isHls: Boolean(source.isHls),
    isImage: false,
    sources: state.sources,
  });
  if (!wasPlaying) ui.video.pause();
}

function setPlaybackRate(rate) {
  state.rate = rate;
  ui.video.defaultPlaybackRate = rate;
  ui.video.playbackRate = rate;
  ui.speedLabel.textContent = `${rate}×`;
  for (const option of ui.speedMenu.querySelectorAll('[data-rate]')) {
    option.classList.toggle('active', Number(option.dataset.rate) === rate);
  }
}

function syncFullscreenIcon() {
  const full = Boolean(document.fullscreenElement);
  setShown(ui.fullscreenBtn.querySelector('.ic-expand'), !full);
  setShown(ui.fullscreenBtn.querySelector('.ic-shrink'), full);
  ui.fullscreenBtn.title = full ? '退出全屏' : '全屏';
  clearTimeout(hideUiTimer);
  hideUiTimer = null;
  ui.playerCard.classList.remove('show-ui');
  if (!full) {
    ui.speedMenu.hidden = true;
    ui.qualityMenu.hidden = true;
  }
  // 进入全屏后鼠标仍停在按钮上，短暂忽略这次移动，让界面保持隐藏
  if (full) fsIgnoreMoveUntil = Date.now() + 500;
}

function setStageMode(mode) {
  ui.stage.classList.remove('mode-idle', 'mode-video', 'mode-audio', 'mode-image');
  ui.stage.classList.add(`mode-${mode}`);
  ui.idleView.hidden = mode !== 'idle';
  ui.video.hidden = mode !== 'video';
  ui.imageView.hidden = mode !== 'image';
  ui.audioView.hidden = mode !== 'audio';
}

function setControlsEnabled(enabled, seekable) {
  ui.playPauseBtn.disabled = !enabled || !seekable;
  ui.stopBtn.disabled = !enabled;
  ui.seekBar.disabled = !enabled || !seekable;
}

function setStateBadge(transportState) {
  const labels = {
    STOPPED: '待机',
    PLAYING: '播放中',
    PAUSED_PLAYBACK: '已暂停',
    TRANSITIONING: '连接中',
    NO_MEDIA_PRESENT: '待机',
  };
  const label = labels[transportState] || '待机';
  ui.stateBadge.textContent = label;
  ui.stateBadge.className = `state-badge${transportState === 'PLAYING' ? ' live' : ''}${
    transportState === 'PAUSED_PLAYBACK' ? ' paused' : ''
  }`;
  const playing = transportState === 'PLAYING';
  setShown(ui.playPauseBtn.querySelector('.ic-play'), !playing);
  setShown(ui.playPauseBtn.querySelector('.ic-pause'), playing);
}

function updateProgress() {
  const duration = safeDuration();
  const position = Number(ui.video.currentTime) || 0;
  const percent = duration > 0 ? Math.min(1, position / duration) : 0;
  ui.seekBar.value = String(Math.round(percent * 1000));
  ui.seekBar.style.setProperty('--progress', `${percent * 100}%`);
  ui.currentTime.textContent = formatTime(position);
  ui.totalTime.textContent = duration > 0 ? formatTime(duration) : '0:00';
}

function resetProgress() {
  ui.seekBar.value = '0';
  ui.seekBar.style.setProperty('--progress', '0%');
  ui.currentTime.textContent = '0:00';
  ui.totalTime.textContent = state.duration > 0 ? formatTime(state.duration) : '0:00';
}

function sendTime(force) {
  if (!state.hasMedia || state.mode === 'image') return;
  const now = Date.now();
  if (!force && now - state.lastTimeSentAt < 800) return;
  state.lastTimeSentAt = now;
  window.cast.updatePlayer('time', {
    position: Number(ui.video.currentTime) || 0,
    duration: safeDuration(),
  });
}

function applyVolumeToMedia() {
  ui.video.volume = state.muted ? 0 : state.volume / 100;
  updateVolumeUI();
}

function updateVolumeUI() {
  ui.volumeBar.value = String(state.volume);
  ui.volumeBar.style.setProperty('--progress', `${state.volume}%`);
  setShown(ui.muteBtn.querySelector('.ic-vol'), !state.muted);
  setShown(ui.muteBtn.querySelector('.ic-mute'), state.muted);
}

function cleanupHls() {
  if (state.hls) {
    try {
      state.hls.destroy();
    } catch {
      // 忽略
    }
    state.hls = null;
  }
}

function cleanupMpegts() {
  if (!state.mpegts) return;
  const player = state.mpegts;
  state.mpegts = null;
  try {
    player.pause();
    player.unload();
    player.detachMediaElement();
    player.destroy();
  } catch {
    // 忽略
  }
}

function isFlvSource(command) {
  const mime = String(command.mime || '').toLowerCase();
  if (mime.includes('flv')) return true;
  return /\.flv(\?|#|$)/i.test(String(command.url || ''));
}

function startMpegtsPlayback(url) {
  if (!window.mpegts || !window.mpegts.isSupported()) {
    reportError('当前环境不支持 FLV 播放');
    return;
  }
  const player = window.mpegts.createPlayer(
    { type: 'flv', isLive: true, url },
    {
      enableWorker: false,
      enableStashBuffer: false,
      lazyLoad: false,
      liveBufferLatencyChasing: true,
    }
  );
  state.mpegts = player;
  player.on(window.mpegts.Events.ERROR, (type, detail, info) => {
    const reason = (info && info.msg) || detail || type || '未知错误';
    reportError(`FLV 直播流播放失败：${reason}`);
  });
  player.attachMediaElement(ui.video);
  player.load();
  player.play().catch((error) => {
    state.ignorePause = false;
    reportError(`无法开始播放：${error.message || error}`);
  });
}

function reportError(message) {
  if (!message || message === state.lastError) return;
  state.lastError = message;
  setStateBadge('STOPPED');
  window.cast.updatePlayer('error', { message });
  showToast(message, true);
}

function safeDuration() {
  const duration = Number(ui.video.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  return state.duration > 0 ? state.duration : 0;
}

function mediaLabel(command) {
  if (command.isImage) return '图片';
  const mime = String(command.mime || '').toLowerCase();
  if (command.isHls || mime.includes('mpegurl')) return 'HLS 流';
  if (isFlvSource(command)) return 'FLV 直播流';
  if (mime.startsWith('audio/')) return '音频';
  if (mime.startsWith('video/')) {
    const ext = mime.slice('video/'.length);
    return `${ext.toUpperCase()} 视频`;
  }
  return '媒体流';
}

function buildSubtitle(command) {
  const parts = [];
  if (command.artist) parts.push(command.artist);
  const mime = String(command.mime || '');
  if (mime) parts.push(mime);
  if (command.isHls) parts.push('HLS');
  return parts.join(' · ') || '投屏内容';
}

function fillSettings(status) {
  ui.nameInput.value = status.config.deviceName;
  ui.portInput.value = String(status.config.port);
  ui.interfaceSelect.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '自动选择';
  ui.interfaceSelect.appendChild(auto);
  (status.interfaces || []).forEach((item) => {
    const option = document.createElement('option');
    option.value = item.address;
    option.textContent = `${item.address}（${item.name}）`;
    ui.interfaceSelect.appendChild(option);
  });
  ui.interfaceSelect.value = status.config.interfaceIp || '';
}

function openSettings() {
  if (state.status) fillSettings(state.status);
  ui.settingsModal.hidden = false;
  refreshCacheInfo();
}

function formatBytes(bytes) {
  const mb = Number(bytes || 0) / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

async function refreshCacheInfo() {
  try {
    const info = await window.cast.getCacheInfo();
    ui.cachePath.textContent = info.dir;
    ui.cachePath.title = info.dir;
    ui.cacheSize.textContent = `当前占用 ${formatBytes(info.bytes)}`;
  } catch (error) {
    ui.cacheSize.textContent = '无法读取缓存大小';
  }
}

async function openCacheDir() {
  const result = await window.cast.openCacheDir();
  if (!result.ok) showToast(`无法打开目录：${result.error}`, true);
}

async function clearCache() {
  ui.clearCacheBtn.disabled = true;
  ui.clearCacheBtn.textContent = '清理中…';
  try {
    const result = await window.cast.clearCache();
    if (!result.ok) throw new Error(result.error || '清理失败');
    ui.cachePath.textContent = result.dir;
    ui.cachePath.title = result.dir;
    ui.cacheSize.textContent = `当前占用 ${formatBytes(result.bytes)}`;
    showToast(`缓存已清理，释放 ${formatBytes(result.freed)}`);
    appendLog({ level: 'info', message: `已清理缓存，释放 ${formatBytes(result.freed)}` });
  } catch (error) {
    showToast(`清理缓存失败：${error.message}`, true);
  } finally {
    ui.clearCacheBtn.disabled = false;
    ui.clearCacheBtn.textContent = '清除缓存';
  }
}

function closeSettings() {
  ui.settingsModal.hidden = true;
}

async function saveSettings() {
  const payload = {
    deviceName: ui.nameInput.value.trim(),
    port: Number(ui.portInput.value),
    interfaceIp: ui.interfaceSelect.value,
  };
  ui.saveBtn.disabled = true;
  const original = ui.saveBtn.textContent;
  ui.saveBtn.textContent = '保存中…';
  try {
    const result = await window.cast.saveConfig(payload);
    if (result.ok) {
      state.resumeTried = false;
      applyStatus(result.status, false);
      closeSettings();
      showToast('设置已保存，投屏服务已重启');
    } else {
      showToast(result.error || '保存失败', true);
    }
  } catch (error) {
    showToast(`保存失败：${error.message}`, true);
  } finally {
    ui.saveBtn.disabled = false;
    ui.saveBtn.textContent = original;
  }
}

async function requestFirewall() {
  ui.firewallBtn.disabled = true;
  const original = ui.firewallBtn.textContent;
  ui.firewallBtn.textContent = '正在请求管理员权限…';
  try {
    const result = await window.cast.openFirewall();
    if (result.ok) showToast(result.message || '已放行防火墙');
    else showToast(result.error || '未能添加规则', true);
  } catch (error) {
    showToast(`操作失败：${error.message}`, true);
  } finally {
    ui.firewallBtn.disabled = false;
    ui.firewallBtn.textContent = original;
  }
}

function appendLog(entry, force = false) {
  if (!entry) return;
  if (!force && !state.logsReady) return;
  const line = document.createElement('div');
  line.className = `log-line ${entry.level || 'info'}`;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(entry.time || Date.now()).toLocaleTimeString('zh-CN', {
    hour12: false,
  });
  const message = document.createElement('span');
  message.className = 'log-msg';
  message.textContent = entry.message;
  line.append(time, message);
  ui.logList.appendChild(line);
  while (ui.logList.childElementCount > 300) {
    ui.logList.firstElementChild.remove();
  }
  ui.logList.scrollTop = ui.logList.scrollHeight;
}

function showToast(message, isError = false) {
  if (state.toastTimer) clearTimeout(state.toastTimer);
  ui.toast.textContent = message;
  ui.toast.className = `toast${isError ? ' error' : ''}`;
  ui.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
    state.toastTimer = null;
  }, 4200);
}

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return state.volume;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function formatTime(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

init();

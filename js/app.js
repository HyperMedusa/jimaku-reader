// app.js — UI ⇔ エンジン ⇔ ソース取得の結線
import { loadSource } from './sources.js';
import { chunkText, createPlayer } from './engine.js';

const $ = (id) => document.getElementById(id);

const homeScreen = $('home-screen');
const playerScreen = $('player-screen');
const subtitleArea = $('subtitle-area');
const subtitle = $('subtitle');
const subtitleFill = $('subtitle-fill');
const progressFill = $('progress-fill');
const chunkCounter = $('chunk-counter');
const btnPlay = $('btn-play');
const toast = $('toast');
const loading = $('loading');

const FONT_MAP = {
  ud: "'BIZ UDPGothic', sans-serif",
  rounded: "'M PLUS Rounded 1c', sans-serif",
  serif: "'Hiragino Mincho ProN', 'Yu Mincho', serif",
  system: "system-ui, sans-serif",
};

// ---------------------------------------------------------------
// 設定（localStorageに保存）
// ---------------------------------------------------------------
const settings = Object.assign(
  { speed: 1, fontSize: 36, font: 'ud' },
  JSON.parse(localStorage.getItem('jimaku-settings') || '{}')
);

function applySettings() {
  document.documentElement.style.setProperty('--subtitle-size', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--reading-font', FONT_MAP[settings.font] || FONT_MAP.ud);
  for (const [speedId, sizeId] of [['setting-speed', 'setting-fontsize'], ['player-speed', 'player-fontsize']]) {
    $(speedId).value = settings.speed;
    $(sizeId).value = settings.fontSize;
  }
  $('speed-value').textContent = settings.speed + '×';
  $('fontsize-value').textContent = settings.fontSize + 'px';
  $('setting-font').value = settings.font;
  player.setSpeed(settings.speed);
  localStorage.setItem('jimaku-settings', JSON.stringify(settings));
}

// ---------------------------------------------------------------
// プレイヤー
// ---------------------------------------------------------------
let currentText = '';   // 読み込み中のソース全文
let chunkOffsets = [];  // 各チャンクの累積文字オフセット（文字サイズ変更時の位置復元用）
let currentIndex = 0;
let currentCount = 0;

const player = createPlayer({
  onChunk(i, text, count) {
    currentIndex = i;
    currentCount = count;
    subtitle.textContent = text;
    subtitleFill.textContent = text;
    chunkCounter.textContent = `${i + 1} / ${count}`;
  },
  onTick(p) {
    subtitleFill.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
    if (currentCount) {
      progressFill.style.width = ((currentIndex + p) / currentCount) * 100 + '%';
    }
  },
  onStateChange(playing) {
    btnPlay.textContent = playing ? '⏸' : '▶';
  },
  onEnd() {
    showToast('読み終わりました 🎉');
  },
});

function computeCharsPerLine() {
  const areaStyle = getComputedStyle(subtitleArea);
  const subStyle = getComputedStyle(subtitle);
  const width =
    subtitleArea.clientWidth -
    parseFloat(areaStyle.paddingLeft) - parseFloat(areaStyle.paddingRight) -
    parseFloat(subStyle.paddingLeft) - parseFloat(subStyle.paddingRight);
  // モバイルではCSSが字幕フォントを縮小するため、実際の描画サイズで計算する
  const fontSize = parseFloat(subStyle.fontSize) || settings.fontSize;
  return Math.max(8, Math.min(40, Math.floor(width / fontSize)));
}

function buildChunks(text) {
  const chunks = chunkText(text, { charsPerLine: computeCharsPerLine(), maxLines: 2 });
  chunkOffsets = [];
  let offset = 0;
  for (const c of chunks) {
    chunkOffsets.push(offset);
    offset += c.length;
  }
  return chunks;
}

function startReading(source) {
  if (!source.text || !source.text.trim()) {
    showToast('文章が空のようです');
    return;
  }
  currentText = source.text;
  homeScreen.hidden = true;
  playerScreen.hidden = false;
  const chunks = buildChunks(currentText);
  if (!chunks.length) {
    exitPlayer();
    showToast('表示できる文章が見つかりませんでした');
    return;
  }
  player.load(chunks);
  player.play();
}

// 文字サイズ変更・画面リサイズ時: 今の読み位置を保ったまま再分割
function rechunkPreservingPosition() {
  if (playerScreen.hidden || !currentText) return;
  const wasPlaying = player.state.playing;
  const offset = chunkOffsets[player.state.index] ?? 0;
  player.pause();
  const chunks = buildChunks(currentText);
  let idx = 0;
  for (let i = 0; i < chunkOffsets.length; i++) {
    if (chunkOffsets[i] <= offset) idx = i;
    else break;
  }
  player.load(chunks, idx);
  if (wasPlaying) player.play();
}

function exitPlayer() {
  player.pause();
  playerScreen.hidden = true;
  homeScreen.hidden = false;
}

// ---------------------------------------------------------------
// 通知・ローディング
// ---------------------------------------------------------------
let toastTimer = 0;
function showToast(message, ms = 3500) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

async function withLoading(fn) {
  loading.hidden = false;
  try {
    return await fn();
  } finally {
    loading.hidden = true;
  }
}

// ---------------------------------------------------------------
// 入力ソースのハンドラ
// ---------------------------------------------------------------
async function loadAndStart(input) {
  try {
    const source = await withLoading(() => loadSource(input));
    startReading(source);
  } catch (err) {
    showToast(err.message || '読み込みに失敗しました');
  }
}

function handleFile(file) {
  if (!file) return;
  loadAndStart({ type: 'file', value: file });
}

$('btn-start').addEventListener('click', () => {
  const text = $('input-text').value.trim();
  const url = $('input-url').value.trim();
  if (text) loadAndStart({ type: 'text', value: text });
  else if (url) loadAndStart({ type: 'url', value: url });
  else showToast('文章を貼り付けるか、URLを入力してください');
});

$('btn-load-url').addEventListener('click', () => {
  const url = $('input-url').value.trim();
  if (!url) return showToast('URLを入力してください');
  loadAndStart({ type: 'url', value: url });
});

$('input-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-load-url').click();
});

$('input-file').addEventListener('change', (e) => handleFile(e.target.files[0]));

const dropZone = $('drop-zone');
['dragover', 'dragenter'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
  })
);
dropZone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

// ---------------------------------------------------------------
// プレイヤーの操作
// ---------------------------------------------------------------
$('btn-play').addEventListener('click', () => player.toggle());
$('btn-prev').addEventListener('click', () => player.prev());
$('btn-next').addEventListener('click', () => player.next());
$('btn-exit').addEventListener('click', exitPlayer);

$('progress-bar').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const { count } = player.state;
  if (count) player.seekTo(Math.min(count - 1, Math.floor(ratio * count)));
});

document.addEventListener('keydown', (e) => {
  if (playerScreen.hidden) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === ' ') {
    e.preventDefault();
    player.toggle();
  } else if (e.key === 'ArrowLeft') player.prev();
  else if (e.key === 'ArrowRight') player.next();
  else if (e.key === 'Escape') exitPlayer();
});

// ---------------------------------------------------------------
// 設定の変更イベント
// ---------------------------------------------------------------
function bindSetting(id, key, parse, after) {
  $(id).addEventListener('input', (e) => {
    settings[key] = parse(e.target.value);
    applySettings();
    after?.();
  });
}
bindSetting('setting-speed', 'speed', Number);
bindSetting('player-speed', 'speed', Number);
bindSetting('setting-fontsize', 'fontSize', Number, rechunkPreservingPosition);
bindSetting('player-fontsize', 'fontSize', Number, rechunkPreservingPosition);
bindSetting('setting-font', 'font', String);

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rechunkPreservingPosition, 300);
});

applySettings();

// engine.js — 文章のチャンク分割 + 字幕再生エンジン
// 日本語/英語混在テキストを「2行に収まる字幕」単位に分割し、
// 文字量ベースの表示時間で自動送りする。

// ---------------------------------------------------------------
// 文字幅の見積もり: CJK(全角)=1、半角文字=0.55 として行内文字数を数える
// ---------------------------------------------------------------
const CJK_RE = /[　-〿぀-ヿ㐀-鿿豈-﫿＀-｠￠-￦]/;

function textWeight(s) {
  let w = 0;
  for (const ch of s) w += CJK_RE.test(ch) ? 1 : 0.55;
  return w;
}

// ---------------------------------------------------------------
// 文分割（Intl.Segmenter）。非対応ブラウザでは句点ベースのフォールバック
// ---------------------------------------------------------------
function splitSentences(paragraph) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('ja', { granularity: 'sentence' });
    return [...seg.segment(paragraph)].map((s) => s.segment.trim()).filter(Boolean);
  }
  return paragraph
    .split(/(?<=[。．！？!?]["」』）)]?)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 長すぎる一文を、読点・記号・スペースの位置で budget 以下の断片に割る
function splitLongSentence(sentence, budget) {
  // 第1候補: 読点・中点・セミコロン等の直後で区切る
  const parts = sentence.split(/(?<=[、，,;；：:・…―—])/).filter(Boolean);
  const pieces = [];
  let buf = '';
  for (const part of parts) {
    if (buf && textWeight(buf) + textWeight(part) > budget) {
      pieces.push(buf);
      buf = part;
    } else {
      buf += part;
    }
  }
  if (buf) pieces.push(buf);

  // まだ budget を超える断片は単語境界（なければ強制スライス）で割る
  const result = [];
  for (const piece of pieces) {
    if (textWeight(piece) <= budget) {
      result.push(piece);
      continue;
    }
    result.push(...splitByWords(piece, budget));
  }
  return result;
}

function splitByWords(text, budget) {
  let words;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('ja', { granularity: 'word' });
    words = [...seg.segment(text)].map((s) => s.segment);
  } else {
    words = text.split('');
  }
  const out = [];
  let buf = '';
  for (const w of words) {
    if (buf && textWeight(buf) + textWeight(w) > budget) {
      out.push(buf);
      buf = w;
    } else {
      buf += w;
    }
  }
  if (buf) out.push(buf);
  // 単語1つで budget 超え（異常に長い連続文字列）は強制スライス
  return out.flatMap((p) => {
    if (textWeight(p) <= budget) return [p];
    const sliced = [];
    let s = '';
    for (const ch of p) {
      if (textWeight(s + ch) > budget) {
        sliced.push(s);
        s = ch;
      } else s += ch;
    }
    if (s) sliced.push(s);
    return sliced;
  });
}

// ---------------------------------------------------------------
// チャンク分割（公開API）
// text → 「最大 maxLines 行に収まる字幕テキスト」の配列
// ---------------------------------------------------------------
export function chunkText(text, { charsPerLine, maxLines = 2 }) {
  // 2行ぴったりだと折り返し誤差ではみ出すため 9割で見積もる
  const budget = Math.max(8, charsPerLine * maxLines * 0.9);
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);

  const chunks = [];
  for (const para of paragraphs) {
    const sentences = splitSentences(para).flatMap((s) =>
      textWeight(s) > budget ? splitLongSentence(s, budget) : [s]
    );
    // 短い文は budget まで貪欲に詰める（段落はまたがない）
    let buf = '';
    for (const s of sentences) {
      if (buf && textWeight(buf) + textWeight(s) > budget) {
        chunks.push(buf);
        buf = s;
      } else {
        buf = buf ? buf + s : s;
      }
    }
    if (buf) chunks.push(buf);
  }
  return chunks.map((c) => c.trim()).filter(Boolean);
}

// ---------------------------------------------------------------
// 再生エンジン（公開API）
// 文字量に応じた表示時間で自動送り。onTick はカラオケ塗り用の進捗0..1
// ---------------------------------------------------------------
const MS_PER_CHAR = 95; // 速度1.0のとき: 全角1文字あたり95ms（約10.5文字/秒）
const MIN_MS = 1400;
const MAX_MS = 9000;

export function createPlayer({ onChunk, onTick, onStateChange, onEnd }) {
  let chunks = [];
  let index = 0;
  let speed = 1;
  let playing = false;
  let raf = 0;
  let chunkStart = 0;     // 現チャンクの再生開始時刻（performance.now基準）
  let pausedElapsed = 0;  // 一時停止時点の経過ms
  let duration = 1;       // 現チャンクの表示時間（速度反映済み）

  function baseDuration(text) {
    return Math.min(MAX_MS, Math.max(MIN_MS, textWeight(text) * MS_PER_CHAR));
  }

  function showChunk(i) {
    index = Math.max(0, Math.min(i, chunks.length - 1));
    duration = baseDuration(chunks[index]) / speed;
    chunkStart = performance.now();
    pausedElapsed = 0;
    onChunk?.(index, chunks[index], chunks.length);
    onTick?.(0);
  }

  function loop(now) {
    if (!playing) return;
    const progress = Math.min(1, (now - chunkStart) / duration);
    onTick?.(progress);
    if (progress >= 1) {
      if (index < chunks.length - 1) {
        showChunk(index + 1);
      } else {
        playing = false;
        onStateChange?.(false);
        onEnd?.();
        return;
      }
    }
    raf = requestAnimationFrame(loop);
  }

  const player = {
    load(newChunks, startIndex = 0) {
      this.pause();
      chunks = newChunks;
      showChunk(startIndex);
    },
    play() {
      if (playing || !chunks.length) return;
      playing = true;
      chunkStart = performance.now() - pausedElapsed;
      onStateChange?.(true);
      raf = requestAnimationFrame(loop);
    },
    pause() {
      if (!playing) return;
      playing = false;
      cancelAnimationFrame(raf);
      pausedElapsed = performance.now() - chunkStart;
      onStateChange?.(false);
    },
    toggle() {
      playing ? this.pause() : this.play();
    },
    next() {
      if (index < chunks.length - 1) {
        showChunk(index + 1);
        if (!playing) onTick?.(0);
      }
    },
    prev() {
      // 再生から1秒以上経っていたら同チャンクの頭に戻る（音楽プレイヤー流儀）
      const elapsed = playing ? performance.now() - chunkStart : pausedElapsed;
      if (elapsed > 1000 || index === 0) showChunk(index);
      else showChunk(index - 1);
    },
    seekTo(i) {
      if (!chunks.length) return;
      showChunk(i);
    },
    setSpeed(x) {
      // チャンク内の進捗率を保ったまま速度を切り替える
      const progress = duration
        ? Math.min(1, (playing ? performance.now() - chunkStart : pausedElapsed) / duration)
        : 0;
      speed = x;
      duration = baseDuration(chunks[index] ?? '') / speed;
      if (playing) chunkStart = performance.now() - progress * duration;
      else pausedElapsed = progress * duration;
    },
    get state() {
      return { index, count: chunks.length, playing, speed };
    },
  };
  return player;
}

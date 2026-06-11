// js/sources.js
// テキスト/URL/ファイルから本文を抽出するデータ取得モジュール。
// 依存なしのバニラJS・ブラウザESモジュール。export は loadSource のみ。

/**
 * 入力ソースを読み込んで { title, text } を返す。
 * @param {{ type: 'text'|'url'|'file', value: string|File }} input
 * @returns {Promise<{ title: string, text: string }>}
 */
export async function loadSource(input) {
  const { type, value } = input || {};

  let result;
  switch (type) {
    case 'text':
      result = loadText(value);
      break;
    case 'url':
      result = await loadUrl(value);
      break;
    case 'file':
      result = await loadFile(value);
      break;
    default:
      throw new Error('対応していない入力です。');
  }

  // 共通正規化（本文の改行・空白を整える）
  const text = normalizeText(result.text);
  // titleが空なら本文先頭30文字をtitleにする
  const title = (result.title && result.title.trim()) || makeTitleFromText(text);
  return { title, text };
}

// ---------------------------------------------------------------------------
// type: 'text'
// ---------------------------------------------------------------------------

/** プレーンテキストをそのまま本文に。titleは先頭行（30文字まで）。 */
function loadText(value) {
  const text = String(value == null ? '' : value);
  const firstLine = text.split('\n').find((l) => l.trim()) || '';
  return { title: truncate(firstLine.trim(), 30), text };
}

// ---------------------------------------------------------------------------
// type: 'url'
// ---------------------------------------------------------------------------

/** URL判定（Xポスト→fxtwitter、その他→Jina Reader）。 */
async function loadUrl(value) {
  const url = String(value == null ? '' : value).trim();
  if (!url) throw new Error('URLが入力されていません。');

  const status = parseTwitterStatus(url);
  if (status) {
    return await loadTwitter(status.user, status.id);
  }
  return await loadViaJina(url);
}

/**
 * x.com / twitter.com / fxtwitter.com / vxtwitter.com の
 * /{user}/status/{id} を解析。該当しなければ null。
 */
function parseTwitterStatus(url) {
  const re = /^https?:\/\/(?:www\.)?(?:x|twitter|fxtwitter|vxtwitter)\.com\/([^/]+)\/status\/(\d+)/i;
  const m = url.match(re);
  if (!m) return null;
  return { user: m[1], id: m[2] };
}

/** fxtwitter APIからポスト本文を取得（スレッドがあれば連結）。 */
async function loadTwitter(user, id) {
  const api = `https://api.fxtwitter.com/${encodeURIComponent(user)}/status/${id}`;
  let json;
  try {
    const res = await fetchWithTimeout(api);
    if (!res.ok) throw new Error('non-ok');
    json = await res.json();
  } catch (e) {
    throw new Error('このポストは取得できませんでした。本文をコピーして貼り付けてください。');
  }

  if (!json || json.code !== 200 || !json.tweet) {
    throw new Error('このポストは取得できませんでした。本文をコピーして貼り付けてください。');
  }

  const tweet = json.tweet;
  let parts;
  // スレッドがあれば各要素の .text を連結、無ければ本ポストのtext
  if (Array.isArray(tweet.thread) && tweet.thread.length) {
    parts = tweet.thread.map((t) => (t && t.text) || '').filter(Boolean);
  } else {
    parts = [tweet.text || ''];
  }

  const text = parts.join('\n\n');
  const title = (tweet.author && tweet.author.name) || '';
  return { title, text };
}

/** Jina Readerで任意ページをmarkdown取得し、プレーンテキスト化する。 */
async function loadViaJina(url) {
  const api = 'https://r.jina.ai/' + url; // 元URLをそのまま付与
  let raw;
  try {
    const res = await fetchWithTimeout(api);
    if (!res.ok) throw new Error('non-ok');
    raw = await res.text();
  } catch (e) {
    throw new Error('このページは取得できませんでした。本文をコピーして貼り付けてください。');
  }

  // ヘッダ行（Title: / Markdown Content:）を解析
  const lines = raw.split('\n');
  let title = '';
  let bodyStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tm = line.match(/^Title:\s*(.*)$/);
    if (tm && !title) title = tm[1].trim();
    if (/^Markdown Content:\s*$/.test(line)) {
      bodyStart = i + 1;
      break;
    }
  }

  // Markdown Content: が無ければ全体を本文扱い
  const bodyMd = bodyStart >= 0 ? lines.slice(bodyStart).join('\n') : raw;
  const text = stripMarkdown(bodyMd);
  return { title, text };
}

// ---------------------------------------------------------------------------
// type: 'file'
// ---------------------------------------------------------------------------

/** ファイル拡張子で分岐して本文抽出。 */
async function loadFile(file) {
  if (!file || typeof file.name !== 'string') {
    throw new Error('ファイルを読み込めませんでした。');
  }
  const name = file.name;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const baseName = name.replace(/\.[^.]+$/, '');

  if (ext === 'txt') {
    const text = await file.text();
    return { title: '', text };
  }
  if (ext === 'md') {
    const raw = await file.text();
    const noFront = stripFrontmatter(raw);
    const title = firstHeading(noFront) || baseName;
    const text = stripMarkdown(noFront);
    return { title, text };
  }
  if (ext === 'pdf') {
    const text = await extractPdf(file);
    return { title: baseName, text };
  }

  throw new Error('対応していないファイル形式です（.txt / .md / .pdf に対応）。');
}

/** pdf.jsをCDNから動的importして全ページのテキストを抽出。 */
async function extractPdf(file) {
  let pdfjs;
  try {
    pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  } catch (e) {
    throw new Error('PDFの読み込み機能を準備できませんでした。');
  }

  let pdf;
  try {
    const data = await file.arrayBuffer();
    pdf = await pdfjs.getDocument({ data }).promise;
  } catch (e) {
    throw new Error('このPDFは読み込めませんでした。');
  }

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => (it && it.str) || '').join('');
    pages.push(pageText);
  }
  // ページ間は \n\n
  return pages.join('\n\n');
}

// ---------------------------------------------------------------------------
// markdown / テキスト処理ユーティリティ
// ---------------------------------------------------------------------------

/** 先頭の --- ... --- frontmatterを除去。 */
function stripFrontmatter(md) {
  return md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** 最初の見出し（# 〜）テキストを返す。 */
function firstHeading(md) {
  const m = md.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  return m ? m[1].trim() : '';
}

/** markdown記法を除去してプレーンテキスト化する。 */
function stripMarkdown(md) {
  let t = String(md == null ? '' : md);

  // ```フェンス行を除去（中身は本文として残す）
  t = t.replace(/^[ \t]*```.*$/gm, '');
  // HTMLタグ除去
  t = t.replace(/<[^>]+>/g, '');
  // 画像 ![alt](url) を除去
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // リンク [text](url) → text
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 見出し記号 #
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // 引用記号 >
  t = t.replace(/^\s{0,3}>+\s?/gm, '');
  // リスト記号 -, *, +, 1.
  t = t.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '');
  // 強調 **bold** / __bold__
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
  // 斜体 *italic* / _italic_
  t = t.replace(/(\*|_)(.*?)\1/g, '$2');
  // インラインコードのバッククォート除去
  t = t.replace(/`([^`]*)`/g, '$1');
  // 水平線
  t = t.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '');

  return t;
}

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

/** タイムアウト付きfetch（20秒、AbortController使用）。 */
async function fetchWithTimeout(url, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 改行・行末空白を正規化し、全体をtrim。 */
function normalizeText(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/\r\n?/g, '\n'); // CRLF/CR → LF
  t = t.replace(/[ \t]+$/gm, ''); // 行末空白除去
  t = t.replace(/\n{3,}/g, '\n\n'); // 3つ以上の連続改行 → \n\n
  return t.trim();
}

/** 本文先頭からtitleを生成（30文字まで）。 */
function makeTitleFromText(text) {
  const firstLine = String(text).split('\n').find((l) => l.trim()) || '';
  return truncate(firstLine.trim(), 30);
}

/** 文字列を最大n文字に丸める。 */
function truncate(str, n) {
  const s = String(str == null ? '' : str);
  return s.length > n ? s.slice(0, n) : s;
}

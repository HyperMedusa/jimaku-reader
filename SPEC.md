# 字幕リーダー (Jimaku Reader) — 設計書

文章を「映画字幕／カラオケ」のように2行ずつ自動表示して、視覚的に読めるWebアプリ。
ビルド不要の静的サイト（index.html + styles.css + js/）。モダンブラウザ前提（Intl.Segmenter使用）。

## ファイル構成と担当

| ファイル | 役割 | 担当 |
|---|---|---|
| `index.html` | 画面構造（ホーム画面+プレイヤー画面） | Agent A |
| `styles.css` | 全スタイル | Agent A |
| `js/sources.js` | URL/Xポスト/ファイルからテキスト抽出 | Agent B |
| `js/engine.js` | 文章分割（チャンク化）+ 再生エンジン | メイン(Fable) |
| `js/app.js` | UI⇔エンジン⇔ソースの結線 | メイン(Fable) |

`index.html` は `<script type="module" src="js/app.js">` のみ読み込む（app.jsが他をimport）。

## 画面1: ホーム（#home-screen）

- アプリ名「字幕リーダー」+ 一言説明
- 入力方法3つ（タブまたは縦並びカード）:
  1. **テキスト貼り付け**: `<textarea id="input-text">`（プレースホルダ「ここに文章を貼り付け」）
  2. **URL**: `<input type="url" id="input-url">` + 読み込みボタン `<button id="btn-load-url">`。補足文「X(Twitter)のポストURLもOK」
  3. **ファイル**: `<input type="file" id="input-file" accept=".txt,.md,.pdf">` を包むドロップゾーン `<div id="drop-zone">`（ドラッグ&ドロップ対応はapp.js側で実装）
- 設定パネル:
  - 速度: `<input type="range" id="setting-speed" min="0.5" max="3" step="0.25" value="1">` + 現在値表示 `<span id="speed-value">`
  - 文字サイズ: `<input type="range" id="setting-fontsize" min="20" max="64" step="2" value="36">` + `<span id="fontsize-value">`
  - フォント: `<select id="setting-font">` 選択肢: `BIZ UDPGothic`(デフォルト・UD=ユニバーサルデザインフォント) / `M PLUS Rounded 1c` / `serif(明朝)` / `system`
- 開始ボタン: `<button id="btn-start">▶ 読む</button>`（大きく目立つ）
- エラー/通知トースト: `<div id="toast" hidden>`
- ローディング表示: `<div id="loading" hidden>`（URL取得中に表示）

## 画面2: プレイヤー（#player-screen、初期 `hidden`）

映画字幕風のフルスクリーン。ダーク背景、中央に字幕。

- 字幕エリア: `<div id="subtitle-area">` 内に
  - `<div id="subtitle">`（ベース文字、薄い色）
  - `<div id="subtitle-fill">`（同じテキスト、明るい色、`#subtitle`に完全重ね、カラオケ式に左から`clip-path: inset(0 X% 0 0)`で塗られていく。重ね合わせとクリップはCSSで用意、X%の更新はapp.js）
  - 最大2行表示。`line-height: 1.9` 程度でゆったり
- 下部コントロールバー（ホバー/タップで表示でも常時でも可）:
  - `<button id="btn-prev">⏮</button>` `<button id="btn-play">⏸/▶</button>` `<button id="btn-next">⏭</button>`
  - 進捗バー: `<div id="progress-bar"><div id="progress-fill"></div></div>`（クリックでシーク、処理はapp.js）
  - チャンク番号: `<span id="chunk-counter">3 / 42</span>`
  - 速度・文字サイズの調整（ホームと同じrange、id: `player-speed`, `player-fontsize`）
  - 終了: `<button id="btn-exit">✕</button>`（ホームに戻る）
- キーボード: Space=再生/停止, ←→=前後（app.jsで実装）

## デザイン方針

- 読みやすさ最優先（ユーザーは文字を読むのが苦手）: UDフォント、高コントラスト、ゆったり行間、視線移動が少ない中央固定表示
- ダークテーマ基調（#0d0d12系の背景 + 字幕は白〜暖白、fill色はアクセント1色（例: #ffd866 か シアン系））
- Google Fonts: `BIZ UDPGothic` と `M PLUS Rounded 1c` を `<link>` で読み込み
- スマホ対応（レスポンシブ、コントロールはタップしやすいサイズ）

## js/sources.js のAPI（Agent B）

```js
// 唯一のexport
export async function loadSource(input) // → Promise<{ title: string, text: string }>
// input: { type: 'text'|'url'|'file', value: string|File }
```

- `text`: そのまま返す（title は先頭行から生成）
- `url`:
  - `x.com` / `twitter.com` の `/status/` URL → `https://api.fxtwitter.com/{user}/status/{id}` をfetchしてJSONから本文（スレッドがあれば連結）
  - その他のURL → `https://r.jina.ai/{元URL}` をfetch（text/plainのmarkdownが返る。CORS可）
  - 失敗時は分かりやすい日本語Errorをthrow（例:「このページは取得できませんでした。本文をコピーして貼り付けてください」）
- `file`:
  - `.txt` → そのまま
  - `.md` → markdown記法を除去してプレーンテキスト化（見出し記号#、リンク[x](y)→x、画像除去、強調記号除去、コードブロックはそのまま本文扱い、frontmatter除去）
  - `.pdf` → pdf.js をCDNから動的import（`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.x` のESM版）でテキスト抽出
- 返すtextは段落を `\n\n` 区切りに正規化したプレーンテキスト

## js/engine.js のAPI（メイン実装・参考）

```js
export function chunkText(text, { charsPerLine, maxLines = 2 }) // → string[]
export function createPlayer({ onChunk, onTick, onStateChange, onEnd })
// player.load(chunks), play(), pause(), toggle(), next(), prev(), seekTo(i), setSpeed(x)
// onChunk(index, text), onTick(progress01)（チャンク内進捗、カラオケ塗り用）, onEnd()
```

- 文分割は `Intl.Segmenter('ja', { granularity: 'sentence' })`
- 表示時間 = 文字数ベース（約95ms/文字、min 1.2s / max 8s）÷ 速度倍率

# kanji-esperanto-monaco

Monaco Editor を使った「漢字化エスペラント」入力サイト。URL 一発で `bon` → 「良」の入力体験を提供します。大辞書は分割・遅延読み込み対応。

## 使い方（ローカル）
1. このフォルダを静的ホスティングで配信するか、簡易サーバで開きます。
   - 例: `python3 -m http.server -d kanji-esperanto-monaco 5173`
   - 例: `npx serve kanji-esperanto-monaco`
2. ブラウザで `http://localhost:5173/` を開く（初回から決定的にするには `?strict=1` を付与: `http://localhost:5173/?strict=1`）。
3. エディタに `bon` と入力 → 候補「良」が表示。Enter で確定。
4. `割当検索` を開き、`割当漢字` 欄に `良` などを入力すると、その漢字を割り当てられている語根を検索できます。

## フォルダ構成
```
kanji-esperanto-monaco/
├─ index.html       # 画面と Monaco ローダ
├─ app.js           # 言語登録・補完・キーバインド
├─ ke-snippets.js   # 旧来の小規模辞書サンプル（通常は未使用）
├─ data/            # 大辞書用の分割 JSON（任意）
└─ tools/           # 大辞書を分割する補助スクリプト
```

## 漢字割当 TSV からの取り込み
割当の正典ディレクトリ `漢字化・語彙資料/エスペラント語根＿漢字割り当て＿20260621`（旧 `PEJVO・PIV語根分解資料_20260613` の後継・現行の正）の `_identifier_sidecar.tsv` を、Monaco 補完用の `all.json` に変換できます。`漢字割当一覧_識別子付きプレビュー` 形式の TSV も同じツールで取り込めます。

```
node tools/kanji-assignments-tsv-to-all.mjs "/path/to/_identifier_sidecar.tsv" ./all.json
node tools/merge-homonym-alt.mjs ./all.json ./data/homonym-alt.tsv ./all.json
node tools/merge-inline-tokens.mjs ./all.json ./data/inline-tokens.tsv ./all.json
node tools/split-dictionary.mjs ./all.json ./data
node tools/generate-reverse-index.mjs ./all.json ./data/reverse.json
node tools/check-dictionary-assets.mjs ./all.json ./data
node tools/check-versions.mjs
```

- `check-dictionary-assets.mjs` は、分割バケットと逆引きインデックスの**内容**が `all.json` と一致するか検証します。
- `check-versions.mjs` は、`sw.js` / `app.js` / `index.html` のバージョン文字列が食い違っていないか検証します（辞書更新時の手動バンプ漏れ対策）。
- これら2つのチェックは GitHub Actions（`.github/workflows/pages.yml` の `verify` ジョブ）で push / PR 時に自動実行され、不一致ならデプロイを止めます。
- `ĉ`, `ĝ`, `ŝ`, `ŭ` と `c^`, `g^`, `s^`, `u^` などは、入力用に `cx`, `gx`, `sx`, `ux` へ正規化します。
- 同一語根に複数候補がある場合は、`priority` の小さい順に候補表示します。
- `data/homonym-alt.tsv` は、**1つの綴りが複数の意味を持ち別々の漢字が当たっている**ケースを第2候補以降として登録する副資料です。`_identifier_sidecar.tsv` は1語根1漢字しか持てないため、正典 `_homonym_disp.tsv` をそのまま複製して補います（更新は正典から再取得するだけ）:
  ```
  sed '1s/^\xEF\xBB\xBF//' _homonym_disp.tsv > data/homonym-alt.tsv
  ```
  3種類の行があり、いずれも `merge-homonym-alt.mjs` が `priority` 1 以降（基本義の後ろ）として `all.json` に合流させます。
  - `amb` — 綴りを共有する**全く別の語**。`plum` = 羽「羽根」/ 笔ᴾᴸ「ペン」、`mat` = 席「マット」/ 将ᴹ「チェス詰み」
  - `sep` — **特定の語の中でだけ**成り立つ語義。`krom` = 外「〜のほかに」だが `krom/o` などでは 金ᴷᴹ「クロム」
  - `comb` — 結合形。`-metr-` = 计ᴹ「計器」（`metr` 単独の 米 とは別）
  `sep`/`comb` は語スコープ付きなので、適用語を `detail`（例: `krom → 金ᴷᴹ (語限定 クロム(金属元素): krom/o, krom/at/o 他1語)`）と `documentation` の `適用語:` 行に明記し、選択は人に委ねます。逆変換は表示形が一意なので常に無損失で、範囲外で選んでも語の選び間違いにしかなりません。
- 取り込めない行はツールが理由付きで報告してスキップします（**語根が無い**=語中にしか現れない分節、**表示形の重複**=同じ形が複数行に載っている、**別語根の漢字と衝突**=採用すると逆変換が不可逆になる、**既に辞書にある**）。`check-dictionary-assets.mjs` は同じ分類器を読み込んで期待値を再計算し、`all.json` の中身と1件ずつ突き合わせます。**マージ工程を飛ばす・別義が欠ける・説明文や優先順位が食い違う、のいずれも CI が赤になります**。
- `data/inline-tokens.tsv` は、正典 `_inline_tokens.tsv` の複製です（更新は同じく再取得するだけ: `sed '1s/^\xEF\xBB\xBF//' _inline_tokens.tsv > data/inline-tokens.tsv`）。注入層が**行単位の文脈**で決める描画のため、語根表にも同綴異義台帳にも載らないトークンが対象で、放置すると漢字文に現れるのに逆引きできません（例: `庚/an/o`=ヘプタン）。
  - 採用するのは `merge-inline-tokens.mjs` の `ADOPTED_RULES` に挙げた規則だけで、現在は**アルキル語幹 `$alkylStem` のみ**（`but`→丁 / `pent`→戊 / `okt`→辛 / `hept`→庚 / `non`→壬 / `dek`→癸）。化学塩 `$chemSaltLine` と医学 `$medIt` は、綴りが分詞接尾 `-at-`/`-it-` と同じで入力頻度が桁違いに高いため**意図的に除外**しています（2026-07-27 ユーザー裁定）。正典が新しい規則を足しても既定は除外側なので、レビュー前に候補へ出てしまうことはありません。
  - 同綴異義と違い、**単独語根が無くても採用します**。正典自身が裸の分節を見出しとして描画しており（`hept/` → `庚/`）、入力単位として実在するためです（`hept` はこれまで候補ゼロでした）。
  - `merge-homonym-alt.mjs` はこのトークンを**素通しで温存しつつ、自分の優先順位の基準からは外します**。そうしないと「どちらを先に流したか」で全ての優先順位が変わってしまうためで、この2工程はどちらの順で何度流しても同じ結果へ収束します（順序を間違えた場合は CI が該当トークン名を挙げて止めます）。
  - 1字の `丁` を足しても既存の `丁香`（チョウジ/ライラック）は壊れません。逆変換は**長い表示形から順に**照合するためで、注入コーパス 52,230 語で旧版と突き合わせて退行 0・新たに復元可能 23 語を確認しています。
- `data/reverse.json` は、漢字ごとの割当語根検索に使う逆引きインデックスです。

## 大辞書（分割・遅延読込）
- `data/ke-a.json`, `data/ke-b.json`, ... に `{ meta, items: [{ prefix, body, detail? }] }` 形式で保存。
- `app.js` が先頭文字のバケツのみ `fetch()` し、キャッシュします。
- 辞書データは割当案IDつきのURLで読み込みます。更新後に古いPWAキャッシュへ当たり続ける事故を避けるためです。
- 1文字未満では補完を出さないため、体感を軽く保ちます（ローカル仕様に合わせて 1 文字から候補を出します）。

分割支援:
```
node tools/split-dictionary.mjs ./all.json ./data
node tools/check-dictionary-assets.mjs ./all.json ./data
```

`.ke.txt` からの変換（**非推奨・レガシー**）:
```
node tools/ke-txt-to-all.mjs /path/to/dictionary.ke.txt ./all.json
node tools/split-dictionary.mjs ./all.json ./data
```
> ⚠️ `ke-txt-to-all.mjs` は `{prefix, body, detail}` のみの縮退スキーマを出力し、`sourceRoot`/`priority`/`frequency` 等を持ちません。逆引き語根やランキングが壊れた辞書になるため、本番辞書は必ず `kanji-assignments-tsv-to-all.mjs` を使ってください（エディタ単体の簡易実験用途のみ）。

`all.json` 例:
```json
{ "items": [ { "prefix": "bon", "body": "良", "detail": "bon → 良" } ] }
```

## デプロイ手順
### GitHub Pages（簡単）
1. GitHub 上の `kanji-esperanto-monaco` リポに、このフォルダの中身を配置。
2. Settings → Pages → Source: `Deploy from a branch`、Branch: `main` を選び保存。
3. 公開 URL 例: `https://<user>.github.io/kanji-esperanto-monaco/`

Actions による自動デプロイ（同梱）:
- `.github/workflows/pages.yml` を同梱しています。`main` に push すると自動で Pages に公開されます。

### Vercel / Cloudflare Pages（CDN）
- リポを import → Build Command/Output Directory は空欄（静的サイト）。
- 即時デプロイ＋カスタムドメインも簡単です。

## 仕様のポイント
- Monaco worker は data URL で自己完結（CDN 依存、サーバ側設定不要）
- `wordPattern` は ASCII 語根と CJK(々/〻) の語境界を想定
- 通常入力（a-z）でも候補を自動表示＋Backspace/Delete 後に候補を自動再表示、Ctrl+Space で強制表示
- `割当検索` パネルの `割当漢字` 欄で、漢字に割り当てられている語根を一覧できます。
- `漢字割当案` セレクトは複数の割当案を切り替えるための土台です。1案だけの間は画面上では隠し、2案以上に増えた時だけ表示します。
- 辞書バケットが読めない場合、旧小規模辞書へ黙って落とさず、画面上に読み込み失敗を通知します。
- 大辞書は 1 文字バケツで遅延読込（更に大規模なら 2 文字バケツや Trie を検討）

## PWA（オフライン対応）
- ルートに `manifest.webmanifest` と `sw.js` を追加。`index.html` で登録しています。
- 初回アクセス時に以下を事前キャッシュします。
  - ルート: `index.html`, `app.js`, `data/ke-*.json`, `data/reverse.json`, `manifest.webmanifest`
  - Monaco の最小依存（CDN の `loader.js` / `workerMain.js`）
  - 注意: Monaco エディタ本体（`editor.main.*`）は CDN から**実行時に**読み込み、初回のオンライン読込時にのみキャッシュされます。そのため**完全オフラインで動作するのは一度オンラインで開いた後**です。初回アクセスがオフライン、または CDN（unpkg）に到達できない場合は、エディタ領域に読み込み失敗メッセージを表示します。
  - （`all.json` はビルド用成果物で実行時には読み込まないため、プリキャッシュ対象から除外しています。）
- `app.js` と辞書データは別々のバージョンでキャッシュします。UIだけの修正と辞書更新を分けて扱うためです。
- 注意: PWAのスコープは GitHub Pages の公開パス（例: `/kanji-esperanto-monaco/`）。`manifest.webmanifest` の `start_url`/`scope` はそれに合わせています。

## ローカル保存と履歴
- 入力内容は自動で `localStorage` に保存・復元されます（キー: `ke-doc-v1`）。
- 簡易履歴（最大50スナップショット）を保持します（キー: `ke-doc-hist-v1`）。
- 便利アクション:
  - `Ctrl+Alt+R` … 最後のスナップショットを復元
  - `Ctrl+Alt+Backspace` … ローカル保存と履歴を削除

## ライセンス
- Monaco Editor: MIT（© Microsoft）
- 本テンプレート: MIT
- 辞書データの著作権/ライセンスは同梱ファイルや README に明記してください（例: CC BY-SA）。

# テスト

Playwright で実際のブラウザを動かし、アプリの主要な流れを確認します。
Firebase には接続せず、`stubs/` のインメモリ実装に差し替えて動かすため、
ネットワークもFirebaseプロジェクトも不要です。

## 実行方法

```bash
npm install --no-save playwright
npx playwright install chromium

node test/verify-smoke.mjs
node test/verify-edit-modal.mjs
```

全部まとめて:

```bash
for f in test/verify-*.mjs; do echo "== $f"; node "$f" | tail -1; done
```

Chromium を自分で用意している場合は `CHROMIUM_PATH` で指定できます:

```bash
CHROMIUM_PATH=/path/to/chromium node test/verify-smoke.mjs
```

スクリーンショットの出力先は `TEST_OUT_DIR` で変えられます (既定は `test/`)。

## 各ファイル

| ファイル | 確認する内容 |
|---|---|
| `verify-smoke.mjs` | 収入・支出・貯蓄の追加、サマリーの集計、予算フォーム、立替金の精算、削除、絞り込み、並び替え |
| `verify-edit-modal.mjs` | 記録の編集ポップアップ (スクロールしない・一覧がずれない・4通りの閉じ方でフォームが元に戻る・給与明細の内訳・ログアウト時の後始末) |

## stubs について

`stubs/` は Firebase SDK の極小の代替実装です。`gstatic.com` からの
SDK 読み込みをテスト側で横取りして差し替えています。
本物と挙動が違うと**テストだけ通って実際には壊れている**状態になるため、
`setDoc(merge:true)` と `arrayUnion` の組み合わせなど、アプリが実際に使う
書き方は本物に合わせてあります。

`window.__seedDoc(path, data)` で、UI 経由では作れないデータ
(登録日を持たない古い記録など) を直接仕込めます。

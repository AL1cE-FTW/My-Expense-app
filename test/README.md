# テスト

Playwright で実際のブラウザを動かし、アプリの主要な流れを確認します。
Firebase には接続せず、`stubs/` のインメモリ実装に差し替えて動かすため、
ネットワークもFirebaseプロジェクトも不要です。

## 実行方法

```bash
npm install --no-save playwright
npx playwright install chromium

sh test/run-all.sh
```

1本だけ動かしたいとき:

```bash
node test/verify-smoke.mjs
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
| `verify-edit-modal.mjs` | 記録の編集ポップアップ (スクロールしない・一覧がずれない・背景が動かない・閉じたら位置が戻る・4通りの閉じ方・給与明細の内訳・ログアウト時の後始末) |
| `verify-aggregation.mjs` | サマリー、Need/Want/Save、累計貯金額、予算バーと「予算外」、収入目標と賞与、年間表示の経過月数按分 (未来年・過去年を含む)、月別の収支推移グラフ |
| `verify-csv.mjs` | 3形式の取り込み (縦持ち・横持ち・カード利用履歴)、カテゴリの読み替えと告知、重複スキップ、Shift_JIS の読み直し、店名からのカテゴリ推測、合計の検算 |
| `verify-gmail.mjs` | メールからの読み込み (認証失敗からの復帰、1通に複数明細、ID履歴が消えないこと、内容ベースの重複チェック) |
| `verify-payslip.mjs` | 給与・賞与の内訳入力と手取りの自動計算、収入は手取りのみ計上、内訳ポップアップ、編集時の復元、クリア |
| `verify-a11y.mjs` | キーボードだけでの操作 (種別のラジオ、CSVインポート、並び替え見出し、モーダルのフォーカストラップと復帰)、読み上げ向けの名前と状態 |
| `verify-screens.mjs` | 起動時の各画面 (SDK読み込み失敗・未セットアップ)、サイドバーとスクロール追従、日付での絞り込みと自動移動、スマホ幅のレイアウト |
| `verify-sort-filter.mjs` | 各列での並び替え、登録日が未設定の記録の扱い、種別に連動するカテゴリ絞り込み、CSVエクスポート (BOM・列構成・生の数値) |

## stubs について

`stubs/` は Firebase SDK の極小の代替実装です。`gstatic.com` からの
SDK 読み込みをテスト側で横取りして差し替えています。
本物と挙動が違うと**テストだけ通って実際には壊れている**状態になるため、
`setDoc(merge:true)` と `arrayUnion` の組み合わせなど、アプリが実際に使う
書き方は本物に合わせてあります。

`window.__seedDoc(path, data)` で、UI 経由では作れないデータ
(登録日を持たない古い記録など) を直接仕込めます。

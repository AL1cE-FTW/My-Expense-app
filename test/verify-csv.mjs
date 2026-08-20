import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// このファイルからの相対パスで解決する (どこから実行しても動くように)
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const scratch = process.env.TEST_OUT_DIR || here;
const stubRoot = path.join(here, "stubs");
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

const server = http.createServer((req, res) => {
  const p = path.join(root, req.url === "/" ? "index.html" : req.url);
  try {
    const data = fs.readFileSync(p);
    res.writeHead(200, { "content-type": mime[path.extname(p)] || "text/plain" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("nf");
  }
});
await new Promise((r) => server.listen(8991, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (text.includes("Failed to load resource") || text.includes("net::ERR_")) return;
  errors.push("console: " + text);
});

await page.route("https://www.gstatic.com/firebasejs/**/*.js", async (route) => {
  const url = new URL(route.request().url());
  await route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: fs.readFileSync(path.join(stubRoot, url.pathname.split("/").pop()), "utf-8"),
  });
});
// Shift_JIS のエンコーダ。Node には decoder しか無いので、全バイト列を
// 復号して逆引き表を作る。カード会社のCSVはこの文字コードのことが多く、
// 文字化けを検出して読み直す処理を実データで確かめたいため。
function encodeShiftJis(text) {
  const dec = new TextDecoder("shift_jis");
  const map = new Map();
  for (let b = 0; b < 0x100; b++) {
    const ch = dec.decode(Uint8Array.from([b]));
    if (ch.length === 1 && ch !== "\uFFFD" && !map.has(ch)) map.set(ch, [b]);
  }
  for (let hi = 0x81; hi <= 0xef; hi++) {
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      const ch = dec.decode(Uint8Array.from([hi, lo]));
      if (ch.length === 1 && ch !== "\uFFFD" && !map.has(ch)) map.set(ch, [hi, lo]);
    }
  }
  const out = [];
  for (const ch of text) {
    const bytes = map.get(ch);
    if (!bytes) throw new Error("Shift_JIS に変換できない文字: " + ch);
    out.push(...bytes);
  }
  return Buffer.from(Uint8Array.from(out));
}

const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

const NOW = new Date();
const CUR_Y = NOW.getFullYear();
const MM = String(NOW.getMonth() + 1).padStart(2, "0");
const write = (name, lines) => {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, lines.join("\n"), "utf-8");
  return p;
};
const lastConfirm = () => dialogs.find((m) => m.includes("インポートします"));

await page.goto("http://localhost:8991/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "csv-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

const txt = async (sel) => (await page.textContent(sel)).trim();
const rowFor = (memo) => page.locator("#entry-list tr", { hasText: memo });

// ---------------------------------------------------------------------------
// 1. 縦持ち形式 (エクスポートと同じ並び)。カテゴリは読み替えられる
// ---------------------------------------------------------------------------
const simple = write("csv-simple.csv", [
  "日付,種別,カテゴリ,金額,メモ",
  `${CUR_Y}/${MM}/03,支出,水道光熱費,8000,電気代`,
  `${CUR_Y}/${MM}/04,支出,食費,1200,既知カテゴリ`,
  `${CUR_Y}/${MM}/05,支出,謎のカテゴリ,3000,未知の支出`,
  `${CUR_Y}/${MM}/06,収入,給料,250000,給与の別名`,
  `${CUR_Y}/${MM}/07,貯蓄,謎の貯蓄,5000,未知の貯蓄`,
  `${CUR_Y}/${MM}/08,支出,,900,カテゴリ空`,
  `おかしな日付,支出,食費,500,日付不正`,
]);
await page.setInputFiles("#import-csv-input", simple);
await page.waitForTimeout(700);

const simpleMsg = lastConfirm();
console.log("simple:", simpleMsg);
if (!simpleMsg.includes("5件の記録をインポートします")) {
  throw new Error("expected 5 valid rows: " + simpleMsg);
}
if (!simpleMsg.includes("2件の行はスキップされます")) {
  throw new Error("the 2 broken rows should be reported: " + simpleMsg);
}
// 読み替えたカテゴリを黙って変えず、内容を知らせる
if (!simpleMsg.includes("カテゴリを読み替えます") || !simpleMsg.includes("水道光熱費 → 水道・光熱")) {
  throw new Error("category conversions should be listed: " + simpleMsg);
}

await page.click("#today-btn");
await page.waitForTimeout(300);
if (!(await rowFor("電気代").textContent()).includes("水道・光熱")) throw new Error("alias not resolved");
if (!(await rowFor("未知の支出").textContent()).includes("その他支出")) throw new Error("unknown expense fallback");
if (!(await rowFor("給与の別名").textContent()).includes("給与")) throw new Error("給料 -> 給与");
if (!(await rowFor("未知の貯蓄").textContent()).includes("その他貯蓄")) throw new Error("unknown save fallback");
if ((await txt("#entry-list")).includes("謎のカテゴリ")) throw new Error("raw category must not be stored");

// 編集で開いたとき <select> がそのカテゴリを指す (無言で書き換わらない)
await rowFor("電気代").locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
if ((await page.locator("#entry-category").inputValue()) !== "水道・光熱") {
  throw new Error("edit form should preselect the resolved category");
}
await page.click("#cancel-edit-btn");
await page.waitForTimeout(200);

// ---------------------------------------------------------------------------
// 2. 同じCSVをもう一度読むと全部スキップされる
// ---------------------------------------------------------------------------
dialogs.length = 0;
await page.setInputFiles("#import-csv-input", simple);
await page.waitForTimeout(700);
if (!dialogs.some((m) => m.includes("すべて(5件)既に登録済み"))) {
  throw new Error("re-importing the same file should skip everything: " + dialogs.join(" / "));
}

// ---------------------------------------------------------------------------
// 3. 横持ち形式 (「取引」タブのエクスポート)
// ---------------------------------------------------------------------------
dialogs.length = 0;
const wide = write("csv-wide.csv", [
  "支出,,,,,収入,,,",
  ",日付,金額,説明,カテゴリ,,日付,金額,説明,カテゴリ",
  `,${CUR_Y}/${MM}/11,2500,ランチ,食費,,${CUR_Y}/${MM}/12,80000,副業,副収入`,
  `,${CUR_Y}/${MM}/13,1800,電車,交通費,,,,,`,
  "解説の行なので無視される,,,,,,,,,",
]);
await page.setInputFiles("#import-csv-input", wide);
await page.waitForTimeout(700);
const wideMsg = lastConfirm();
console.log("wide:", wideMsg);
if (!wideMsg.includes("3件の記録をインポートします")) throw new Error("wide format wrong: " + wideMsg);
await page.click("#today-btn");
await page.waitForTimeout(300);
if (!(await rowFor("電車").textContent()).includes("交通")) throw new Error("交通費 -> 交通");
if (!(await rowFor("副業").textContent()).includes("副収入")) throw new Error("income side not imported");

// ---------------------------------------------------------------------------
// 4. カード利用履歴 (Shift_JIS・店名からのカテゴリ推測・合計の検算)
// ---------------------------------------------------------------------------
dialogs.length = 0;
const cardLines = [
  "宇津木　武　様,4980-09**-****-****,Ｏｌｉｖｅ／クレジット",
  `${CUR_Y}/${MM}/14,モバイルＳｕｉｃａ（Ａｐｐｌｅ）,2000,１,１,2000,`,
  `${CUR_Y}/${MM}/15,ﾌｧﾐﾘｰﾏｰﾄ　横浜西口店,540,１,１,540,`,
  `${CUR_Y}/${MM}/16,ＢＯＯＴＨ,900,１,１,900,`,
  `${CUR_Y}/${MM}/17,スーパーオートバックス,12000,１,１,12000,`,
  ",,,,,15440,",
];
const cardPath = path.join(scratch, "csv-card-sjis.csv");
fs.writeFileSync(cardPath, encodeShiftJis(cardLines.join("\n")));
await page.setInputFiles("#import-csv-input", cardPath);
await page.waitForTimeout(700);
const cardMsg = lastConfirm();
console.log("card:", cardMsg);
if (!cardMsg.includes("4件の記録をインポートします")) throw new Error("card format wrong: " + cardMsg);
if (!cardMsg.includes("✓ CSV記載の合計金額(¥15,440)と一致しました")) {
  throw new Error("total verification should pass: " + cardMsg);
}
await page.click("#today-btn");
await page.waitForTimeout(300);
if (!(await rowFor("Ｓｕｉｃａ").textContent()).includes("交通")) throw new Error("Suica -> 交通");
// 半角カナも全角に正規化してから判定する
if (!(await rowFor("ﾌｧﾐﾘｰﾏｰﾄ").textContent()).includes("食費")) throw new Error("half-width kana -> 食費");
// 全角のままだった BOOTH ルールが効く
if (!(await rowFor("ＢＯＯＴＨ").textContent()).includes("趣味・娯楽")) throw new Error("BOOTH -> 趣味・娯楽");
// 「スーパー」の部分一致で食費に誤分類されない
if ((await rowFor("スーパーオートバックス").textContent()).includes("食費")) {
  throw new Error("スーパーオートバックス must not be classified as 食費");
}

await page.screenshot({ path: path.join(scratch, "csv.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL CSV IMPORT CHECKS PASSED");
await browser.close();
server.close();

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
await new Promise((r) => server.listen(8997, r));

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
page.on("dialog", (d) => d.accept());

const NOW = new Date();
const CUR_Y = NOW.getFullYear();
const MM = String(NOW.getMonth() + 1).padStart(2, "0");
const UID = "uid-sort-test@example.com";

await page.goto("http://localhost:8997/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "sort-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

for (const e of [
  { date: `${CUR_Y}-${MM}-10`, category: "食費", amount: "3000" },
  { date: `${CUR_Y}-${MM}-05`, category: "交通", amount: "1000" },
  { date: `${CUR_Y}-${MM}-20`, category: "住居", amount: "50000" },
]) {
  await page.fill("#entry-date", e.date);
  await page.selectOption("#entry-category", e.category);
  await page.fill("#entry-amount", e.amount);
  await page.click("#submit-btn");
  await page.waitForTimeout(150);
}
await page.click("#today-btn");
await page.waitForTimeout(300);

const cell = async (n) =>
  (await page.locator("#entry-list tr").first().locator("td").nth(n).textContent()).trim();
const clickSort = async (col) => {
  await page.click(`.entry-table th[data-sort="${col}"] button`);
  await page.waitForTimeout(250);
};

// 既定は日付の新しい順
if ((await cell(2)) !== "住居") throw new Error("default sort should be date desc, got " + (await cell(2)));
// 金額: 既定は大きい順、もう一度で小さい順
await clickSort("amount");
if (!(await cell(3)).includes("50,000")) throw new Error("amount desc failed");
await clickSort("amount");
if (!(await cell(3)).includes("1,000")) throw new Error("amount asc failed");
// カテゴリ: 五十音順 (交通 < 住居 < 食費)
await clickSort("category");
if ((await cell(2)) !== "交通") throw new Error("category asc failed, got " + (await cell(2)));
// 種別でも並べ替えられる
await clickSort("type");
// 日付に戻す
await clickSort("date");
if ((await cell(2)) !== "住居") throw new Error("back to date desc failed");

// ---------------------------------------------------------------------------
// 登録日: 未設定の古い記録は昇順でも降順でも末尾に寄せる
// ---------------------------------------------------------------------------
await page.evaluate((uid) => {
  window.__seedDoc(`users/${uid}/entries/legacy1`, {
    date: new Date().toISOString().slice(0, 10),
    type: "expense",
    category: "通信",
    amount: 4000,
    memo: "登録日なしの古い記録",
  });
}, UID);
await page.waitForTimeout(400);

const memos = async () => (await page.locator("#entry-list tr").allTextContents()).map((t) => t.trim());
await clickSort("createdAt");
if ((await page.locator('.entry-table th[data-sort="createdAt"]').getAttribute("aria-sort")) !== "descending") {
  throw new Error("登録日 should default to desc");
}
let rows = await memos();
if (rows.length !== 4) throw new Error("expected 4 rows, got " + rows.length);
if (!rows[rows.length - 1].includes("登録日なしの古い記録")) {
  throw new Error("missing createdAt should sort last in desc: " + rows.join(" | "));
}
await clickSort("createdAt");
rows = await memos();
if (!rows[rows.length - 1].includes("登録日なしの古い記録")) {
  throw new Error("missing createdAt should sort last in asc too: " + rows.join(" | "));
}
// 未設定は「—」で表示
if (!(await page.locator("#entry-list tr", { hasText: "登録日なしの古い記録" }).textContent()).includes("—")) {
  throw new Error("missing createdAt should render as —");
}

// ---------------------------------------------------------------------------
// 絞り込み: 種別を変えるとカテゴリの選択肢も絞られる
// ---------------------------------------------------------------------------
await clickSort("date");
await page.selectOption("#filter-type", "income");
await page.waitForTimeout(300);
const incomeOptions = await page.locator("#filter-category option").allTextContents();
if (incomeOptions.includes("食費")) throw new Error("expense categories should drop out for 収入");
if (!incomeOptions.includes("給与")) throw new Error("income categories should be offered");
if ((await page.locator("#entry-list tr").count()) !== 0) throw new Error("no income rows yet");
if ((await page.textContent("#list-empty-message")).trim() !== "条件に一致する記録がありません。") {
  throw new Error("empty message wrong");
}
await page.selectOption("#filter-type", "all");
await page.waitForTimeout(300);
await page.selectOption("#filter-category", "食費");
await page.waitForTimeout(300);
if ((await page.locator("#entry-list tr").count()) !== 1) throw new Error("category filter should leave 1 row");
await page.selectOption("#filter-category", "all");
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// CSVエクスポート: 5列・BOM付き・金額は生の数値
// ---------------------------------------------------------------------------
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.click("#export-csv-btn"),
]);
const csvPath = path.join(scratch, "exported.csv");
await download.saveAs(csvPath);
const raw = fs.readFileSync(csvPath);
if (raw[0] !== 0xef || raw[1] !== 0xbb || raw[2] !== 0xbf) {
  throw new Error("the export should carry a UTF-8 BOM so Excel opens it correctly");
}
const csv = raw.toString("utf-8").replace(/^﻿/, "").trim().split("\n");
if (csv[0].trim() !== "日付,種別,カテゴリ,金額,メモ") throw new Error("header wrong: " + csv[0]);
if (csv.length !== 5) throw new Error("expected header + 4 rows, got " + csv.length);
// 金額は ¥ やカンマを付けずに出す (読み直せる形)
if (!csv.some((l) => l.includes(",50000,"))) throw new Error("amounts should be raw numbers: " + csv.join(" | "));

await page.screenshot({ path: path.join(scratch, "sort.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL SORT/FILTER/EXPORT CHECKS PASSED");
await browser.close();
server.close();

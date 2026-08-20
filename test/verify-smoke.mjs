// 編集ポップアップ化で壊れうる周辺の流れをまとめて確認する煙テスト。
// (追加・削除・立替の精算モーダル・予算フォーム・種別切り替え)
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
await new Promise((r) => server.listen(8982, r));

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
page.on("dialog", (d) => d.accept());

await page.route("https://www.gstatic.com/firebasejs/**/*.js", async (route) => {
  const url = new URL(route.request().url());
  await route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: fs.readFileSync(path.join(stubRoot, url.pathname.split("/").pop()), "utf-8"),
  });
});

const NOW = new Date();
const CUR_Y = NOW.getFullYear();
const MM = String(NOW.getMonth() + 1).padStart(2, "0");

await page.goto("http://localhost:8982/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);

await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "smoke-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

// --- 追加 (フォームはページ内にあり、追加後も残る) ---
await page.fill("#entry-date", `${CUR_Y}-${MM}-05`);
await page.selectOption("#entry-category", "食費");
await page.fill("#entry-amount", "1500");
await page.fill("#entry-memo", "スーパー");
await page.click("#submit-btn");
await page.waitForTimeout(400);

if (
  !(await page.evaluate(
    () => !!document.getElementById("entry-form-slot")?.contains(document.getElementById("entry-form"))
  ))
) {
  throw new Error("adding must leave the form in the page");
}
if (await page.locator("#entry-edit-modal").isVisible()) {
  throw new Error("adding must not open the edit popup");
}
if ((await page.textContent("#total-expense")).trim() !== "¥1,500") {
  throw new Error("expense total wrong: " + (await page.textContent("#total-expense")));
}

// --- 収入・貯蓄も追加でき、サマリーに反映される ---
await page.click('.type-option:has(input[value="income"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-25`);
await page.selectOption("#entry-category", "副収入");
await page.fill("#entry-amount", "50000");
await page.fill("#entry-memo", "副業");
await page.click("#submit-btn");
await page.waitForTimeout(400);

await page.click('.type-option:has(input[value="save"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-26`);
await page.selectOption("#entry-category", "株式");
await page.fill("#entry-amount", "20000");
await page.fill("#entry-memo", "積立");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await page.click("#today-btn");
await page.waitForTimeout(300);

if ((await page.textContent("#total-income")).trim() !== "¥50,000") {
  throw new Error("income total wrong");
}
if ((await page.textContent("#total-save")).trim() !== "¥20,000") {
  throw new Error("save total wrong");
}
if ((await page.textContent("#balance")).trim() !== "¥48,500") {
  throw new Error("balance wrong: " + (await page.textContent("#balance")));
}

// --- 予算フォームは従来どおりページ内で開く ---
await page.click("#edit-budget-btn");
await page.waitForTimeout(300);
if (!(await page.locator("#budget-form").isVisible())) throw new Error("budget form should open");
await page.fill("#budget-input-食費", "30000");
await page.locator("#budget-form button[type=submit]").click();
await page.waitForTimeout(400);
if (!(await page.textContent("#budget-overall")).includes("¥1,500 / ¥30,000")) {
  throw new Error("budget bar wrong: " + (await page.textContent("#budget-overall")));
}

// --- 立替の精算モーダルは編集ポップアップと共存できる ---
await page.click('.type-option:has(input[value="expense"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-10`);
await page.selectOption("#entry-category", "交通");
await page.fill("#entry-amount", "8000");
await page.fill("#entry-memo", "出張");
await page.check("#entry-advance");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await page.click("#today-btn");
await page.waitForTimeout(300);

if ((await page.textContent("#advance-outstanding-total")).trim() !== "¥8,000") {
  throw new Error("advance total wrong");
}
await page.locator(".advance-row").first().locator("button", { hasText: "精算" }).click();
await page.waitForTimeout(300);
if (!(await page.locator("#advance-settle-modal").isVisible())) {
  throw new Error("settle modal should open");
}
// 精算モーダルを開いても、入力フォームはページ内のまま
if (
  !(await page.evaluate(
    () => !!document.getElementById("entry-form-slot")?.contains(document.getElementById("entry-form"))
  ))
) {
  throw new Error("the settle modal must not move the entry form");
}
await page.fill("#advance-settle-date", `${CUR_Y}-${MM}-28`);
await page.click("#advance-settle-confirm");
await page.waitForTimeout(500);
if ((await page.textContent("#advance-outstanding-total")).trim() !== "¥0") {
  throw new Error("advance should be settled");
}

// --- 削除 ---
const before = await page.locator("#entry-list tr").count();
await page
  .locator("#entry-list tr", { hasText: "スーパー" })
  .locator("button", { hasText: "削除" })
  .click();
await page.waitForTimeout(500);
const after = await page.locator("#entry-list tr").count();
if (after !== before - 1) throw new Error(`delete failed: ${before} -> ${after}`);

// --- 絞り込みと並び替えが動く ---
await page.selectOption("#filter-type", "income");
await page.waitForTimeout(300);
const incomeRows = await page.locator("#entry-list tr").count();
if (incomeRows !== 2) throw new Error("income filter should show 2 rows, got " + incomeRows);
await page.selectOption("#filter-type", "all");
await page.waitForTimeout(300);

await page.click('.entry-table th[data-sort="amount"] button');
await page.waitForTimeout(300);
if ((await page.locator('.entry-table th[data-sort="amount"]').getAttribute("aria-sort")) !== "descending") {
  throw new Error("sorting by amount should work");
}

await page.screenshot({ path: path.join(scratch, "smoke.png"), fullPage: true });

if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL SMOKE CHECKS PASSED");
await browser.close();
server.close();

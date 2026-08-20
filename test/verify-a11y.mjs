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
await new Promise((r) => server.listen(8994, r));

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

await page.goto("http://localhost:8994/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "a11y-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// 1. 種別のラジオがキーボードで選べ、グループ名を持つ
// ---------------------------------------------------------------------------
// display:none だとフォーカスできず focus() 自体が効かない
await page.locator('input[name="entry-type"][value="expense"]').focus();
if ((await page.evaluate(() => document.activeElement?.getAttribute("name"))) !== "entry-type") {
  throw new Error("the type radios must be focusable");
}
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(200);
if ((await page.evaluate(() => document.querySelector('input[name="entry-type"]:checked')?.value)) !== "income") {
  throw new Error("ArrowRight should move the radio selection");
}
// 選択の変更がカテゴリ一覧に反映される
if (!(await page.locator("#entry-category option").allTextContents()).includes("給与")) {
  throw new Error("keyboard selection should update the categories");
}
// <fieldset>/<legend> でグループ名が付いている
const legend = await page.locator(".type-fieldset legend").textContent();
if (legend.trim() !== "種別") throw new Error("the radio group needs a legend, got " + legend);

// ---------------------------------------------------------------------------
// 2. 絞り込みのプルダウンに名前がある
// ---------------------------------------------------------------------------
for (const [id, expected] of [["filter-type", "種別"], ["filter-category", "カテゴリ"]]) {
  const label = await page.locator(`#${id}`).getAttribute("aria-label");
  if (!label || !label.includes(expected)) {
    throw new Error(`#${id} needs an accessible name, got ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 3. CSVインポートがキーボードから起動できる
// ---------------------------------------------------------------------------
await page.locator("#import-csv-btn").focus();
if ((await page.evaluate(() => document.activeElement?.id)) !== "import-csv-btn") {
  throw new Error("the CSV import trigger must be focusable");
}
await page.evaluate(() => {
  window.__fileInputClicked = false;
  document.getElementById("import-csv-input").addEventListener("click", (e) => {
    e.preventDefault();
    window.__fileInputClicked = true;
  });
});
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
if (!(await page.evaluate(() => window.__fileInputClicked))) {
  throw new Error("Enter on the import button should open the file picker");
}

// ---------------------------------------------------------------------------
// 4. 並び替え見出しは本物のボタンで、aria-sort が状態を伝える
// ---------------------------------------------------------------------------
await page.click('.type-option:has(input[value="expense"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-05`);
await page.selectOption("#entry-category", "食費");
await page.fill("#entry-amount", "1200");
await page.fill("#entry-memo", "キーボード操作");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await page.click("#today-btn");
await page.waitForTimeout(300);

const dateHeader = page.locator('.entry-table th[data-sort="date"]');
const amountHeader = page.locator('.entry-table th[data-sort="amount"]');
if ((await dateHeader.getAttribute("aria-sort")) !== "descending") {
  throw new Error("the active column should report aria-sort");
}
if ((await amountHeader.getAttribute("aria-sort")) !== "none") {
  throw new Error("inactive columns should report aria-sort=none");
}
const amountBtn = amountHeader.locator("button.sort-btn");
if ((await amountBtn.count()) !== 1) throw new Error("sortable headers should contain a real button");
await amountBtn.focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
if ((await amountHeader.getAttribute("aria-sort")) !== "descending") {
  throw new Error("Enter should sort by that column");
}
await page.keyboard.press(" ");
await page.waitForTimeout(250);
if ((await amountHeader.getAttribute("aria-sort")) !== "ascending") {
  throw new Error("Space should toggle the direction");
}

// ---------------------------------------------------------------------------
// 5. タブの選択状態と月移動の読み上げ
// ---------------------------------------------------------------------------
if ((await page.locator('.view-tab[data-view="month"]').getAttribute("aria-pressed")) !== "true") {
  throw new Error("the active view tab should be aria-pressed");
}
await page.click('.view-tab[data-view="year"]');
await page.waitForTimeout(300);
if ((await page.locator('.view-tab[data-view="year"]').getAttribute("aria-pressed")) !== "true") {
  throw new Error("aria-pressed should follow the selection");
}
if ((await page.locator('.view-tab[data-view="month"]').getAttribute("aria-pressed")) !== "false") {
  throw new Error("the deselected tab should report aria-pressed=false");
}
await page.click('.view-tab[data-view="month"]');
await page.waitForTimeout(300);
if ((await page.locator("#current-month").getAttribute("aria-live")) !== "polite") {
  throw new Error("changing months should be announced (aria-live)");
}

// ---------------------------------------------------------------------------
// 6. モーダル: ダイアログとして認識され、Tabが外に抜けず、閉じたら復帰する
// ---------------------------------------------------------------------------
await page.click('.type-option:has(input[value="expense"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-06`);
await page.selectOption("#entry-category", "交通");
await page.fill("#entry-amount", "3000");
await page.fill("#entry-memo", "立替の記録");
await page.check("#entry-advance");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await page.click("#today-btn");
await page.waitForTimeout(300);

const settleBtn = page.locator(".advance-row", { hasText: "立替の記録" }).locator("button", { hasText: "精算" });
await settleBtn.focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(350);

const modalBox = page.locator("#advance-settle-modal .modal-box");
if ((await modalBox.getAttribute("role")) !== "dialog") throw new Error("modal should be role=dialog");
if ((await modalBox.getAttribute("aria-modal")) !== "true") throw new Error("modal should be aria-modal");
const labelledBy = await modalBox.getAttribute("aria-labelledby");
if (!labelledBy || (await page.locator(`#${labelledBy}`).count()) !== 1) {
  throw new Error("aria-labelledby should point at an existing title");
}
if (!(await page.evaluate(() => !!document.activeElement?.closest("#advance-settle-modal")))) {
  throw new Error("opening a modal should move focus into it");
}
for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
  await page.keyboard.press(key);
  if (!(await page.evaluate(() => !!document.activeElement?.closest("#advance-settle-modal")))) {
    const where = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    throw new Error(`focus escaped the modal on ${key}, landed on ${where}`);
  }
}
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
if (await page.locator("#advance-settle-modal").isVisible()) throw new Error("Escape should close the modal");
if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) !== "精算") {
  throw new Error("closing should restore focus to the trigger");
}

// ---------------------------------------------------------------------------
// 7. 行の操作ボタンは、どの記録に対するものか名前で分かる
// ---------------------------------------------------------------------------
const editLabel = await page
  .locator("#entry-list tr", { hasText: "キーボード操作" })
  .locator("button", { hasText: "編集" })
  .getAttribute("aria-label");
if (!editLabel || !editLabel.includes("食費") || !editLabel.includes("を編集")) {
  throw new Error("row buttons should name the record they act on, got " + editLabel);
}

await page.screenshot({ path: path.join(scratch, "a11y.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL KEYBOARD ACCESSIBILITY CHECKS PASSED");
await browser.close();
server.close();

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
await new Promise((r) => server.listen(8996, r));

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
const PREV = new Date(CUR_Y, NOW.getMonth() - 1, 15);
const PREV_DATE = `${PREV.getFullYear()}-${String(PREV.getMonth() + 1).padStart(2, "0")}-15`;
const txt = async (sel) => (await page.textContent(sel)).trim();

await page.goto("http://localhost:8996/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "advance-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

async function addExpense({ date, category, amount, memo, advance = false }) {
  await page.click('.type-option:has(input[value="expense"]) span');
  await page.fill("#entry-date", date);
  await page.selectOption("#entry-category", category);
  await page.fill("#entry-amount", String(amount));
  await page.fill("#entry-memo", memo);
  if (advance) await page.check("#entry-advance");
  await page.click("#submit-btn");
  await page.waitForTimeout(250);
}

// ---------------------------------------------------------------------------
// 1. 立替チェックは支出のときだけ出る
// ---------------------------------------------------------------------------
if (!(await page.locator("#advance-toggle").isVisible())) throw new Error("should show for 支出");
for (const t of ["income", "save"]) {
  await page.click(`.type-option:has(input[value="${t}"]) span`);
  await page.waitForTimeout(150);
  if (await page.locator("#advance-toggle").isVisible()) throw new Error(`should hide for ${t}`);
}
await page.click('.type-option:has(input[value="expense"]) span');
await page.waitForTimeout(150);

// ---------------------------------------------------------------------------
// 2. 立替は通常の支出として集計される (中立扱いではない)
// ---------------------------------------------------------------------------
await addExpense({ date: `${CUR_Y}-${MM}-10`, category: "交通", amount: 30000, memo: "出張の新幹線", advance: true });
await page.click("#today-btn");
await page.waitForTimeout(300);
if ((await txt("#advance-outstanding-total")) !== "¥30,000") throw new Error("outstanding wrong");
if ((await txt("#total-expense")) !== "¥30,000") throw new Error("advance must count as a normal expense");
if ((await txt("#balance")) !== "-¥30,000") throw new Error("balance should reflect it");
if ((await txt("#cumulative-savings")) !== "-¥30,000") throw new Error("cumulative should reflect it");
if ((await page.locator(".advance-badge").first().textContent()).trim() !== "立替(未回収)") {
  throw new Error("unsettled badge wrong");
}

// ---------------------------------------------------------------------------
// 3. 未回収一覧は期間で絞られない (先月の立替も出る)
// ---------------------------------------------------------------------------
await addExpense({ date: PREV_DATE, category: "交際費", amount: 8000, memo: "先月の接待", advance: true });
await page.click("#today-btn");
await page.waitForTimeout(300);
if ((await txt("#advance-outstanding-total")) !== "¥38,000") throw new Error("should include last month's");
if ((await page.locator(".advance-row").count()) !== 2) throw new Error("expected 2 outstanding");
if ((await page.locator("#entry-list tr").count()) !== 1) throw new Error("the list stays period-filtered");

// ---------------------------------------------------------------------------
// 4. 精算すると返金の収入が自動作成され、相殺される
// ---------------------------------------------------------------------------
await page.locator(".advance-row", { hasText: "出張の新幹線" }).locator("button", { hasText: "精算" }).click();
await page.waitForTimeout(300);
if (!(await page.locator("#advance-settle-modal").isVisible())) throw new Error("settle modal should open");
if (!(await txt("#advance-settle-summary")).includes("¥30,000")) throw new Error("summary wrong");
await page.fill("#advance-settle-date", `${CUR_Y}-${MM}-28`);
await page.click("#advance-settle-confirm");
await page.waitForTimeout(500);

if (await page.locator("#advance-settle-modal").isVisible()) throw new Error("should close after confirming");
if ((await txt("#advance-outstanding-total")) !== "¥8,000") throw new Error("outstanding after settle wrong");
const list = await txt("#entry-list");
if (!list.includes("立替金精算: 出張の新幹線")) throw new Error("refund memo wrong");
if ((await txt("#total-income")) !== "¥30,000") throw new Error("refund should count in the summary income");
if ((await txt("#balance")) !== "¥0") throw new Error("balance should offset to zero");
if ((await page.locator(".advance-badge.settled").count()) !== 1) throw new Error("settled badge missing");

// ---------------------------------------------------------------------------
// 5. 返金は「稼いだお金」ではないので、目標・NWSの収入には数えない
// ---------------------------------------------------------------------------
await page.click("#edit-income-budget-btn");
await page.waitForTimeout(200);
await page.fill("#income-budget-input-給与", "200000");
await page.locator("#income-budget-form button[type=submit]").click();
await page.waitForTimeout(300);
const incomePA = await txt("#income-plan-actual");
if (incomePA.includes("¥30,000")) {
  throw new Error("立替金返金 must not appear in the income plan/actual: " + incomePA);
}
const nws = await txt("#nws-legend");
if (nws.includes("¥15,000 /")) {
  throw new Error("the refund must not inflate the Need/Want/Save income base: " + nws);
}

// ---------------------------------------------------------------------------
// 6. 精算状態は返金の有無から導出している (返金を消すと未回収に戻る)
// ---------------------------------------------------------------------------
await page.locator("#entry-list tr", { hasText: "立替金返金" }).locator("button", { hasText: "削除" }).click();
await page.waitForTimeout(500);
if ((await txt("#advance-outstanding-total")) !== "¥38,000") {
  throw new Error("deleting the refund should restore the advance");
}

// ---------------------------------------------------------------------------
// 7. 精算済みの立替を消すと、対の返金も一緒に消える (幽霊レコードを残さない)
// ---------------------------------------------------------------------------
await page.locator(".advance-row", { hasText: "出張の新幹線" }).locator("button", { hasText: "精算" }).click();
await page.waitForTimeout(300);
await page.fill("#advance-settle-date", `${CUR_Y}-${MM}-28`);
await page.click("#advance-settle-confirm");
await page.waitForTimeout(500);
const cumulativeBefore = await txt("#cumulative-savings");

await page
  .locator("#entry-list tr", { hasText: "出張の新幹線" })
  .filter({ hasNotText: "立替金精算" })
  .locator("button", { hasText: "削除" })
  .click();
await page.waitForTimeout(600);
if ((await page.locator("#entry-list tr", { hasText: "立替金精算: 出張の新幹線" }).count()) !== 0) {
  throw new Error("deleting the advance must also delete its refund");
}
if ((await txt("#cumulative-savings")) !== cumulativeBefore) {
  throw new Error(`cumulative should be unchanged, ${cumulativeBefore} -> ${await txt("#cumulative-savings")}`);
}

// ---------------------------------------------------------------------------
// 8. 編集で立替チェックを外すと未回収から消える
// ---------------------------------------------------------------------------
await page.click("#prev-month");
await page.waitForTimeout(300);
await page.locator("#entry-list tr", { hasText: "先月の接待" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(400);
if (!(await page.locator("#entry-advance").isChecked())) {
  throw new Error("editing should restore the advance checkbox");
}
await page.uncheck("#entry-advance");
await page.click("#submit-btn");
await page.waitForTimeout(500);
await page.click("#today-btn");
await page.waitForTimeout(300);
if ((await txt("#advance-outstanding-total")) !== "¥0") {
  throw new Error("unchecking should drop it from outstanding: " + (await txt("#advance-outstanding-total")));
}

await page.screenshot({ path: path.join(scratch, "advance.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL ADVANCE (立替金) CHECKS PASSED");
await browser.close();
server.close();

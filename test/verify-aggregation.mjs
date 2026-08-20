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
await new Promise((r) => server.listen(8990, r));

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
const CUR_M = NOW.getMonth() + 1;
const MM = String(CUR_M).padStart(2, "0");
// 年間表示の目標は「経過した月数」で按分される
const ELAPSED = CUR_M;

await page.goto("http://localhost:8990/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "aggregation-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

async function addEntry({ type = "expense", date, category, amount, memo = "" }) {
  await page.click(`.type-option:has(input[value="${type}"]) span`);
  await page.fill("#entry-date", date);
  await page.selectOption("#entry-category", category);
  await page.fill("#entry-amount", String(amount));
  await page.fill("#entry-memo", memo);
  await page.click("#submit-btn");
  await page.waitForTimeout(150);
}

// 今月: 収入 300,000 / 食費 100,000 (Need) / 趣味・娯楽 60,000 (Want)
await addEntry({ type: "income", date: `${CUR_Y}-${MM}-25`, category: "給与", amount: 300000, memo: "今月の給与" });
await addEntry({ date: `${CUR_Y}-${MM}-05`, category: "食費", amount: 100000, memo: "食費まとめ" });
await addEntry({ date: `${CUR_Y}-${MM}-06`, category: "趣味・娯楽", amount: 60000, memo: "趣味" });
await page.click("#today-btn");
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// 1. サマリーの集計
// ---------------------------------------------------------------------------
const txt = async (sel) => (await page.textContent(sel)).trim();
if ((await txt("#total-income")) !== "¥300,000") throw new Error("income wrong: " + (await txt("#total-income")));
if ((await txt("#total-expense")) !== "¥160,000") throw new Error("expense wrong: " + (await txt("#total-expense")));
if ((await txt("#balance")) !== "¥140,000") throw new Error("balance wrong: " + (await txt("#balance")));

// ---------------------------------------------------------------------------
// 2. Need / Want / Save (50:30:20)
// ---------------------------------------------------------------------------
// Need目標 15万 / Want目標 9万 / Save目標 6万、Save実績 = 30万-10万-6万 = 14万
let legend = await txt("#nws-legend");
console.log("NWS:", legend);
if (!legend.includes("¥100,000 / ¥150,000 (67%)")) throw new Error("Need wrong: " + legend);
if (!legend.includes("¥60,000 / ¥90,000 (67%)")) throw new Error("Want wrong: " + legend);
if (!legend.includes("¥140,000 / ¥60,000 (233%)")) throw new Error("Save wrong: " + legend);
// 貯蓄・投資は Need/Want に数えない (中立)
await addEntry({ type: "save", date: `${CUR_Y}-${MM}-27`, category: "株式", amount: 50000, memo: "積立" });
await page.click("#today-btn");
await page.waitForTimeout(300);
legend = await txt("#nws-legend");
if (!legend.includes("¥140,000 / ¥60,000 (233%)")) {
  throw new Error("saving must stay neutral for Need/Want/Save: " + legend);
}
if ((await txt("#total-expense")) !== "¥160,000") throw new Error("saving must not count as expense");

// ---------------------------------------------------------------------------
// 3. 累計貯金額と今月の増減
// ---------------------------------------------------------------------------
// 貯蓄は中立なので累計は 300,000 - 160,000 = 140,000
if ((await txt("#cumulative-savings")) !== "¥140,000") {
  throw new Error("cumulative wrong: " + (await txt("#cumulative-savings")));
}
if (!(await txt("#cumulative-change")).includes("+¥140,000")) {
  throw new Error("this month's change wrong: " + (await txt("#cumulative-change")));
}

// ---------------------------------------------------------------------------
// 4. 予算バー: 分子は予算を設定したカテゴリだけ、残りは「予算外」
// ---------------------------------------------------------------------------
await page.click("#edit-budget-btn");
await page.waitForTimeout(200);
await page.fill("#budget-input-食費", "120000");
await page.locator("#budget-form button[type=submit]").click();
await page.waitForTimeout(300);

const overall = await txt("#budget-overall");
console.log("budget:", overall);
if (!overall.includes("¥100,000 / ¥120,000")) throw new Error("budget bar wrong: " + overall);
if (overall.includes("¥160,000")) throw new Error("unbudgeted spend must not be in the numerator: " + overall);
if ((await txt(".budget-unbudgeted")) !== "予算外: ¥60,000") {
  throw new Error("予算外 line wrong: " + (await txt(".budget-unbudgeted")));
}

// 支出の「予定と実績」も予算設定分だけ。差額の説明が出る
const expensePA = await txt("#expense-plan-actual");
if (!expensePA.includes("¥100,000") || !expensePA.includes("¥120,000")) {
  throw new Error("expense plan/actual wrong: " + expensePA);
}
if (!(await txt("#unbudgeted-note")).includes("予算外の支出が ¥60,000")) {
  throw new Error("the gap vs the summary should be explained: " + expensePA);
}

// ---------------------------------------------------------------------------
// 5. 収入目標と賞与
// ---------------------------------------------------------------------------
await page.click("#edit-income-budget-btn");
await page.waitForTimeout(200);
// 賞与カテゴリの直接入力欄は無い (ボーナス設定で計算するため)
if ((await page.locator("#income-budget-input-賞与").count()) !== 0) {
  throw new Error("賞与 should not have a direct input");
}
// 返金系も収入目標の対象外
for (const c of ["立替金返金", "カード返金"]) {
  if ((await page.locator(`#income-budget-input-${c}`).count()) !== 0) {
    throw new Error(`${c} should not appear in the income budget form`);
  }
}
await page.fill("#income-budget-input-給与", "250000");
await page.check(`.bonus-month-grid input[type=checkbox][data-month="${CUR_M}"]`);
await page.fill("#bonus-multiplier-input", "2");
await page.locator("#income-budget-form button[type=submit]").click();
await page.waitForTimeout(300);

// 今月はボーナス月: 予定 = 250,000 + 250,000*2 = 750,000
let incomePA = await txt("#income-plan-actual");
console.log("income plan/actual (bonus month):", incomePA);
if (!incomePA.includes("¥750,000")) throw new Error("bonus month plan wrong: " + incomePA);
if (!incomePA.includes("¥300,000")) throw new Error("income actual wrong: " + incomePA);
// 注記に金額が入る
const note = await txt("#bonus-note");
if (!note.includes(`${CUR_M}月`) || !note.includes("¥500,000")) {
  throw new Error("bonus note wrong: " + note);
}

// ---------------------------------------------------------------------------
// 6. 年間表示: 目標は経過月数で按分、賞与は到来済みの分だけ
// ---------------------------------------------------------------------------
await page.click('.view-tab[data-view="year"]');
await page.waitForTimeout(400);
if ((await txt("#budget-section-title")) !== "今年の予算") throw new Error("year title wrong");

const yearBudget = await txt("#budget-overall");
const expectBudget = `¥${(120000 * ELAPSED).toLocaleString("en-US")}`;
console.log("year budget:", yearBudget, "elapsed:", ELAPSED);
if (!yearBudget.includes(expectBudget)) {
  throw new Error(`year budget should be prorated to ${expectBudget}: ` + yearBudget);
}

const yearIncome = await txt("#income-plan-actual");
const expectIncome = `¥${(250000 * ELAPSED + 500000).toLocaleString("en-US")}`;
if (!yearIncome.includes(expectIncome)) {
  throw new Error(`year income plan should be ${expectIncome}: ` + yearIncome);
}

// 月別の収支推移グラフは年間表示のときだけ出る
if (!(await page.locator("#yearly-chart-section").isVisible())) {
  throw new Error("the monthly bar chart should appear in the yearly view");
}
const bars = await page.locator("#monthly-bar-chart .month-bar-group").count();
if (bars !== 12) throw new Error("expected 12 month groups, got " + bars);
const axisLabels = await page.locator("#monthly-bar-yaxis > *").count();
if (axisLabels < 2) throw new Error("the y-axis should show amount labels, got " + axisLabels);

// ---------------------------------------------------------------------------
// 7. 未来の年へ移動しても、設定済みの予算が「未設定」にならない
// ---------------------------------------------------------------------------
await page.click("#next-month");
await page.waitForTimeout(400);
if ((await txt("#current-month")) !== `${CUR_Y + 1}年`) throw new Error("should move to next year");
const futureBudget = await txt("#budget-overall");
if (!futureBudget.includes(`¥${(120000 * 12).toLocaleString("en-US")}`)) {
  throw new Error("a future year should show the full-year target: " + futureBudget);
}
if ((await txt("#budget-breakdown")).includes("予算未設定")) {
  throw new Error("budgeted categories must not read 予算未設定 in a future year");
}
if ((await txt("#expense-plan-actual")).includes("設定されていません")) {
  throw new Error("must not claim the budget is unset in a future year");
}

// 過去の年は12か月分のまま
await page.click("#prev-month");
await page.click("#prev-month");
await page.waitForTimeout(400);
if ((await txt("#current-month")) !== `${CUR_Y - 1}年`) throw new Error("should move to last year");
if (!(await txt("#budget-overall")).includes(`¥${(120000 * 12).toLocaleString("en-US")}`)) {
  throw new Error("a past year should use the full 12 months: " + (await txt("#budget-overall")));
}

await page.click('.view-tab[data-view="month"]');
await page.waitForTimeout(300);

await page.screenshot({ path: path.join(scratch, "aggregation.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL AGGREGATION CHECKS PASSED");
await browser.close();
server.close();

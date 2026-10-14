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
// 2. 立替は自分のお金の出入りに数えない (返ってくる権利として持つ)
// ---------------------------------------------------------------------------
// 支出に数えると、立て替えた月は赤字、返ってきた月は黒字に見えてしまう
await addExpense({ date: `${CUR_Y}-${MM}-10`, category: "交通", amount: 30000, memo: "出張の新幹線", advance: true });
await page.click("#today-btn");
await page.waitForTimeout(300);
if ((await txt("#advance-outstanding-total")) !== "¥30,000") throw new Error("outstanding wrong");
if ((await txt("#total-expense")) !== "¥0") throw new Error("立替は支出に数えない: " + (await txt("#total-expense")));
if ((await txt("#balance")) !== "¥0") throw new Error("収支も動かない: " + (await txt("#balance")));
if ((await txt("#cumulative-savings")) !== "¥0") throw new Error("累計も動かない: " + (await txt("#cumulative-savings")));
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
if ((await txt("#total-income")) !== "¥0") throw new Error("返金は収入に数えない: " + (await txt("#total-income")));
if ((await txt("#balance")) !== "¥0") throw new Error("収支は0のまま: " + (await txt("#balance")));
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
// 立替 (交通 = Need) は自分が使ったお金ではないので、Need の実績にも入らない
if (!nws.includes("¥0 / ¥100,000")) {
  throw new Error("立替を Need の支出に数えてはいけない: " + nws);
}
// 予算にも数えない (会社の出張費で自分の交通費の予算を使い切ったことにならない)
await page.click("#edit-budget-btn");
await page.waitForTimeout(200);
await page.fill("#budget-input-交通", "10000");
await page.locator("#budget-form button[type=submit]").click();
await page.waitForTimeout(300);
const budget = await txt("#budget-section");
if (budget.includes("¥30,000")) throw new Error("立替を予算の実績に数えてはいけない: " + budget);

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

// ---------------------------------------------------------------------------
// 9. 一部しか返ってこなかったときは、差額が自分の負担として残る
// ---------------------------------------------------------------------------
// (この時点で今月の記録は無い)
await addExpense({ date: `${CUR_Y}-${MM}-12`, category: "交際費", amount: 20000, memo: "会食の立替", advance: true });
await page.click("#today-btn");
await page.waitForTimeout(300);
await page.locator(".advance-row", { hasText: "会食の立替" }).locator("button", { hasText: "精算" }).click();
await page.waitForTimeout(300);
await page.fill("#advance-settle-date", `${CUR_Y}-${MM}-27`);
await page.click("#advance-settle-confirm");
await page.waitForTimeout(500);
if ((await txt("#total-expense")) !== "¥0" || (await txt("#total-income")) !== "¥0") {
  throw new Error("同額で精算した組は収入にも支出にも出ない");
}
// 返ってきたのは 15,000 だけだった → 5,000 は自分の負担
await page.locator("#entry-list tr", { hasText: "立替金精算: 会食の立替" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(400);
await page.fill("#entry-amount", "15000");
await page.click("#submit-btn");
await page.waitForTimeout(500);
await page.click("#today-btn");
await page.waitForTimeout(300);
console.log("一部返金:", await txt("#total-expense"), await txt("#total-income"), await txt("#balance"));
if ((await txt("#balance")) !== "-¥5,000") {
  throw new Error("差額の5,000円が自分の負担として残るはず: " + (await txt("#balance")));
}

// ---------------------------------------------------------------------------
// 10. 立替と結びついていない「立替金返金」は、今までどおり収入に数える
// ---------------------------------------------------------------------------
// (立替の印を付けずに記録した支出を、手で入れた返金で相殺している場合がある)
await page.click('.type-option:has(input[value="income"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-27`);
await page.selectOption("#entry-category", "立替金返金");
await page.fill("#entry-amount", "3000");
await page.fill("#entry-memo", "手で入れた返金");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await page.click("#today-btn");
await page.waitForTimeout(300);
if ((await txt("#balance")) !== "-¥2,000") {
  throw new Error("結びついていない返金は収入に数えるはず: " + (await txt("#balance")));
}

await page.screenshot({ path: path.join(scratch, "advance.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL ADVANCE (立替金) CHECKS PASSED");
await browser.close();
server.close();

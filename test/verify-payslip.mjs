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
await new Promise((r) => server.listen(8993, r));

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
const txt = async (sel) => (await page.textContent(sel)).trim();

await page.goto("http://localhost:8993/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "payslip-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// 1. 内訳の入力欄は「給与」「賞与」のときだけ出る
// ---------------------------------------------------------------------------
if (await page.locator("#payslip-section").isVisible()) {
  throw new Error("the payslip section should be hidden for 支出");
}
await page.click('.type-option:has(input[value="income"]) span');
await page.selectOption("#entry-category", "副収入");
await page.waitForTimeout(150);
if (await page.locator("#payslip-section").isVisible()) {
  throw new Error("the payslip section should stay hidden for 副収入");
}
await page.selectOption("#entry-category", "給与");
await page.waitForTimeout(150);
if (!(await page.locator("#payslip-section").isVisible())) {
  throw new Error("the payslip section should appear for 給与");
}

// ---------------------------------------------------------------------------
// 2. 給与: 支給合計 − 控除合計 = 手取りが自動計算され、金額欄に入る
// ---------------------------------------------------------------------------
await page.click("#payslip-toggle-btn");
await page.waitForTimeout(200);
if (!(await page.locator("#payslip-salary-fields").isVisible())) {
  throw new Error("the salary fields should be shown for 給与");
}
if (await page.locator("#payslip-bonus-fields").isVisible()) {
  throw new Error("the bonus fields should be hidden for 給与");
}

// 給与明細の形 (支給・控除の内訳) どおりに入れて、差引支給額が合うことを確かめる。
// 金額は架空のもの
await page.fill("#payslip-base-salary", "250000");
await page.fill("#payslip-location-allowance", "10000");
await page.fill("#payslip-commute", "20000");
await page.fill("#payslip-overtime-pay", "8000");
await page.fill("#payslip-salary-adjustment", "100");
// 控除。会社独自の小額の項目 (慶弔掛金・福祉会費・組合費など) は
// その他控除にまとめる
await page.fill("#payslip-housing", "15000");
await page.fill("#payslip-health-insurance", "12000");
await page.fill("#payslip-nursing-insurance", "0");
await page.fill("#payslip-child-support", "300");
await page.fill("#payslip-pension-insurance", "25000");
await page.fill("#payslip-employment-insurance", "1500");
await page.fill("#payslip-income-tax", "6000");
await page.fill("#payslip-resident-tax", "10000");
await page.fill("#payslip-other-deductions", "3000");
await page.waitForTimeout(300);

// 支給 288,100 / 控除 72,800 / 差引支給額 215,300
if ((await txt("#payslip-gross-value")) !== "¥288,100") {
  throw new Error("gross wrong: " + (await txt("#payslip-gross-value")));
}
if ((await txt("#payslip-deduction-value")) !== "¥72,800") {
  throw new Error("deductions wrong: " + (await txt("#payslip-deduction-value")));
}
if ((await txt("#payslip-net-value")) !== "¥215,300") {
  throw new Error("net wrong: " + (await txt("#payslip-net-value")));
}
// 家賃は「受け取って払った」形にするので、収入の金額は振込額+寮社宅費
if ((await page.locator("#entry-amount").inputValue()) !== "230300") {
  throw new Error(
    "the amount should be the deposit plus the rent, got " +
      (await page.locator("#entry-amount").inputValue())
  );
}
// なぜ振込額と違うのかがその場に書いてある
const housingNote = await txt("#payslip-housing-note");
if (!housingNote.includes("¥15,000") || !housingNote.includes("¥230,300")) {
  throw new Error("the rent note should explain the amount: " + housingNote);
}

await page.fill("#entry-date", `${CUR_Y}-${MM}-25`);
await page.fill("#entry-memo", "今月の給与");
await page.click("#submit-btn");
await page.waitForTimeout(500);
await page.click("#today-btn");
await page.waitForTimeout(300);

// 家賃は「支出・住居」として自動で記録される
const housingRow = page.locator("#entry-list tr", { hasText: "給与天引き: 寮社宅費" });
if ((await housingRow.count()) !== 1) throw new Error("the rent should be recorded as an expense");
const housingText = await housingRow.textContent();
if (!housingText.includes("住居") || !housingText.includes("¥15,000")) {
  throw new Error("the rent expense is wrong: " + housingText);
}

// 収入 230,300 / 支出 15,000 / 収支 215,300 (= 実際に増えたお金)
if ((await txt("#total-income")) !== "¥230,300") {
  throw new Error("income wrong: " + (await txt("#total-income")));
}
if ((await txt("#total-expense")) !== "¥15,000") {
  throw new Error("expense wrong: " + (await txt("#total-expense")));
}
if ((await txt("#balance")) !== "¥215,300") {
  throw new Error("the balance should equal the actual deposit: " + (await txt("#balance")));
}

// ---------------------------------------------------------------------------
// 3. 内訳ポップアップで見返せる
// ---------------------------------------------------------------------------
const salaryRow = page.locator("#entry-list tr", { hasText: "今月の給与" });
await salaryRow.locator("button", { hasText: "内訳" }).click();
await page.waitForTimeout(300);
if (!(await page.locator("#payslip-detail-modal").isVisible())) {
  throw new Error("the breakdown popup should open");
}
const detail = await txt("#payslip-detail-content");
console.log("detail:", detail);
for (const expected of ["¥250,000", "¥10,000", "¥20,000", "¥15,000", "¥300", "¥288,100", "¥72,800", "¥215,300", "¥230,300"]) {
  if (!detail.includes(expected)) throw new Error(`breakdown missing ${expected}: ` + detail);
}
await page.click("#payslip-detail-close");
await page.waitForTimeout(250);
if (await page.locator("#payslip-detail-modal").isVisible()) {
  throw new Error("the × should close the breakdown popup");
}

// ---------------------------------------------------------------------------
// 4. 賞与は項目が切り替わる (住民税が無く、子ども支援金がある)
// ---------------------------------------------------------------------------
await page.click('.type-option:has(input[value="income"]) span');
await page.selectOption("#entry-category", "賞与");
await page.waitForTimeout(200);
await page.click("#payslip-toggle-btn");
await page.waitForTimeout(200);
if (!(await page.locator("#payslip-bonus-fields").isVisible())) {
  throw new Error("the bonus fields should show for 賞与");
}
if (await page.locator("#payslip-salary-fields").isVisible()) {
  throw new Error("the salary fields should be hidden for 賞与");
}
if ((await page.locator("#payslip-bonus-child-support").count()) !== 1) {
  throw new Error("賞与 should have a 子ども支援金 field");
}

await page.fill("#payslip-bonus-amount", "130000");
await page.fill("#payslip-bonus-health-insurance", "5924");
await page.fill("#payslip-bonus-child-support", "149");
await page.fill("#payslip-bonus-pension-insurance", "11895");
await page.fill("#payslip-bonus-employment-insurance", "650");
await page.fill("#payslip-bonus-income-tax", "4548");
await page.waitForTimeout(300);

// 支給 130,000 / 控除 23,166 / 手取り 106,834
if ((await txt("#payslip-net-value")) !== "¥106,834") {
  throw new Error("bonus net wrong: " + (await txt("#payslip-net-value")));
}
await page.fill("#entry-date", `${CUR_Y}-${MM}-10`);
await page.fill("#entry-memo", "夏の賞与");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await page.click("#today-btn");
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// 5. 編集で開くと内訳が復元され、ポップアップの中で編集できる
// ---------------------------------------------------------------------------
const bonusRow = page.locator("#entry-list tr", { hasText: "夏の賞与" });
await bonusRow.locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(400);
if (!(await page.locator("#entry-edit-modal").isVisible())) {
  throw new Error("editing should open the popup");
}
if ((await page.locator("#payslip-bonus-amount").inputValue()) !== "130000") {
  throw new Error("the bonus breakdown should be restored");
}
if (!(await page.locator("#payslip-bonus-fields").isVisible())) {
  throw new Error("the bonus fields should be visible when editing a 賞与 entry");
}
await page.click("#cancel-edit-btn");
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// 6. 内訳をクリアすると金額の自動反映も止まる
// ---------------------------------------------------------------------------
await page.click('.type-option:has(input[value="income"]) span');
await page.selectOption("#entry-category", "給与");
await page.waitForTimeout(200);
await page.click("#payslip-toggle-btn");
await page.waitForTimeout(200);
await page.fill("#payslip-base-salary", "200000");
await page.waitForTimeout(250);
if ((await page.locator("#entry-amount").inputValue()) !== "200000") {
  throw new Error("the amount should follow the breakdown");
}
await page.click("#payslip-clear-btn");
await page.waitForTimeout(250);
if ((await page.locator("#payslip-base-salary").inputValue()) !== "") {
  throw new Error("clearing should empty the breakdown fields");
}

// ---------------------------------------------------------------------------
// 7. 家賃の支出は給与の記録と連動する (幽霊レコードを残さない)
// ---------------------------------------------------------------------------
const salaryRowAgain = page.locator("#entry-list tr", { hasText: "今月の給与" });

// 金額を変えると、対になる住居の支出も追従する
await salaryRowAgain.locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(400);
if ((await page.locator("#payslip-housing").inputValue()) !== "15000") {
  throw new Error("the rent should be restored when editing");
}
await page.fill("#payslip-housing", "20000");
await page.waitForTimeout(300);
await page.click("#submit-btn");
await page.waitForTimeout(600);
await page.click("#today-btn");
await page.waitForTimeout(300);

let rentRow = page.locator("#entry-list tr", { hasText: "給与天引き: 寮社宅費" });
if ((await rentRow.count()) !== 1) throw new Error("there should still be exactly one rent expense");
if (!(await rentRow.textContent()).includes("¥20,000")) {
  throw new Error("the rent expense should follow the payslip: " + (await rentRow.textContent()));
}
if ((await txt("#total-expense")) !== "¥20,000") {
  throw new Error("expense total should follow: " + (await txt("#total-expense")));
}

// 家賃を0にすると、対になる支出は消える
await page.locator("#entry-list tr", { hasText: "今月の給与" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(400);
await page.fill("#payslip-housing", "0");
await page.waitForTimeout(300);
await page.click("#submit-btn");
await page.waitForTimeout(600);
await page.click("#today-btn");
await page.waitForTimeout(300);
if ((await page.locator("#entry-list tr", { hasText: "給与天引き: 寮社宅費" }).count()) !== 0) {
  throw new Error("clearing the rent should remove the linked expense");
}

// 戻して、今度は給与そのものを削除する -> 家賃の支出も一緒に消える
await page.locator("#entry-list tr", { hasText: "今月の給与" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(400);
await page.fill("#payslip-housing", "15000");
await page.waitForTimeout(300);
await page.click("#submit-btn");
await page.waitForTimeout(600);
await page.click("#today-btn");
await page.waitForTimeout(300);
if ((await page.locator("#entry-list tr", { hasText: "給与天引き: 寮社宅費" }).count()) !== 1) {
  throw new Error("the rent expense should come back");
}

const cumulativeBefore = await txt("#cumulative-savings");
await page.locator("#entry-list tr", { hasText: "今月の給与" }).locator("button", { hasText: "削除" }).click();
await page.waitForTimeout(700);
if ((await page.locator("#entry-list tr", { hasText: "給与天引き: 寮社宅費" }).count()) !== 0) {
  throw new Error("deleting the salary must also delete the rent expense");
}
// 両方消えたので、累計は「収入230,300 − 支出15,000 = 215,300」ちょうど減る。
// 家賃の支出だけが残ると、減り方が15,000円足りなくなる
const cumulativeAfter = await txt("#cumulative-savings");
const yen = (t) => Number(t.replace(/[¥,]/g, ""));
console.log("cumulative:", cumulativeBefore, "->", cumulativeAfter);
if (yen(cumulativeBefore) - yen(cumulativeAfter) !== 215300) {
  throw new Error(
    `deleting the salary should remove exactly its net effect ` +
      `(${cumulativeBefore} -> ${cumulativeAfter})`
  );
}

await page.screenshot({ path: path.join(scratch, "payslip.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL PAYSLIP CHECKS PASSED");
await browser.close();
server.close();

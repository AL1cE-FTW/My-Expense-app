// 「前回の明細を引き継ぐ」を確認する。
// 本給・手当・寮社宅費・社会保険料は毎月ほぼ同じなので、前回の値を入れて
// 変わった欄だけ直せば済むようにしている。
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
await new Promise((r) => server.listen(8984, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

const NOW = new Date();
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const PREV = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 25);
const THIS = new Date(NOW.getFullYear(), NOW.getMonth(), 25);

await page.goto("http://localhost:8984/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "copy-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

const chooseSalary = async (date, category = "給与") => {
  await page.click('.type-option:has(input[value="income"]) span');
  await page.selectOption("#entry-category", category);
  await page.fill("#entry-date", date);
  await page.waitForTimeout(150);
};

// ---------------------------------------------------------------------------
// 1. 前回の明細が無いときはボタンを出さない
// ---------------------------------------------------------------------------
await chooseSalary(ymd(PREV));
if (await page.locator("#payslip-copy-prev-btn").isVisible()) {
  throw new Error("前回の明細が無いのにボタンが出ている");
}

// ---------------------------------------------------------------------------
// 2. 先月分を内訳つきで入れる
// ---------------------------------------------------------------------------
await page.click("#payslip-toggle-btn");
await page.waitForTimeout(150);
const PREV_VALUES = {
  "#payslip-base-salary": "250000",
  "#payslip-location-allowance": "10000",
  "#payslip-commute": "20000",
  "#payslip-overtime-pay": "30000",
  "#payslip-housing": "15000",
  "#payslip-health-insurance": "12000",
  "#payslip-child-support": "300",
  "#payslip-pension-insurance": "25000",
  "#payslip-employment-insurance": "1500",
  "#payslip-income-tax": "6000",
  "#payslip-resident-tax": "10000",
  "#payslip-other-deductions": "3000",
};
for (const [sel, v] of Object.entries(PREV_VALUES)) await page.fill(sel, v);
await page.fill("#entry-memo", "先月の給与");
// 支給 310,000 − 控除 72,800 = 振込 237,200。記録の金額は 振込 + 寮社宅費
if ((await page.inputValue("#entry-amount")) !== "252200") {
  throw new Error("先月分の金額: " + (await page.inputValue("#entry-amount")));
}
await page.click("#submit-btn");
await page.waitForTimeout(500);

// ---------------------------------------------------------------------------
// 3. 今月分: ボタンが出て、押すと前回の値が入る
// ---------------------------------------------------------------------------
await chooseSalary(ymd(THIS));
const btn = page.locator("#payslip-copy-prev-btn");
if (!(await btn.isVisible())) throw new Error("前回の明細があるのにボタンが出ていない");
const label = (await btn.textContent()).trim();
console.log("ボタン:", label);
if (!label.includes(`${PREV.getMonth() + 1}/25`)) {
  throw new Error("前回の日付をボタンに出すはず: " + label);
}

await btn.click();
await page.waitForTimeout(200);
if (!(await page.locator("#payslip-breakdown").isVisible())) {
  throw new Error("押したら内訳が開くはず");
}
for (const [sel, v] of Object.entries(PREV_VALUES)) {
  const got = await page.inputValue(sel);
  if (got !== v) throw new Error(`${sel} に前回の値が入っていない: ${got} (期待 ${v})`);
}
// 金額も前回と同じ計算で自動で入る
if ((await page.inputValue("#entry-amount")) !== "252200") {
  throw new Error("引き継いだら金額も計算されるはず: " + (await page.inputValue("#entry-amount")));
}
const note = await page.textContent("#payslip-copy-note");
if (!note.includes("変わった欄")) throw new Error("何を直せばいいか案内するはず: " + note);

// 変わった欄だけ直す: 残業代 30,000 → 18,000
await page.fill("#payslip-overtime-pay", "18000");
await page.waitForTimeout(100);
if ((await page.inputValue("#entry-amount")) !== "240200") {
  throw new Error("直した値で計算し直すはず: " + (await page.inputValue("#entry-amount")));
}

// ---------------------------------------------------------------------------
// 4. 入力済みの欄があるときは上書き前に確認する
// ---------------------------------------------------------------------------
dialogs.length = 0;
await btn.click();
await page.waitForTimeout(200);
if (!dialogs.some((m) => m.includes("上書き"))) {
  throw new Error("入力済みを黙って上書きしてはいけない: " + dialogs.join(" / "));
}
// (確認で OK したので前回の値に戻っている)
if ((await page.inputValue("#payslip-overtime-pay")) !== "30000") {
  throw new Error("OKしたら前回の値で上書きされるはず");
}
await page.fill("#payslip-overtime-pay", "18000");
await page.fill("#entry-memo", "今月の給与");
await page.click("#submit-btn");
await page.waitForTimeout(500);
await page.click("#today-btn");
await page.waitForTimeout(400);

// 保存された: 金額と、寮社宅費の住居の支出も今月分として自動で立つ
const list = (await page.textContent("#entry-list")).replace(/\s+/g, " ");
if (!list.includes("今月の給与") || !list.includes("¥240,200")) {
  throw new Error("今月分が保存されていない: " + list);
}
if (!list.includes("給与天引き")) throw new Error("引き継いだ寮社宅費の住居の支出も立つはず: " + list);

// ---------------------------------------------------------------------------
// 5. 賞与は賞与からしか引き継がない (給与の値を賞与の欄に入れない)
// ---------------------------------------------------------------------------
await chooseSalary(ymd(THIS), "賞与");
if (await page.locator("#payslip-copy-prev-btn").isVisible()) {
  throw new Error("賞与の前回が無いのに、給与の明細を引き継ごうとしている");
}

// ---------------------------------------------------------------------------
// 6. 編集中の記録自身は引き継ぎ元にしない
// ---------------------------------------------------------------------------
await page.click("#cancel-edit-btn").catch(() => {});
await page.locator("#entry-list tr", { hasText: "今月の給与" }).locator('button:has-text("編集")').click();
await page.waitForTimeout(400);
const editLabel = (await page.locator("#payslip-copy-prev-btn").textContent()).trim();
console.log("編集中のボタン:", editLabel);
if (!editLabel.includes(`${PREV.getMonth() + 1}/25`)) {
  throw new Error("編集中は自分ではなく前回を指すはず: " + editLabel);
}

await page.screenshot({ path: path.join(scratch, "payslip-copy.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL PAYSLIP COPY CHECKS PASSED");
await browser.close();
server.close();

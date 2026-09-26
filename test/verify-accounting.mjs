// 家計簿・帳簿として数字が実態とずれないかを通しで確かめる。
//   A. カードの返品は収入ではなく支出の取り消し (予算・Need/Want からも減る)
//   B. 別の月の返品でもグラフが壊れない
//   C. 振替 (ATM) は収入にも支出にも数えず、帳簿で現金と口座を入れ替える
//   D. 分割払いは毎月少しずつ口座から落ちる
//   E. カード明細の最初の日と、メールの仮の記録の日付が1日ずれても二重にしない
//   F. 天引きの家賃の支出だけを消したり直したりさせない
//   G. 年末調整の還付 (所得税のマイナス) を入れられる
//   H. どの場面でも、損益計算書の当期純利益と上の「収支」が一致する
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
  const p = path.join(root, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  try {
    const data = fs.readFileSync(p);
    res.writeHead(200, { "content-type": mime[path.extname(p)] || "text/plain" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("nf");
  }
});
await new Promise((r) => server.listen(8979, r));

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

const assert = (cond, message) => { if (!cond) throw new Error(message); };
const pad = (n) => String(n).padStart(2, "0");
const NOW = new Date();
const Y = NOW.getFullYear();
const MM = pad(NOW.getMonth() + 1);
const PREV = new Date(Y, NOW.getMonth() - 1, 1);
const PY = PREV.getFullYear();
const PM = pad(PREV.getMonth() + 1);
const PREV_LAST = new Date(Y, NOW.getMonth(), 0).getDate();
const EMAIL = "accounting@example.com";
const UID = "uid-" + EMAIL;

await page.goto("http://localhost:8979/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", EMAIL);
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(400);

const txt = async (sel) => (await page.textContent(sel)).replace(/\s+/g, " ").trim();
const bookText = async (view) => {
  await page.click(`.book-tab[data-book="${view}"]`);
  await page.waitForTimeout(250);
  return (await page.textContent("#bookkeeping-body")).replace(/\s+/g, " ").trim();
};
const today = async () => { await page.click("#today-btn"); await page.waitForTimeout(400); };
const importCsv = async (name, lines) => {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, lines.join("\n"), "utf-8");
  await page.setInputFiles("#import-csv-input", p);
  await page.waitForTimeout(800);
};
// 損益計算書の当期純利益は、上の「収支」と必ず一致する (見方を変えただけ)
const assertPlMatchesBalance = async (where) => {
  const pl = await bookText("pl");
  const balance = await txt("#balance");
  const net = pl.match(/当期純利益(-?¥[\d,]+)/)?.[1] ?? "¥0";
  assert(net === balance, `${where}: 当期純利益 ${net} と収支 ${balance} が食い違う\n${pl}`);
};
const CARD_HEAD = "見本　太郎　様,1234-56**-****-****,Ｏｌｉｖｅ／クレジット";

// ---------------------------------------------------------------------------
// A. カードの返品は収入ではなく、支出の取り消し
// ---------------------------------------------------------------------------
await page.click("#edit-budget-btn");
await page.fill("#budget-input-趣味・娯楽", "20000");
await page.fill("#budget-input-衣服・美容", "10000");
await page.locator("#budget-form button[type=submit]").click();
await page.waitForTimeout(300);

await importCsv("acc-refund.csv", [
  CARD_HEAD,
  `${Y}/${MM}/05,ＢＯＯＴＨ,30000,１,１,30000,`,
  `${Y}/${MM}/08,ＢＯＯＴＨ,-30000,１,１,-30000,`,
]);
await today();
assert((await txt("#total-income")) === "¥0", "返品を収入に数えてはいけない: " + (await txt("#total-income")));
assert((await txt("#total-expense")) === "¥0", "買って全額返品したら支出は0: " + (await txt("#total-expense")));
const budgetA = await txt("#budget-section");
assert(budgetA.includes("趣味・娯楽0%¥0 / ¥20,000"), "返品した分は予算の実績から減る: " + budgetA);
const plA = await bookText("pl");
assert(!plA.includes("カード返金"), "返品を収益に立ててはいけない: " + plA);
await assertPlMatchesBalance("A");
console.log("A 返品: OK");

// 収入を入れると、Need/Want/Save の Save が上の収支と揃う
// (以前は返品した支出だけ Want に残り、Save が返品額ぶん少なく出ていた)
await page.click('.type-option:has(input[value="income"]) span');
await page.fill("#entry-date", `${Y}-${MM}-25`);
await page.selectOption("#entry-category", "副収入");
await page.fill("#entry-amount", "300000");
await page.fill("#entry-memo", "収入");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await today();
const nws = await txt("#nws-legend");
assert(nws.includes("Save 20%¥300,000 /"), "Save は実際に残った額 (=収支) のはず: " + nws);

// ---------------------------------------------------------------------------
// B. 先月買って今月返品した場合 + D. 分割払い
// ---------------------------------------------------------------------------
await importCsv("acc-prev.csv", [
  CARD_HEAD,
  `${PY}/${PM}/20,ユニクロ,5000,１,１,5000,`,
  // 3回払い: 利用金額 30,000、今回支払金額 10,000
  `${PY}/${PM}/10,ヤマダデンキ,30000,３,１,10000,`,
  `${Y}/${MM}/03,ユニクロ,-5000,１,１,-5000,`,
]);
await today();
// 今月は返品だけがあるので、支出はマイナス (戻ってきた月)
assert((await txt("#total-expense")) === "-¥5,000", "今月は返品の分だけ支出が減る: " + (await txt("#total-expense")));
assert((await txt("#balance")) === "¥305,000", "収支: " + (await txt("#balance")));
// 実績がマイナスでも予算バーが壊れない (幅がマイナスだと全幅に見えてしまう)
const barWidth = await page.evaluate(() => document.querySelector("#budget-overall .budget-bar")?.style.width);
assert(barWidth === "0%", "実績がマイナスのときの予算バーは0%: " + barWidth);
await assertPlMatchesBalance("B");
console.log("B 別の月の返品: OK");

// ---------------------------------------------------------------------------
// E. メールでは先月末、明細では今月1日 (明細の最初の日) の取引を二重にしない
// ---------------------------------------------------------------------------
await page.evaluate(({ uid, date }) => {
  window.__seedDoc(`users/${uid}/entries/pending-edge`, {
    date, type: "expense", category: "食費", amount: 700, memo: "ﾛｰｿﾝ",
    source: "gmail", createdAt: new Date().toISOString(),
  });
}, { uid: UID, date: `${PY}-${PM}-${pad(PREV_LAST)}` });
await page.waitForTimeout(300);
dialogs.length = 0;
await importCsv("acc-edge.csv", [
  CARD_HEAD,
  `${Y}/${MM}/01,ローソン,700,１,１,700,`,
  `${Y}/${MM}/15,ファミリーマート,300,１,１,300,`,
]);
const edgeMsg = dialogs.find((m) => m.includes("確定明細")) || "";
assert(edgeMsg.includes("仮の記録 1件を確定版に更新"), "境目の仮の記録も突き合わせるはず: " + dialogs.join(" / "));
await today();
const lawson = await page.locator("#entry-list tr", { hasText: "ﾛｰｿﾝ" }).count();
assert(lawson === 1, "今月に1件だけ (二重にならない): " + lawson);
console.log("E 日付の境目: OK");

// ---------------------------------------------------------------------------
// C. 振替 (ATMで引き出し) と、貸借対照表の現金・口座
// ---------------------------------------------------------------------------
await page.click("#edit-accounts-btn");
await page.waitForTimeout(200);
await page.fill("#accounts-opening-date", `${PY}-${PM}-01`);
await page.fill("#account-input-現金", "10000");
await page.fill("#account-input-銀行口座", "500000");
await page.selectOption("#card-closing-day", "31");
await page.selectOption("#card-payment-months", "1");
await page.selectOption("#card-payment-day", "26");
await page.click("#accounts-form button[type=submit]");
await page.waitForTimeout(400);

const balanceBefore = await txt("#balance");
const nwsBefore = await txt("#nws-legend");
await page.click('.type-option:has(input[value="transfer"]) span');
assert(!(await page.locator("#entry-settlement-group").isVisible()), "振替では口座の選択を出さない (向きはカテゴリで決まる)");
await page.fill("#entry-date", `${Y}-${MM}-10`);
await page.selectOption("#entry-category", "ATMで引き出し");
await page.fill("#entry-amount", "20000");
await page.fill("#entry-memo", "ATM");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await today();
assert((await txt("#balance")) === balanceBefore, "振替は収支を動かさない");
assert((await txt("#nws-legend")) === nwsBefore, "振替は Need/Want/Save も動かさない: " + (await txt("#nws-legend")));
const atmRow = await txt('#entry-list tr:has-text("ATM")');
assert(atmRow.includes("振替") && atmRow.includes("¥20,000") && !atmRow.includes("-¥20,000"),
  "一覧では振替として、符号なしで出す: " + atmRow);

const bs = await bookText("bs");
console.log("B/S:", bs);
// 現金 = 10,000 + ATM 20,000
assert(bs.includes("現金¥30,000"), "ATMで下ろした分だけ現金が増える: " + bs);
// 口座 = 500,000 + 収入 300,000 − ATM 20,000 − 先月のユニクロ 5,000 − 分割の1回目 10,000
assert(bs.includes("銀行口座¥765,000"), "口座の残高: " + bs);
// 未払金 = 分割の残り 20,000 + ローソン 700 + ファミリーマート 300 − 今月の返品 5,000
// (BOOTH は買って返品で0。分割を一度に落とすと、ここが −4,000 になる)
assert(bs.includes("未払金¥16,000"), "分割は残りが未払金に残る: " + bs);
const journal = await bookText("journal");
assert(/ATM.*現金¥20,000.*銀行口座¥20,000/.test(journal), "振替は (借)現金 / (貸)銀行口座: " + journal);
// 今月26日の引き落としは ユニクロ 5,000 + 分割の1回目 10,000 (全額 30,000 ではない)
assert(journal.includes("カードの引き落とし") && journal.includes("¥15,000"), "分割は1回分ずつ落ちる: " + journal);
await assertPlMatchesBalance("C");
console.log("C 振替 / D 分割: OK");

// ---------------------------------------------------------------------------
// F. 天引きの家賃の支出 / G. 年末調整の還付
// ---------------------------------------------------------------------------
await page.click('.type-option:has(input[value="income"]) span');
await page.selectOption("#entry-category", "給与");
await page.fill("#entry-date", `${Y}-${MM}-26`);
await page.click("#payslip-toggle-btn");
await page.fill("#payslip-base-salary", "200000");
await page.fill("#payslip-housing", "10000");
// 年末調整で 15,000 円戻ってきた (所得税がマイナス)。入力できないと手取りが合わない
await page.fill("#payslip-income-tax", "-15000");
await page.waitForTimeout(150);
// 手取り = 200,000 − (10,000 − 15,000) = 205,000。記録は 手取り + 寮社宅費
assert((await page.inputValue("#entry-amount")) === "215000", "年調還付を含めた金額: " + (await page.inputValue("#entry-amount")));
await page.fill("#entry-memo", "12月の給与");
await page.click("#submit-btn");
await page.waitForTimeout(500);
await today();
assert((await page.locator("#entry-list tr", { hasText: "12月の給与" }).count()) === 1, "マイナスの所得税でも保存できるはず");
const plG = await bookText("pl");
assert(plG.includes("租税公課-¥15,000"), "還付は租税公課のマイナス (費用の取り消し): " + plG);
await assertPlMatchesBalance("G");

// 家賃の支出だけを消そうとしても消えない (給与の側で直す)
dialogs.length = 0;
await page.locator("#entry-list tr", { hasText: "給与天引き" }).locator("button", { hasText: "削除" }).click();
await page.waitForTimeout(400);
assert(dialogs.some((m) => m.includes("自動で作られています")), "消せない理由を伝えるはず: " + dialogs.join(" / "));
assert((await page.locator("#entry-list tr", { hasText: "給与天引き" }).count()) === 1, "家賃の支出だけ消えてはいけない");
// 直そうとすると、給与の記録が開く
dialogs.length = 0;
await page.locator("#entry-list tr", { hasText: "給与天引き" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(500);
assert((await page.inputValue("#entry-category")) === "給与", "給与の記録を開くはず");
assert((await page.inputValue("#payslip-housing")) === "10000", "寮社宅費を直せる状態で開くはず");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
console.log("F 家賃 / G 年調還付: OK");

// ---------------------------------------------------------------------------
// 表記: 「今月の貯蓄額」は実際には収支なので「今月の収支」と書く
// ---------------------------------------------------------------------------
assert((await txt("#cumulative-change")).startsWith("今月の収支"), "今月の収支と書くはず: " + (await txt("#cumulative-change")));

await page.screenshot({ path: path.join(scratch, "accounting.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL ACCOUNTING CHECKS PASSED");
await browser.close();
server.close();

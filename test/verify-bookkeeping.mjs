// 帳簿 (簿記の見方) を確認する。
// 単式で入力した記録から仕訳を組み立て、そこから合計試算表と損益計算書を出す。
// 入力の手間は増やさないので、既存の記録がそのまま材料になる。
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
await new Promise((r) => server.listen(8988, r));

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
page.on("dialog", (d) => d.accept());

const NOW = new Date();
const CUR_Y = NOW.getFullYear();
const MM = String(NOW.getMonth() + 1).padStart(2, "0");

await page.goto("http://localhost:8988/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "book-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

const bookText = async (view) => {
  await page.click(`.book-tab[data-book="${view}"]`);
  await page.waitForTimeout(250);
  return (await page.textContent("#bookkeeping-body")).replace(/\s+/g, " ").trim();
};

// --- 材料をそろえる -------------------------------------------------------
// 現金の支出
await page.fill("#entry-date", `${CUR_Y}-${MM}-05`);
await page.selectOption("#entry-category", "食費");
await page.fill("#entry-amount", "3000");
await page.fill("#entry-memo", "現金でスーパー");
await page.click("#submit-btn");
await page.waitForTimeout(200);

// 貯蓄・投資 (費用ではなく資産への振替)
await page.click('.type-option:has(input[value="save"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-06`);
await page.selectOption("#entry-category", "投資信託");
await page.fill("#entry-amount", "20000");
await page.fill("#entry-memo", "積立");
await page.click("#submit-btn");
await page.waitForTimeout(200);

// 給与 (明細つき)。支給 362,309 / 控除 98,000 → 振込 264,309
await page.click('.type-option:has(input[value="income"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-25`);
await page.selectOption("#entry-category", "給与");
await page.click("#payslip-toggle-btn");
await page.waitForTimeout(250);
for (const [sel, v] of [
  ["#payslip-base-salary", "320000"],
  ["#payslip-location-allowance", "20000"],
  ["#payslip-commute", "12309"],
  ["#payslip-overtime-pay", "10000"],
  ["#payslip-housing", "30000"],
  ["#payslip-health-insurance", "16000"],
  ["#payslip-pension-insurance", "30000"],
  ["#payslip-employment-insurance", "2000"],
  ["#payslip-income-tax", "8000"],
  ["#payslip-resident-tax", "12000"],
]) await page.fill(sel, v);
await page.waitForTimeout(200);
await page.fill("#entry-memo", "今月の給与");
await page.click("#submit-btn");
await page.waitForTimeout(400);

// カード払いの支出 (確定明細から取り込む → source=card になる)
const cardPath = path.join(scratch, "book-card.csv");
fs.writeFileSync(
  cardPath,
  [
    "宇津木　武　様,4980-09**-****-****,Ｏｌｉｖｅ／クレジット",
    `${CUR_Y}/${MM}/08,ＢＯＯＴＨ,900,１,１,900,`,
    ",,,,,900,",
  ].join("\n"),
  "utf-8"
);
await page.setInputFiles("#import-csv-input", cardPath);
await page.waitForTimeout(700);
await page.click("#today-btn");
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------
// 1. 損益計算書: 収益 − 費用 = 当期純利益。上の「収支」と必ず一致する
// ---------------------------------------------------------------------------
const pl = await bookText("pl");
console.log("P/L:", pl);
// 総支給が収益に立つ (手取りではない)
if (!pl.includes("給与¥362,309")) throw new Error("総支給を収益に立てるはず: " + pl);
// 控除は簿記の科目に振り分ける
if (!pl.includes("法定福利費¥48,000")) throw new Error("社会保険料は法定福利費: " + pl);
if (!pl.includes("租税公課¥20,000")) throw new Error("所得税+住民税は租税公課: " + pl);
// 貯蓄・投資は費用ではない
if (pl.includes("投資信託")) throw new Error("貯蓄・投資を費用に入れてはいけない: " + pl);
// 費用合計 = 法定福利費48,000 + 住居30,000 + 租税公課20,000 + 食費3,000 + 趣味900
if (!pl.includes("費用合計¥101,900")) throw new Error("費用合計が違う: " + pl);
if (!pl.includes("当期純利益¥260,409")) throw new Error("当期純利益が違う: " + pl);

// 当期純利益は上の収支カードと一致する (見方を変えただけで別の数字にならない)
const balanceCard = (await page.textContent("#balance")).trim();
if (balanceCard !== "¥260,409") {
  throw new Error(`当期純利益と収支カードは一致するはず: ${balanceCard}`);
}

// ---------------------------------------------------------------------------
// 2. 合計試算表: 借方合計と貸方合計が一致する (貸借平均の原理)
// ---------------------------------------------------------------------------
const trial = await bookText("trial");
console.log("試算表:", trial);
if (!trial.includes("✓ 借方合計と貸方合計が一致しています")) {
  throw new Error("貸借が一致しないと簿記として壊れている: " + trial);
}
if (!trial.includes("未払金")) throw new Error("カード払いは未払金に立つはず: " + trial);
const totals = await page.evaluate(() => {
  const cells = [...document.querySelectorAll(".book-total-row td")].map((td) => td.textContent);
  return { debit: cells[0], credit: cells[cells.length - 1] };
});
if (totals.debit !== totals.credit) {
  throw new Error("合計行の借方と貸方が違う: " + JSON.stringify(totals));
}

// ---------------------------------------------------------------------------
// 3. 仕訳帳
// ---------------------------------------------------------------------------
await page.click('.book-tab[data-book="journal"]');
await page.waitForTimeout(250);
const entryText = async (memo) =>
  (await page.locator(".journal-entry", { hasText: memo }).textContent()).replace(/\s+/g, " ").trim();

// 現金の支出: (借)食費 / (貸)現金
const cash = await entryText("現金でスーパー");
if (!cash.includes("食費") || !cash.includes("現金")) throw new Error("現金の仕訳: " + cash);
if (cash.includes("未払金")) throw new Error("現金払いを未払金にしてはいけない: " + cash);

// カード払い: 貸方が未払金になる (現金はまだ出ていかない)
const card = await entryText("ＢＯＯＴＨ");
console.log("カードの仕訳:", card);
if (!card.includes("未払金")) throw new Error("カード払いは未払金: " + card);
if (card.includes("現金") || card.includes("銀行口座")) {
  throw new Error("カード払いで現金・口座を減らしてはいけない: " + card);
}
if (!card.includes("カード")) throw new Error("カード払いだと分かる印を付けるはず: " + card);

// 貯蓄: (借)投資信託(資産) / (貸)現金預金。費用科目は出てこない
const save = await entryText("積立");
if (!save.includes("投資信託") || !save.includes("銀行口座")) throw new Error("貯蓄の仕訳: " + save);

// 給与: 複合仕訳。借方に受取額と控除、貸方に総支給
const salary = await entryText("今月の給与");
console.log("給与の仕訳:", salary);
for (const expected of ["銀行口座", "¥294,309", "法定福利費", "¥48,000", "租税公課", "¥20,000", "給与", "¥362,309"]) {
  if (!salary.includes(expected)) throw new Error(`給与の複合仕訳に ${expected} が無い: ` + salary);
}
if (!salary.includes("寮社宅費")) throw new Error("寮社宅費の扱いを説明するはず: " + salary);

// 立替払いは簿記だと資産。違いを説明する注記が出る
await page.click('.book-tab[data-book="journal"]');
await page.click('.type-option:has(input[value="expense"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-09`);
await page.selectOption("#entry-category", "交際費");
await page.fill("#entry-amount", "5000");
await page.fill("#entry-memo", "懇親会を立替");
await page.check("#entry-advance");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await page.click("#today-btn");
await page.waitForTimeout(400);
const advance = await entryText("懇親会を立替");
if (!advance.includes("立替金")) {
  throw new Error("立替払いは簿記だと立替金(資産)だと説明するはず: " + advance);
}

// 貸借は立替を足しても一致したまま
const trial2 = await bookText("trial");
if (!trial2.includes("✓ 借方合計と貸方合計が一致しています")) {
  throw new Error("立替を足したら貸借が崩れた: " + trial2);
}

// ---------------------------------------------------------------------------
// 4. 貸借対照表
// ---------------------------------------------------------------------------
// 設定前は案内を出す (白紙のB/Sを見せない)
const beforeSetup = await bookText("bs");
if (!beforeSetup.includes("口座を設定")) {
  throw new Error("期首残高が無いときは設定を促すはず: " + beforeSetup);
}

// 期首 (1/1): 現金 50,000 / 銀行 800,000 / 投資信託 300,000 / カード未払い 30,000
await page.click("#edit-accounts-btn");
await page.waitForTimeout(300);
await page.fill("#accounts-opening-date", `${CUR_Y}-01-01`);
await page.fill("#account-input-現金", "50000");
await page.fill("#account-input-銀行口座", "800000");
await page.fill("#account-input-投資信託", "300000");
await page.fill("#account-input-未払金", "30000");
await page.selectOption("#card-closing-day", "31"); // 末日締め
await page.selectOption("#card-payment-months", "1"); // 翌月
await page.selectOption("#card-payment-day", "26");
await page.click("#accounts-form button[type=submit]");
await page.waitForTimeout(600);

const bs = await bookText("bs");
console.log("B/S:", bs);

// 現金 = 50,000 − 食費3,000 − 交際費(立替)5,000 = 42,000
if (!bs.includes("現金¥42,000")) throw new Error("現金の残高が違う: " + bs);
// 銀行 = 800,000 − 積立20,000 + 給与294,309 − 住居30,000 − 期首カード30,000 = 1,014,309
if (!bs.includes("銀行口座¥1,014,309")) throw new Error("銀行口座の残高が違う: " + bs);
// 投資信託 = 300,000 + 20,000
if (!bs.includes("投資信託¥320,000")) throw new Error("投資資産の残高が違う: " + bs);
// 未払金 = 期首30,000 − 引き落とし30,000 + 今月のカード利用900 = 900
// (末日締め翌月26日払いなので、今月の利用はまだ引き落とされていない)
if (!bs.includes("未払金¥900")) throw new Error("カード未払金が違う: " + bs);
if (!bs.includes("純資産 (資産 − 負債)¥1,375,409")) throw new Error("純資産が違う: " + bs);

// 期首純資産 + 当期純利益 = 期末純資産 になっている (貸借対照表と損益計算書の連携)
// 期首純資産 = 50,000+800,000+300,000−30,000 = 1,120,000
// 記録は全部今月なので、当期純利益 255,409 を足すと 1,375,409
const plAfter = await bookText("pl");
if (!plAfter.includes("当期純利益¥255,409")) throw new Error("当期純利益が違う: " + plAfter);

// 給与天引きの家賃は現金を通らない (持っていない現金が減らないこと)
await page.click('.book-tab[data-book="journal"]');
await page.waitForTimeout(250);
const housing = await entryText("給与天引き: 寮社宅費");
if (!housing.includes("銀行口座")) throw new Error("天引きの家賃は口座から: " + housing);

// ---------------------------------------------------------------------------
// 4.5 旧形式の給与明細 (総支給額・社会保険料をまとめて持つ) でも仕訳が成り立つ
// ---------------------------------------------------------------------------
// 新形式の科目名 (baseSalary など) を持たないので、そのまま集計すると支給合計が
// 0になり、全額が「差額 (要確認)」に落ちて偽の警告が出る。
await page.evaluate(({ y, mm }) => {
  window.__seedDoc(`users/uid-book-test@example.com/entries/legacy-payslip`, {
    date: `${y}-${mm}-27`,
    type: "income",
    category: "副収入",
    amount: 160000, // 手取り = 200,000 − 30,000 − 8,000 − 2,000
    memo: "旧形式の給与明細",
    settlement: "bank",
    payslip: { gross: 200000, socialInsurance: 30000, incomeTax: 8000, residentTax: 2000 },
  });
}, { y: CUR_Y, mm: MM });
await page.waitForTimeout(500);
await page.click('.book-tab[data-book="journal"]');
await page.waitForTimeout(300);
const legacy = await entryText("旧形式の給与明細");
console.log("旧形式の仕訳:", legacy);
if (legacy.includes("差額")) {
  throw new Error("旧形式でも貸借が合うはず (差額に落ちてはいけない): " + legacy);
}
for (const expected of ["銀行口座", "¥160,000", "法定福利費", "¥30,000", "租税公課", "¥10,000", "副収入", "¥200,000"]) {
  if (!legacy.includes(expected)) throw new Error(`旧形式の仕訳に ${expected} が無い: ` + legacy);
}
const trialLegacy = await bookText("trial");
if (!trialLegacy.includes("✓ 借方合計と貸方合計が一致しています")) {
  throw new Error("旧形式を足したら貸借が崩れた: " + trialLegacy);
}
if (trialLegacy.includes("差額")) throw new Error("偽の差額が出ている: " + trialLegacy);

// ---------------------------------------------------------------------------
// 5. 期首より前のカード利用を二重に払わない
// ---------------------------------------------------------------------------
// 期首前(去年12月)のカード利用は、その請求が期首残高の未払金に含まれている。
// 引き落としだけを拾うと、同じ借金を2回払う形になって口座残高が狂う。
const oldCardCsv = path.join(scratch, "book-card-before-opening.csv");
fs.writeFileSync(
  oldCardCsv,
  [
    "宇津木　武　様,4980-09**-****-****,Ｏｌｉｖｅ／クレジット",
    `${CUR_Y - 1}/12/20,ヨドバシカメラ,25000,１,１,25000,`,
    ",,,,,25000,",
  ].join("\n"),
  "utf-8"
);
await page.setInputFiles("#import-csv-input", oldCardCsv);
await page.waitForTimeout(700);
await page.click("#today-btn");
await page.waitForTimeout(500);

const bsAfterOld = await bookText("bs");
console.log("期首前のカード利用を足したあと:", bsAfterOld);
if (!bsAfterOld.includes("銀行口座¥1,174,309")) {
  throw new Error("期首前の利用で口座残高が動いてはいけない: " + bsAfterOld);
}
if (!bsAfterOld.includes("未払金¥900")) {
  throw new Error("期首前の利用で未払金が動いてはいけない: " + bsAfterOld);
}
if (!bsAfterOld.includes("純資産 (資産 − 負債)¥1,535,409")) {
  throw new Error("期首前の利用で純資産が動いてはいけない: " + bsAfterOld);
}

// ---------------------------------------------------------------------------
// 6. 期首の未払金の引き落としは、期首日以降で最初に来る支払日に立つ
// ---------------------------------------------------------------------------
// 期首 1/1・支払日26日なので 1/26。締め日から数えて翌月(2/26)にしてはいけない。
// 何回戻るかは今日の月から計算する (実行する月によって結果が変わらないように)
for (let i = 0; i < NOW.getMonth(); i++) await page.click("#prev-month");
await page.waitForTimeout(500);
await page.click('.book-tab[data-book="journal"]');
await page.waitForTimeout(300);
const janJournal = (await page.textContent("#bookkeeping-body")).replace(/\s+/g, " ").trim();
console.log("1月の仕訳:", janJournal);
if (!janJournal.includes("カードの引き落とし") || !janJournal.includes("¥30,000")) {
  throw new Error("期首のカード未払金の引き落としが1月に立つはず: " + janJournal);
}
if (!janJournal.includes("1/26")) {
  throw new Error("引き落としは1/26のはず: " + janJournal);
}
// 期首前(12/20)の利用は帳簿の対象外なので、その引き落としは出てこない
if (janJournal.includes("¥25,000")) {
  throw new Error("期首前の利用の引き落としを立ててはいけない: " + janJournal);
}

// 期首より前の期間は残高を出せないと伝える (期首残高をその時点の残高に見せない)
await page.click("#prev-month");
await page.waitForTimeout(400);
const beforeOpening = await bookText("bs");
if (!beforeOpening.includes("より前の残高は分かりません")) {
  throw new Error("期首より前は残高を出せないと伝えるはず: " + beforeOpening);
}

await page.click("#today-btn");
await page.waitForTimeout(400);

await page.screenshot({ path: path.join(scratch, "bookkeeping.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL BOOKKEEPING (帳簿) CHECKS PASSED");
await browser.close();
server.close();

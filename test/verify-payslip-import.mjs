// 給与サイトの明細ページから取り込む仕組みを確認する。
//   1. 振り分けの判断 (interpretPayslipImport) を、ブラウザを使わずに確かめる
//   2. 明細ページを模した見本の上でブックマークレットを実際に動かし、
//      家計簿を開いたときにフォームへ正しく入るところまで通しで確かめる
// 見本の会社名・氏名・金額はすべて架空。
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildBookmarklet, interpretPayslipImport } from "../js/payslip-import.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const scratch = process.env.TEST_OUT_DIR || here;
const stubRoot = path.join(here, "stubs");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

const assert = (cond, message) => { if (!cond) throw new Error(message); };

// ---------------------------------------------------------------------------
// 1. 振り分けの判断
// ---------------------------------------------------------------------------
{
  // 形が崩れたもの・支給が1つも無いものは明細として扱わない
  assert(interpretPayslipImport(null) === null, "null は読めない");
  assert(interpretPayslipImport({ pairs: "x" }) === null, "pairs が配列でなければ読めない");
  assert(
    interpretPayslipImport({ pairs: [["出勤", "20", "勤怠"], ["社員番号", "123", ""]] }) === null,
    "給与の項目が無ければ読めない"
  );

  // 区切り (支給/控除) が無く、控除合計がある → 合計から「その他控除」を逆算
  const byTotal = interpretPayslipImport({
    pairs: [
      ["基本給", "200,000円"], ["通勤費", "10,000円"],
      ["健康保険料", "10,000円"], ["厚生年金保険料", "18,000円"], ["謎の控除", "700円"],
      ["控除合計", "28,700円"], ["差引支給額", "181,300円"],
    ],
  });
  assert(byTotal.fields.otherDeductions === 700, "控除合計から逆算するはず: " + JSON.stringify(byTotal));
  assert(byTotal.checks.some((c) => c.ok && c.text.includes("一致")), "差引支給額で検算できるはず");

  // 区切りも控除合計も無く、差引支給額だけ → 逆算はするが「一致」とは言わない (当たり前なので)
  const byNet = interpretPayslipImport({
    pairs: [["本給", "200,000"], ["所得税", "5,000"], ["差引支給額", "194,000"]],
  });
  assert(byNet.fields.otherDeductions === 1000, "差引支給額から逆算するはず: " + JSON.stringify(byNet));
  assert(!byNet.checks.some((c) => c.text.includes("一致")), "逆算に使った値で一致を名乗らない");

  // 支給の下に知らない項目 → 入れる欄が無いと名前つきで知らせる
  const unknownEarning = interpretPayslipImport({
    pairs: [["本給", "200,000", "支給"], ["資格手当", "5,000", "支給"], ["差引支給額", "205,000", "記事"]],
  });
  assert(
    unknownEarning.checks.some((c) => !c.ok && c.text.includes("資格手当")),
    "知らない支給項目を黙って捨てない: " + JSON.stringify(unknownEarning.checks)
  );

  // 賞与明細
  const bonus = interpretPayslipImport({
    period: "2026年7月度",
    pairs: [
      ["賞与額", "400,000", "支給"], ["健康保険", "20,000", "控除"], ["子ども支援金", "500", "控除"],
      ["厚年保険", "36,000", "控除"], ["雇用保険料", "2,400", "控除"], ["所得税", "30,000", "控除"],
      ["差引支給額", "311,100", "記事"],
    ],
  });
  assert(bonus.kind === "bonus", "本給が無く賞与額があれば賞与");
  assert(bonus.fields.bonusAmount === 400000 && bonus.fields.childSupportLevy === 500, "賞与の欄");
  assert(bonus.memo === "7月度賞与", "メモ: " + bonus.memo);
  assert(bonus.checks.some((c) => c.ok && c.text.includes("一致")), "賞与も差引支給額で検算");
}
console.log("振り分けの判断: OK");

// ---------------------------------------------------------------------------
// 2. 見本の明細ページでブックマークレットを動かし、家計簿に取り込む
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0].split("#")[0]) === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  try {
    const data = fs.readFileSync(p);
    res.writeHead(200, { "content-type": mime[path.extname(p)] || "text/plain" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("nf");
  }
});
await new Promise((r) => server.listen(8983, r));
const APP = "http://localhost:8983/";
const bookmarklet = decodeURIComponent(buildBookmarklet(APP).slice("javascript:".length));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];

// 見本ページの上でブックマークレットを押し、開こうとした家計簿のURLを返す
async function runBookmarklet(fixture) {
  const p = await browser.newPage();
  await p.goto(`${APP}test/fixtures/${fixture}`);
  await p.evaluate(() => {
    window.__opened = null;
    window.open = (url) => { window.__opened = url; return {}; };
  });
  await p.evaluate(bookmarklet);
  const url = await p.evaluate(() => window.__opened);
  await p.close();
  assert(url && url.startsWith(APP + "#payslip-import="), `${fixture}: 家計簿を開くはず: ${url}`);
  return url;
}

async function openAppWith(url, email) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", (d) => d.accept());
  await page.route("https://www.gstatic.com/firebasejs/**/*.js", async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: fs.readFileSync(path.join(stubRoot, u.pathname.split("/").pop()), "utf-8"),
    });
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  // 明細の数字をアドレスバーに出しっぱなしにしない
  assert((await page.evaluate(() => location.hash)) === "", "受け取ったら URL から消すはず");
  await page.click('.auth-tab[data-mode="signup"]');
  await page.fill("#auth-email", email);
  await page.fill("#auth-password", "password123");
  await page.click("#auth-submit-btn");
  await page.waitForTimeout(500);
  return page;
}

// 見本の金額: 支給 292,600 / 控除 75,600 (うち寮社宅費 15,000、名前の分からない控除 6,800)
// → 差引支給額 217,000。家計簿の記録は「振込額 + 寮社宅費」= 232,000
for (const fixture of ["payslip-table.html", "payslip-mobile.html"]) {
  const url = await runBookmarklet(fixture);
  const page = await openAppWith(url, `import-${fixture.replace(/\W/g, "")}@example.com`);

  const got = await page.evaluate(() => ({
    type: document.querySelector('input[name="entry-type"]:checked').value,
    category: document.querySelector("#entry-category").value,
    date: document.querySelector("#entry-date").value,
    settlement: document.querySelector("#entry-settlement").value,
    amount: document.querySelector("#entry-amount").value,
    memo: document.querySelector("#entry-memo").value,
    base: document.querySelector("#payslip-base-salary").value,
    location: document.querySelector("#payslip-location-allowance").value,
    adjustment: document.querySelector("#payslip-salary-adjustment").value,
    housing: document.querySelector("#payslip-housing").value,
    child: document.querySelector("#payslip-child-support").value,
    pension: document.querySelector("#payslip-pension-insurance").value,
    employment: document.querySelector("#payslip-employment-insurance").value,
    resident: document.querySelector("#payslip-resident-tax").value,
    other: document.querySelector("#payslip-other-deductions").value,
    note: document.querySelector("#payslip-copy-note").textContent,
  }));
  console.log(fixture, JSON.stringify({ amount: got.amount, other: got.other, date: got.date, memo: got.memo }));

  assert(got.type === "income" && got.category === "給与", `${fixture}: 収入・給与を選ぶはず`);
  assert(got.date === "2026-05-25", `${fixture}: 支給日: ${got.date}`);
  assert(got.settlement === "bank", `${fixture}: 給与は口座に入る`);
  assert(got.memo === "5月度給与", `${fixture}: メモ: ${got.memo}`);
  assert(got.base === "250000" && got.location === "10000" && got.adjustment === "100", `${fixture}: 支給の欄`);
  // 控除が2段に折り返していても、下の段 (雇用保険料・住民税) まで拾う
  assert(got.employment === "1500" && got.resident === "10000", `${fixture}: 控除の2段目`);
  assert(got.pension === "25000", `${fixture}: 厚年保険は厚生年金の欄へ`);
  assert(got.child === "300", `${fixture}: 子ども支援金`);
  assert(got.housing === "15000", `${fixture}: 寮社宅費は家賃の欄へ`);
  assert(got.other === "6800", `${fixture}: 名前の分からない控除はその他控除へ: ${got.other}`);
  assert(got.amount === "232000", `${fixture}: 金額は 振込額+寮社宅費: ${got.amount}`);
  assert(got.note.includes("団体保険") && got.note.includes("組合費"), `${fixture}: 何をその他控除に入れたか名前で示す`);
  assert(got.note.includes("一致"), `${fixture}: 差引支給額で検算した結果を出す: ${got.note}`);

  // 自動では保存しない。確認して「追加」を押して初めて記録になる
  assert((await page.locator("#entry-list tr").count()) === 0, `${fixture}: 勝手に保存してはいけない`);
  await page.click("#submit-btn");
  await page.waitForTimeout(600);
  const list = (await page.textContent("#entry-list")).replace(/\s+/g, " ");
  assert(list.includes("¥232,000"), `${fixture}: 保存された金額: ${list}`);
  assert(list.includes("給与天引き"), `${fixture}: 寮社宅費の住居の支出も立つ`);
  await page.close();
}

// ---------------------------------------------------------------------------
// 3. 外から来た項目名は HTML として解釈しない
// ---------------------------------------------------------------------------
{
  const payload = {
    v: 1,
    pairs: [
      ["本給", "200,000", "支給"],
      ['<img src=x onerror="window.__xss=1">', "500", "控除"],
      ["差引支給額", "199,500", "記事"],
    ],
  };
  const page = await openAppWith(APP + "#payslip-import=" + encodeURIComponent(JSON.stringify(payload)), "xss@example.com");
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => ({
    xss: window.__xss,
    imgs: document.querySelectorAll("#payslip-copy-note img").length,
    note: document.querySelector("#payslip-copy-note").textContent,
  }));
  assert(result.xss === undefined && result.imgs === 0, "項目名が HTML として動いてはいけない: " + JSON.stringify(result));
  assert(result.note.includes("<img"), "項目名は文字としてそのまま見せる");
  await page.close();
}

// ---------------------------------------------------------------------------
// 4. 設定のポップアップ
// ---------------------------------------------------------------------------
{
  const page = await openAppWith(APP, "setup@example.com");
  await page.click('.type-option:has(input[value="income"]) span');
  await page.selectOption("#entry-category", "給与");
  await page.click("#payslip-link-btn");
  await page.waitForTimeout(200);
  assert(await page.locator("#payslip-link-modal").isVisible(), "設定のポップアップが開くはず");
  const code = await page.inputValue("#payslip-link-code");
  assert(code.startsWith("javascript:"), "登録するコード: " + code.slice(0, 30));
  // このページの家計簿を開くコードになっている (別の場所に送らない)
  assert(decodeURIComponent(code).includes(JSON.stringify(APP)), "開く先はこの家計簿のはず");
  // 家計簿の上でうっかり押しても動かさず、使い方を伝える
  const dialogs = [];
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  await page.click("#payslip-link-drag");
  await page.waitForTimeout(200);
  assert(dialogs.some((m) => m.includes("ドラッグ")), "押したら使い方を伝えるはず: " + dialogs.join(" / "));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert(!(await page.locator("#payslip-link-modal").isVisible()), "Escape で閉じるはず");
  await page.screenshot({ path: path.join(scratch, "payslip-import.png"), fullPage: true });

  // 給与の内訳に子ども支援金の欄があり、手取りから引かれる。
  // (欄が無かったころは、明細どおりに入れてもその分だけ収入が多く記録されていた)
  await page.click("#payslip-toggle-btn");
  await page.fill("#payslip-base-salary", "200000");
  await page.fill("#payslip-child-support", "368");
  await page.waitForTimeout(100);
  const amount = await page.inputValue("#entry-amount");
  assert(amount === "199632", "子ども支援金も控除に入るはず: " + amount);
  await page.close();
}

if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL PAYSLIP IMPORT CHECKS PASSED");
await browser.close();
server.close();

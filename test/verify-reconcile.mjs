// メールから取り込んだ未確定(仮)の記録と、あとで取り込む確定明細
// (カード利用履歴CSV) の突き合わせを確認する。
// メールは速報なので、店名の書き方が違ったり、確定で金額が動いたり、
// キャンセルされて明細に出てこなかったりする。それぞれ正しく決着するか。
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
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

const NOW = new Date();
const CUR_Y = NOW.getFullYear();
const MM = String(NOW.getMonth() + 1).padStart(2, "0");
const base64url = (t) =>
  Buffer.from(t, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

// 利用通知メール (速報)。この4件が「仮」で入る。
const MAIL = `AL1cE　様

◇利用日：${CUR_Y}/${MM}/10 08:12
◇利用先：ﾌｧﾐﾘｰﾏｰﾄ　横浜西口店
◇利用金額：540円

◇利用日：${CUR_Y}/${MM}/12 09:30
◇利用先：モバイルＳｕｉｃａ（Ａｐｐｌｅ）
◇利用金額：2,000円

◇利用日：${CUR_Y}/${MM}/14 22:05
◇利用先：ＡＭＡＺＯＮ　ＷＥＢ　ＳＶＣ
◇利用金額：1,200円

◇利用日：${CUR_Y}/${MM}/16 12:00
◇利用先：ＢＯＯＴＨ
◇利用金額：900円
`;

await page.addInitScript(() => {
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient(config) {
          return {
            requestAccessToken() {
              config.callback({ access_token: "fake-access-token" });
            },
          };
        },
      },
    },
  };
});

let listResponses = [];
await page.route("https://gmail.googleapis.com/gmail/v1/users/me/messages?*", async (route) => {
  const messages = listResponses.shift() || [];
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages }) });
});
// 確定済みになった取引の速報が、あとから届いたことにするメール。
// 金額は確定後のもの (AWSは1,320円) にしてある。
const LATE_MAIL = `AL1cE　様

◇利用日：${CUR_Y}/${MM}/10 08:12
◇利用先：ﾌｧﾐﾘｰﾏｰﾄ　横浜西口店
◇利用金額：540円

◇利用日：${CUR_Y}/${MM}/14 22:05
◇利用先：ＡＭＡＺＯＮ　ＷＥＢ　ＳＶＣ
◇利用金額：1,320円
`;

const mailRoute = async (id, text) => {
  await page.route(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ payload: { mimeType: "text/plain", body: { data: base64url(text) } } }),
    });
  });
};
await mailRoute("msg1", MAIL);
await mailRoute("msg2", LATE_MAIL);

await page.goto("http://localhost:8990/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "reconcile-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

const rowFor = (memo) => page.locator("#entry-list tr", { hasText: memo });
const rowText = async (memo) => (await rowFor(memo).textContent()).replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// 1. メールから取り込んだ記録は「仮」として入る
// ---------------------------------------------------------------------------
listResponses.push([{ id: "msg1" }]);
await page.click("#gmail-import-btn");
await page.waitForTimeout(900);
await page.click("#today-btn");
await page.waitForTimeout(400);

if ((await page.locator("#entry-list tr").count()) !== 4) {
  throw new Error("4件のメール明細が入るはず");
}
if ((await page.locator("#entry-list .pending-badge").count()) !== 4) {
  throw new Error("メール由来は全部「仮」バッジが付くはず");
}
const note = await page.textContent("#list-pending-note");
console.log("pending note:", note.trim());
if (!note.includes("4件")) throw new Error("未確定の件数が出るはず: " + note);
if (!note.includes("¥4,640")) throw new Error("未確定の合計が出るはず: " + note);
// どの明細 (◯月お支払い分) を取り込めば確定するかを書く。
// 9月の利用は9月お支払い分ではなく、その次の明細に載るため
if (!/\d+年\d+月お支払い分/.test(note)) throw new Error("確定させる明細の月を書くはず: " + note);

// ---------------------------------------------------------------------------
// 2. 確定明細 (カード利用履歴CSV) を取り込むと、仮の記録が置き換わる
// ---------------------------------------------------------------------------
//   ファミマ    : 店名の書き方が違う (半角カナ vs 全角) → 名寄せで一致
//   Suica       : 店名が全然違う → 日付と金額で一致
//   AWS         : 為替確定で 1,200 → 1,320 に増えた → 店名と日付で一致
//   BOOTH       : 確定明細に無い (キャンセル) → 残して警告
//   マツキヨ     : メールに無い → 新規追加
dialogs.length = 0;
const cardLines = [
  "見本　太郎　様,1234-56**-****-****,Ｏｌｉｖｅ／クレジット",
  `${CUR_Y}/${MM}/10,ファミリーマート横浜西口店,540,１,１,540,`,
  `${CUR_Y}/${MM}/12,ＪＲ東日本　モバイルＳｕｉｃａ,2000,１,１,2000,`,
  `${CUR_Y}/${MM}/14,ＡＭＡＺＯＮ　ＷＥＢ　ＳＶＣ,1320,１,１,1320,`,
  `${CUR_Y}/${MM}/18,マツモトキヨシ,3000,１,１,3000,`,
  ",,,,,6860,",
];
const cardPath = path.join(scratch, "reconcile-card.csv");
fs.writeFileSync(cardPath, cardLines.join("\n"), "utf-8");
await page.setInputFiles("#import-csv-input", cardPath);
await page.waitForTimeout(900);

const confirmMsg = dialogs.find((m) => m.includes("確定明細"));
console.log("confirm:", JSON.stringify(confirmMsg));
if (!confirmMsg.includes("仮の記録 3件を確定版に更新")) {
  throw new Error("3件が確定版に置き換わるはず: " + confirmMsg);
}
if (!confirmMsg.includes("1件を新しく追加")) {
  throw new Error("メールに無い1件だけ追加されるはず: " + confirmMsg);
}
if (!confirmMsg.includes("1件の仮の記録が確定明細に見つかりませんでした")) {
  throw new Error("キャンセル分を知らせるはず: " + confirmMsg);
}
if (!confirmMsg.includes("ＢＯＯＴＨ")) {
  throw new Error("見つからなかった記録の中身を出すはず: " + confirmMsg);
}

await page.click("#today-btn");
await page.waitForTimeout(500);

// 二重登録されていない (メール4件 + 新規1件 = 5件)
const rows = await page.locator("#entry-list tr").count();
if (rows !== 5) throw new Error("重複してはいけない。rows=" + rows);

// 確定した3件は「仮」が外れ、キャンセル分だけ残る
const stillPending = await page.locator("#entry-list .pending-badge").count();
if (stillPending !== 1) throw new Error("確定した記録の「仮」は外れるはず。残り=" + stillPending);
if (!(await rowText("ＢＯＯＴＨ")).includes("仮")) {
  throw new Error("確定明細に無かった記録は「仮」のまま残るはず");
}

// 為替確定で増えた分は確定版の金額に更新される
const aws = await rowText("ＡＭＡＺＯＮ");
console.log("aws row:", aws);
if (!aws.includes("¥1,320")) throw new Error("確定版の金額に更新されるはず: " + aws);

// 店名(メモ)とカテゴリはメール側のまま。CSVの読みにくい表記で上書きしない
if (!(await rowText("モバイルＳｕｉｃａ")).includes("交通")) {
  throw new Error("メール側のカテゴリが保たれるはず");
}
if ((await page.textContent("#entry-list")).includes("ＪＲ東日本")) {
  throw new Error("メモをCSVの表記で上書きしてはいけない");
}

// 新規分は入っている
if (!(await rowText("マツモトキヨシ")).includes("日用品")) {
  throw new Error("メールに無かった行が追加されるはず");
}

const noteAfter = await page.textContent("#list-pending-note");
if (!noteAfter.includes("1件")) throw new Error("未確定は1件に減るはず: " + noteAfter);

// ---------------------------------------------------------------------------
// 3. 同じ確定明細をもう一度読み込んでも増えない
// ---------------------------------------------------------------------------
dialogs.length = 0;
await page.setInputFiles("#import-csv-input", cardPath);
await page.waitForTimeout(900);
console.log("re-import:", JSON.stringify(dialogs.find((m) => m.includes("登録済み"))));
if (!dialogs.some((m) => m.includes("既に登録済み"))) {
  throw new Error("2回目は全部スキップされるはず: " + dialogs.join(" / "));
}
await page.click("#today-btn");
await page.waitForTimeout(400);
if ((await page.locator("#entry-list tr").count()) !== 5) {
  throw new Error("2回目の読み込みで増えてはいけない");
}

// ---------------------------------------------------------------------------
// 4. 手入力(現金)は確定明細に巻き込まれない
// ---------------------------------------------------------------------------
await page.fill("#entry-date", `${CUR_Y}-${MM}-11`);
await page.selectOption("#entry-category", "食費");
await page.fill("#entry-amount", "540");
await page.fill("#entry-memo", "現金でランチ");
await page.click("#submit-btn");
await page.waitForTimeout(400);
if ((await rowText("現金でランチ")).includes("仮")) {
  throw new Error("手入力は未確定にならない");
}

// ---------------------------------------------------------------------------
// 5. 確定明細を先に取り込んでいたら、後から来たメールの速報は取り込まない
// ---------------------------------------------------------------------------
// (メールの検索範囲は60日あるので、CSVを先に入れる運用だとこの順序になる)
dialogs.length = 0;
listResponses.push([{ id: "msg2" }]);
await page.click("#gmail-import-btn");
await page.waitForTimeout(900);
const lateMsg = dialogs.join(" / ");
console.log("late mail:", JSON.stringify(lateMsg));
if (!lateMsg.includes("既に登録済み")) {
  throw new Error("確定済みの取引の速報は取り込まないはず: " + lateMsg);
}
if (!lateMsg.includes("カード利用履歴CSVで確定済み") && !lateMsg.includes("すべて")) {
  throw new Error("確定済みとしてスキップした旨を伝えるはず: " + lateMsg);
}
await page.click("#today-btn");
await page.waitForTimeout(400);
// 手入力1件を足したので6件。ここから増えていないこと
if ((await page.locator("#entry-list tr").count()) !== 6) {
  throw new Error("後から来たメールで増えてはいけない");
}

// ---------------------------------------------------------------------------
// 6. 明細の期間より後の仮の記録は、この明細では確定しない。それを伝える
// ---------------------------------------------------------------------------
// 例: 「2026年9月お支払い分」の明細は8月の利用分。9月に使った分の仮は、
// その明細を入れても外れない (次の明細に載る)。黙っていると不具合に見える
const NEXT = new Date(CUR_Y, NOW.getMonth() + 1, 5);
const NEXT_DATE = `${NEXT.getFullYear()}-${String(NEXT.getMonth() + 1).padStart(2, "0")}-05`;
await page.evaluate((date) => {
  window.__seedDoc("users/uid-reconcile-test@example.com/entries/later-pending", {
    date, type: "expense", category: "食費", amount: 777, memo: "来月のコンビニ",
    source: "gmail", createdAt: Date.now(),
  });
}, NEXT_DATE);
await page.waitForTimeout(300);
dialogs.length = 0;
const laterPath = path.join(scratch, "reconcile-later.csv");
fs.writeFileSync(laterPath, [
  "見本　太郎　様,1234-56**-****-****,Ｏｌｉｖｅ／クレジット",
  `${CUR_Y}/${MM}/20,ドラッグストア,450,１,１,450,`,
  ",,,,,450,",
].join("\n"), "utf-8");
await page.setInputFiles("#import-csv-input", laterPath);
await page.waitForTimeout(900);
const laterMsg = dialogs.find((m) => m.includes("よろしいですか")) || "";
console.log("later pending:", JSON.stringify(laterMsg));
if (!laterMsg.includes(`${CUR_Y}年${Number(MM)}月20日〜${Number(MM)}月20日 のご利用分`)) {
  throw new Error("明細がいつの利用分かを書くはず: " + laterMsg);
}
if (!laterMsg.includes("それより後の仮の記録 1件") || !laterMsg.includes("お支払い分")) {
  throw new Error("この明細では確定しない仮の記録があることを伝えるはず: " + laterMsg);
}
// 来月分の仮は、この明細では触らない (仮のまま残る)
await page.click("#today-btn");
await page.waitForTimeout(300);
await page.click("#next-month");
await page.waitForTimeout(400);
const laterRow = page.locator("#entry-list tr", { hasText: "来月のコンビニ" });
if ((await laterRow.locator(".pending-badge").count()) !== 1) {
  throw new Error("明細の期間より後の仮の記録は仮のまま残るはず");
}

// ---------------------------------------------------------------------------
// 7. PCの右側の入力欄で編集中に明細CSVを取り込んでも、古い内容で上書きしない
// ---------------------------------------------------------------------------
// 取り込みで仮の記録が確定版 (金額が変わる) に置き換わったあと、編集中の
// 入力欄に残っている古い金額のまま「更新」を押すと、確定した金額が消える
await page.click("#today-btn");
await page.waitForTimeout(300);
await page.evaluate((date) => {
  window.__seedDoc("users/uid-reconcile-test@example.com/entries/editing-pending", {
    date, type: "expense", category: "食費", amount: 600, memo: "ベーカリー",
    source: "gmail", createdAt: Date.now(),
  });
}, `${CUR_Y}-${MM}-21`);
await page.waitForTimeout(300);
await page.locator("#entry-list tr", { hasText: "ベーカリー" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
if ((await page.textContent("#form-title")) !== "記録を編集") throw new Error("右側の入力欄で編集が始まるはず");
dialogs.length = 0;
const editingPath = path.join(scratch, "reconcile-editing.csv");
fs.writeFileSync(editingPath, [
  "見本　太郎　様,1234-56**-****-****,Ｏｌｉｖｅ／クレジット",
  `${CUR_Y}/${MM}/21,ベーカリー,650,１,１,650,`,
  ",,,,,650,",
].join("\n"), "utf-8");
await page.setInputFiles("#import-csv-input", editingPath);
await page.waitForTimeout(900);
const afterImport = await page.evaluate(() => ({
  title: document.getElementById("form-title").textContent,
  id: document.getElementById("entry-id").value,
}));
if (afterImport.title !== "記録を追加" || afterImport.id !== "") {
  throw new Error("取り込みの前に編集をやめるはず (古い内容で上書きしないため): " + JSON.stringify(afterImport));
}
if (!(await page.locator("#entry-list tr", { hasText: "ベーカリー" }).textContent()).includes("¥650")) {
  throw new Error("確定版の金額になっているはず");
}

// ---------------------------------------------------------------------------
// 8. 編集中に別の端末で記録が変わった・消えた
// ---------------------------------------------------------------------------
// 変わった: 古い内容のまま黙って上書きせず、確かめる
await page.locator("#entry-list tr", { hasText: "ベーカリー" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
await page.evaluate((date) => {
  window.__seedDoc("users/uid-reconcile-test@example.com/entries/editing-pending", {
    date, type: "expense", category: "食費", amount: 700, memo: "ベーカリー (スマホで修正)",
    source: "card", createdAt: Date.now(),
  });
}, `${CUR_Y}-${MM}-21`);
await page.waitForTimeout(300);
dialogs.length = 0;
page.removeAllListeners("dialog");
page.on("dialog", (d) => { dialogs.push(d.message()); d.message().includes("変更されています") ? d.dismiss() : d.accept(); });
await page.click("#submit-btn");
await page.waitForTimeout(400);
if (!dialogs.some((m) => m.includes("変更されています"))) {
  throw new Error("編集中に別の端末で変わった記録は、上書きする前に確かめるはず: " + dialogs.join(" / "));
}
if (!(await page.locator("#entry-list tr", { hasText: "ベーカリー" }).textContent()).includes("¥700")) {
  throw new Error("確かめて「キャンセル」なら、別の端末での変更が残るはず");
}
page.removeAllListeners("dialog");
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
// キャンセルしたら編集をやめ、別の端末での内容が残る
if ((await page.textContent("#form-title")) !== "記録を追加") throw new Error("キャンセルしたら編集をやめるはず");
// 消えた: 黙って入力欄を空にせず、理由を伝えて編集をやめる
await page.locator("#entry-list tr", { hasText: "ベーカリー" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
dialogs.length = 0;
await page.evaluate(() => window.__removeDoc("users/uid-reconcile-test@example.com/entries/editing-pending"));
await page.waitForTimeout(400);
if (!dialogs.some((m) => m.includes("削除"))) {
  throw new Error("編集中の記録が消えたら、理由を伝えるはず: " + dialogs.join(" / "));
}
if ((await page.textContent("#form-title")) !== "記録を追加" || (await page.inputValue("#entry-id")) !== "") {
  throw new Error("編集中の記録が消えたら、編集をやめるはず");
}

// 中身が同じで、給与明細の内訳のキーの並び順だけが違う (サーバーから戻ってきた形)
// なら、「変更されています」とは言わない
const payslipDoc = "users/uid-reconcile-test@example.com/entries/order-only";
await page.evaluate(([p, date]) => {
  window.__seedDoc(p, { date, type: "income", category: "給与", amount: 200000, memo: "並び順の確認",
    settlement: "bank", payslip: { kind: "salary", baseSalary: 200000, incomeTax: 0 }, createdAt: Date.now() });
}, [payslipDoc, `${CUR_Y}-${MM}-25`]);
await page.waitForTimeout(300);
await page.locator("#entry-list tr", { hasText: "並び順の確認" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
await page.evaluate(([p, date]) => {
  window.__seedDoc(p, { date, type: "income", category: "給与", amount: 200000, memo: "並び順の確認",
    settlement: "bank", payslip: { incomeTax: 0, baseSalary: 200000, kind: "salary" }, createdAt: Date.now() });
}, [payslipDoc, `${CUR_Y}-${MM}-25`]);
await page.waitForTimeout(300);
dialogs.length = 0;
await page.click("#submit-btn");
await page.waitForTimeout(400);
if (dialogs.some((m) => m.includes("変更されています"))) {
  throw new Error("キーの並び順が違うだけで「変更されています」と出てはいけない");
}

await page.screenshot({ path: path.join(scratch, "reconcile.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL RECONCILE (確定/未確定) CHECKS PASSED");
await browser.close();
server.close();

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
  "宇津木　武　様,4980-09**-****-****,Ｏｌｉｖｅ／クレジット",
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

await page.screenshot({ path: path.join(scratch, "reconcile.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL RECONCILE (確定/未確定) CHECKS PASSED");
await browser.close();
server.close();

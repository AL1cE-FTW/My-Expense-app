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
await new Promise((r) => server.listen(8992, r));

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
const CUR_M = NOW.getMonth() + 1;
const MM = String(CUR_M).padStart(2, "0");
const base64url = (t) =>
  Buffer.from(t, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

const MAIL_ONE = `AL1cE　様

いつも三井住友カードをご利用頂きありがとうございます。

◇利用日：${CUR_Y}/${MM}/21 13:35
◇利用先：モバイルＳｕｉｃａ（Ａｐｐｌｅ）
◇利用取引：買物
◇利用金額：2,000円
`;

// 1通に2件並ぶメール。以前は最初の1件しか読まれず、残りは
// 「取り込み済み」扱いで永久に失われていた
const MAIL_MULTI = `AL1cE　様

◇利用日：${CUR_Y}/${MM}/10 08:12
◇利用先：ﾌｧﾐﾘｰﾏｰﾄ　横浜西口店
◇利用金額：540円

◇利用日：${CUR_Y}/${MM}/11 19:40
◇利用先：ＥＴＣ　首都高速
◇利用金額：1,200円
`;

// 認証を1回だけ失敗させられるモック
await page.addInitScript(() => {
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient(config) {
          return {
            requestAccessToken() {
              if (window.__gisFailNext) {
                window.__gisFailNext = false;
                config.callback({ error: "access_denied" });
                return;
              }
              config.callback({ access_token: "fake-access-token" });
            },
          };
        },
      },
    },
  };
});

// メール一覧は呼び出しごとに差し替える
let listResponses = [];
await page.route("https://gmail.googleapis.com/gmail/v1/users/me/messages?*", async (route) => {
  const messages = listResponses.shift() || [];
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages }) });
});
const mailRoute = async (id, text) => {
  await page.route(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ payload: { mimeType: "text/plain", body: { data: base64url(text) } } }),
    });
  });
};
await mailRoute("msg1", MAIL_ONE);
await mailRoute("msg2", MAIL_MULTI);
// msg3 は msg1 と同じ明細を持つ別IDのメール
await mailRoute("msg3", MAIL_ONE);

await page.goto("http://localhost:8992/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "gmail-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// 1. 認証に一度失敗しても、次のクリックで復帰できる
// ---------------------------------------------------------------------------
// (コールバックが1回目のPromiseを掴んだままだと2回目が永久に解決しない)
await page.evaluate(() => { window.__gisFailNext = true; });
await page.click("#gmail-import-btn");
await page.waitForTimeout(600);
if (!dialogs.some((m) => m.includes("メールの読み込みに失敗しました"))) {
  throw new Error("expected an auth failure alert: " + dialogs.join(" / "));
}
if (await page.locator("#gmail-import-btn").isDisabled()) {
  throw new Error("the button must be usable again after an auth failure");
}

// ---------------------------------------------------------------------------
// 2. 取り込み: 1通に複数明細があっても全件入る
// ---------------------------------------------------------------------------
dialogs.length = 0;
listResponses.push([{ id: "msg1" }, { id: "msg2" }]);
await page.click("#gmail-import-btn");
await page.waitForTimeout(900);
const confirmMsg = dialogs.find((m) => m.includes("利用明細が見つかりました"));
console.log("gmail:", confirmMsg);
if (!confirmMsg.includes("3件の利用明細")) {
  throw new Error("all entries across both mails should be imported: " + confirmMsg);
}
await page.click("#today-btn");
await page.waitForTimeout(400);
const list = (await page.textContent("#entry-list")).trim();
if (!list.includes("モバイルＳｕｉｃａ")) throw new Error("Suica entry missing");
if (!list.includes("ﾌｧﾐﾘｰﾏｰﾄ")) throw new Error("second entry of the multi-mail missing");
if (!list.includes("ＥＴＣ")) throw new Error("third entry missing");
const suicaRow = page.locator("#entry-list tr", { hasText: "モバイルＳｕｉｃａ" });
if (!(await suicaRow.textContent()).includes("交通")) throw new Error("Suica should be 交通");
const etcRow = page.locator("#entry-list tr", { hasText: "ＥＴＣ" });
if (!(await etcRow.textContent()).includes("交通")) throw new Error("ETC should be 交通");

// ---------------------------------------------------------------------------
// 3. 同じメールは二度取り込まれない
// ---------------------------------------------------------------------------
dialogs.length = 0;
listResponses.push([]);
await page.click("#gmail-import-btn");
await page.waitForTimeout(700);
if (!dialogs.some((m) => m.includes("新しい利用通知メールは見つかりませんでした"))) {
  throw new Error("second run should find nothing new: " + dialogs.join(" / "));
}

// ---------------------------------------------------------------------------
// 4. IDでの防止をすり抜けても、内容の重複チェックで弾かれる
// ---------------------------------------------------------------------------
dialogs.length = 0;
listResponses.push([{ id: "msg3" }]);
await page.click("#gmail-import-btn");
await page.waitForTimeout(800);
if (!dialogs.some((m) => m.includes("既に登録済み"))) {
  throw new Error("duplicate content should be caught by the dedupe safety net: " + dialogs.join(" / "));
}
const rowsAfter = await page.locator("#entry-list tr").count();
if (rowsAfter !== 3) throw new Error("no duplicates should be added, rows=" + rowsAfter);

// ---------------------------------------------------------------------------
// 5. 取り込み済みID履歴が消えていない
// ---------------------------------------------------------------------------
dialogs.length = 0;
listResponses.push([{ id: "msg1" }, { id: "msg2" }, { id: "msg3" }]);
await page.click("#gmail-import-btn");
await page.waitForTimeout(800);
if (!dialogs.some((m) => m.includes("新しい利用通知メールは見つかりませんでした"))) {
  throw new Error("the imported-id history was lost: " + dialogs.join(" / "));
}

// ---------------------------------------------------------------------------
// 6. ログアウトするとGmailのトークンを捨てる (共有端末対策)
// ---------------------------------------------------------------------------
await page.locator("#logout-btn").dispatchEvent("click");
await page.waitForTimeout(500);
if (!(await page.locator("#auth-screen").isVisible())) throw new Error("should return to the login screen");

if (errors.filter((e) => !e.includes("access_denied")).length) {
  throw new Error("JS errors: " + errors.join("; "));
}
console.log("ALL GMAIL IMPORT CHECKS PASSED");
await browser.close();
server.close();

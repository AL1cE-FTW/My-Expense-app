// 起動時の各画面 (未セットアップ・SDK読み込み失敗) と、サイドバー・
// スクロール追従・日付での絞り込みをまとめて確認する。
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
await new Promise((r) => server.listen(8995, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const stubRoute = async (page) => {
  await page.route("https://www.gstatic.com/firebasejs/**/*.js", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: fs.readFileSync(path.join(stubRoot, url.pathname.split("/").pop()), "utf-8"),
    });
  });
};

// ---------------------------------------------------------------------------
// 1. Firebase SDK 自体を読み込めないときは、白い画面でなく案内を出す
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage();
  await page.route("https://www.gstatic.com/firebasejs/**/*.js", (r) => r.abort());
  await page.goto("http://localhost:8995/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  if (!(await page.locator("#sdk-error-screen").isVisible())) {
    throw new Error("the SDK error screen should be shown when the SDK cannot load");
  }
  if (await page.locator("#loading-screen").isVisible()) {
    throw new Error("must not stay stuck on 読み込み中");
  }
  // アイコンはSDKより先に差し替える。後回しにすると、この画面の見出しだけ
  // アイコンが空欄のまま出てしまう
  const icons = await page.evaluate(() => ({
    drawn: document.querySelectorAll("#sdk-error-screen svg.icon").length,
    placeholders: document.querySelectorAll("[data-icon]").length,
    empty: [...document.querySelectorAll("svg.icon")].filter((s) => !s.innerHTML.trim()).length,
  }));
  if (icons.drawn === 0 || icons.placeholders > 0 || icons.empty > 0) {
    throw new Error("SDKが読めなくてもアイコンは出るはず: " + JSON.stringify(icons));
  }

  // 原因を通信・拡張機能だけに断定せず、設定の誤りにも触れる
  const body = await page.textContent("#sdk-error-screen");
  for (const expected in { "インターネット": 1, "広告ブロッカー": 1, "firebase-config.js": 1 }) {
    if (!body.includes(expected)) throw new Error(`the guidance should mention ${expected}: ` + body);
  }
  await page.close();
}

// ---------------------------------------------------------------------------
// 1.5 アプリ本体が読めないときも「読み込み中」で固まらない
// ---------------------------------------------------------------------------
// static import しているファイルが1つでも読めないと、モジュールの評価ごと
// 止まって main() も その .catch() も動かない。見張りが案内を出すこと。
{
  const page = await browser.newPage();
  await stubRoute(page);
  // icons.js だけ読めない状態にする (app.js は配信される)
  await page.route("**/js/icons.js", (r) => r.abort());
  await page.goto("http://localhost:8995/", { waitUntil: "domcontentloaded" });
  // 見張りは8秒後に動く
  await page.waitForSelector("#sdk-error-screen:not(.hidden)", { timeout: 15000 });
  if (await page.locator("#loading-screen").isVisible()) {
    throw new Error("「読み込み中」のまま固まってはいけない");
  }
  const causes = await page.textContent("#sdk-error-causes");
  if (!causes.includes("js/app.js")) {
    throw new Error("アプリ本体を読めていない可能性にも触れるはず: " + causes);
  }
  await page.close();
}

// ---------------------------------------------------------------------------
// 2. 設定ファイルが無いときはセットアップ案内を出す
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage();
  await stubRoute(page);
  await page.route("**/js/firebase-config.js", (r) => r.fulfill({ status: 404, body: "nf" }));
  await page.goto("http://localhost:8995/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  if (!(await page.locator("#setup-screen").isVisible())) {
    throw new Error("the setup screen should be shown without a config");
  }
  if (await page.locator("#auth-screen").isVisible()) {
    throw new Error("the login screen must stay hidden without a config");
  }
  await page.close();
}

// ---------------------------------------------------------------------------
// 3. 通常起動: サイドバー・スクロール追従・日付での絞り込み
// ---------------------------------------------------------------------------
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (t.includes("Failed to load resource") || t.includes("net::ERR_")) return;
  errors.push("console: " + t);
});
page.on("dialog", (d) => d.accept());
await stubRoute(page);
await page.goto("http://localhost:8995/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "screens-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

const NOW = new Date();
const CUR_Y = NOW.getFullYear();
const CUR_M = NOW.getMonth() + 1;
const MM = String(CUR_M).padStart(2, "0");
const PREV = new Date(CUR_Y, NOW.getMonth() - 1, 12);
const PREV_DATE = `${PREV.getFullYear()}-${String(PREV.getMonth() + 1).padStart(2, "0")}-12`;

for (const r of [
  { date: `${CUR_Y}-${MM}-05`, category: "食費", amount: "1000", memo: "5日のランチ" },
  { date: `${CUR_Y}-${MM}-05`, category: "交通", amount: "500", memo: "5日の電車" },
  { date: `${CUR_Y}-${MM}-08`, category: "食費", amount: "2000", memo: "8日の夕食" },
  { date: PREV_DATE, category: "日用品", amount: "700", memo: "先月の買い物" },
]) {
  await page.click('.type-option:has(input[value="expense"]) span');
  await page.fill("#entry-date", r.date);
  await page.selectOption("#entry-category", r.category);
  await page.fill("#entry-amount", r.amount);
  await page.fill("#entry-memo", r.memo);
  await page.click("#submit-btn");
  await page.waitForTimeout(150);
}
await page.click("#today-btn");
await page.waitForTimeout(300);

// サイドバーはPC幅では見える
if (!(await page.locator(".app-sidebar").isVisible())) throw new Error("the sidebar should show on desktop");
// リンクを押すとそのセクションへ移動し、見出しがヘッダーの裏に隠れない
await page.click('.sidebar-link[href="#list-section"]');
await page.waitForTimeout(700);
const headerBottom = await page.evaluate(
  () => document.querySelector(".app-header").getBoundingClientRect().bottom
);
const sectionTop = await page.evaluate(
  () => document.getElementById("list-section").getBoundingClientRect().top
);
if (sectionTop < headerBottom - 1) {
  throw new Error(`the section heading is hidden behind the header (top ${sectionTop} < ${headerBottom})`);
}
// 見ているセクションのリンクがハイライトされる
await page.waitForTimeout(400);
if (!(await page.locator('.sidebar-link[href="#list-section"]').evaluate((e) => e.classList.contains("active")))) {
  throw new Error("the sidebar should highlight the section in view");
}

// 日付での絞り込み
if ((await page.locator("#entry-date").count()) === 0) throw new Error("form missing");
let rows = await page.locator("#entry-list tr").count();
if (rows !== 3) throw new Error("expected 3 rows this month, got " + rows);
await page.fill("#filter-date", `${CUR_Y}-${MM}-05`);
await page.waitForTimeout(400);
if ((await page.locator("#entry-list tr").count()) !== 2) throw new Error("date filter should leave 2 rows");
if ((await page.textContent("#list-section-title")).trim() !== `${CUR_Y}年${CUR_M}月5日の記録`) {
  throw new Error("the heading should name the filtered day");
}
// 別の月の日を選ぶと自動でその月へ移動する
await page.fill("#filter-date", PREV_DATE);
await page.waitForTimeout(450);
if ((await page.textContent("#current-month")).trim() !== `${PREV.getFullYear()}年${PREV.getMonth() + 1}月`) {
  throw new Error("picking a date in another month should navigate there");
}
if ((await page.locator("#entry-list tr").count()) !== 1) throw new Error("should show that day's row");
// 月を移動したらフィルタは解除される (行き止まりを作らない)
await page.click("#next-month");
await page.waitForTimeout(400);
if ((await page.locator("#filter-date").inputValue()) !== "") {
  throw new Error("moving months should clear the date filter");
}
if ((await page.textContent("#list-section-title")).trim() !== "今月の記録") {
  throw new Error("the heading should revert after clearing");
}

// スマホ幅ではサイドバーが消える
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
if (await page.locator(".app-sidebar").isVisible()) {
  throw new Error("the sidebar should be hidden on narrow screens");
}

// --- スマホ幅で中身が左に寄らない ---
// 収入を入れて Need/Want/Save を描画させる
await page.click('.type-option:has(input[value="income"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-25`);
await page.selectOption("#entry-category", "給与");
await page.fill("#entry-amount", "280000");
await page.fill("#entry-memo", "給与");
await page.click("#submit-btn");
await page.waitForTimeout(500);
await page.click("#today-btn");
await page.waitForTimeout(400);

// ドーナツは、折り返して1段になったとき左端に張り付かず中央に来る
const donut = await page.evaluate(() => {
  const wrap = document.querySelector(".nws-wrapper").getBoundingClientRect();
  const chart = document.querySelector("#nws-chart").getBoundingClientRect();
  return { leftGap: Math.round(chart.left - wrap.left), rightGap: Math.round(wrap.right - chart.right) };
});
console.log("donut gaps (mobile):", JSON.stringify(donut));
if (Math.abs(donut.leftGap - donut.rightGap) > 2) {
  throw new Error(
    `the donut should be centred on narrow screens (left ${donut.leftGap}, right ${donut.rightGap})`
  );
}

// ページが横にはみ出していない。はみ出すと iOS Safari はページ全体を縮小
// して表示するので、中身が左に寄って右に背景色の帯が出る (Chrome だと
// 横スクロールできないので気づきにくいが、documentElement.scrollWidth と
// フルページのスクリーンショットにはちゃんと出る)。
const overflow = await page.evaluate(() => {
  window.scrollTo(400, window.scrollY);
  const scrolledX = window.scrollX;
  window.scrollTo(0, window.scrollY);
  const vw = document.documentElement.clientWidth;
  const stickingOut = [];
  for (const e of document.querySelectorAll("body *")) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right <= vw + 0.5) continue;
    // 自前で横スクロールする領域 (表など) の中身は、はみ出していて当然
    let inScroller = false;
    for (let p = e.parentElement; p; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowX;
      if (ov !== "visible") { inScroller = true; break; }
    }
    if (inScroller) continue;
    stickingOut.push(e.tagName + (e.id ? "#" + e.id : "") + "." + e.className);
  }
  return {
    scrolledX,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    vw,
    stickingOut: stickingOut.slice(0, 5),
  };
});
if (
  overflow.scrolledX > 0 ||
  overflow.docScrollW > overflow.vw + 1 ||
  overflow.bodyScrollW > overflow.vw + 1 ||
  overflow.stickingOut.length
) {
  throw new Error(`the page must not overflow horizontally on mobile: ${JSON.stringify(overflow)}`);
}

// PCに戻すと横並びのまま (ドーナツは左、凡例が残りを埋める)
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(400);
const desktopDonut = await page.evaluate(() => {
  const wrap = document.querySelector(".nws-wrapper").getBoundingClientRect();
  const chart = document.querySelector("#nws-chart").getBoundingClientRect();
  const legend = document.querySelector("#nws-legend").getBoundingClientRect();
  return { leftGap: Math.round(chart.left - wrap.left), sameRow: Math.abs(chart.top - legend.top) < 200 };
});
if (desktopDonut.leftGap > 2 || !desktopDonut.sameRow) {
  throw new Error("the desktop side-by-side layout should be unchanged: " + JSON.stringify(desktopDonut));
}
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);

// --- スマホ幅で入力欄の高さと縦位置が揃っている ---
// 日付39.2px・選択39px・数値37px・種別トグル43px とバラバラだと、横に並べた
// ときに下端が数pxずつずれて「なんとなく斜め」に見える。
const controls = await page.evaluate(() => {
  const pick = (sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), height: +r.height.toFixed(1) };
  };
  return {
    日付: pick("#entry-date"),
    種別: pick(".type-toggle"),
    カテゴリ: pick("#entry-category"),
    金額: pick("#entry-amount"),
    口座: pick("#entry-settlement"),
  };
});
console.log("入力欄:", JSON.stringify(controls));
const heights = new Set(Object.values(controls).map((c) => c.height));
if (heights.size !== 1) {
  throw new Error("入力欄の高さは揃っているはず: " + JSON.stringify(controls));
}
if (controls.日付.top !== controls.種別.top || controls.日付.bottom !== controls.種別.bottom) {
  throw new Error("横に並ぶ欄は上端も下端も揃うはず: " + JSON.stringify(controls));
}
if (controls.カテゴリ.top !== controls.金額.top || controls.カテゴリ.bottom !== controls.金額.bottom) {
  throw new Error("カテゴリと金額が揃っていない: " + JSON.stringify(controls));
}

// --- スマホ幅で指で押せる大きさがある ---
const tiny = await page.evaluate(() => {
  const out = [];
  for (const sel of ["#prev-month", "#next-month", "#today-btn", "#submit-btn",
                     '.view-tab', ".advance-checkbox"]) {
    const e = document.querySelector(sel);
    const r = e.getBoundingClientRect();
    if (r.height < 44) out.push(`${sel}: ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out;
});
if (tiny.length) throw new Error("よく押すものは44px以上にするはず: " + tiny.join(", "));

// --- よく使う2つが上のほうにある ---
const order = await page.evaluate(() => {
  const top = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top + window.scrollY);
  return { 入力: top("#entry-form-slot"), 一覧: top("#list-section"), 予算: top("#budget-section") };
});
console.log("位置:", JSON.stringify(order));
if (order.一覧 > order.予算) throw new Error("記録一覧は予算より上にあるはず: " + JSON.stringify(order));
if (order.入力 > 700) throw new Error("入力フォームが下すぎる: " + JSON.stringify(order));

await page.screenshot({ path: path.join(scratch, "screens.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL SCREEN/NAVIGATION CHECKS PASSED");
await browser.close();
server.close();

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

// --- PC: 記録一覧の右に入力欄が並び、編集はその場 (右側) で行う ---
const workspace = await page.evaluate(() => {
  const list = document.getElementById("list-section").getBoundingClientRect();
  const form = document.getElementById("entry-form-slot").getBoundingClientRect();
  return { formRightOfList: form.left >= list.right - 1, sameTop: Math.abs(form.top - list.top) < 2 };
});
if (!workspace.formRightOfList || !workspace.sameTop) {
  throw new Error("PCでは一覧の右に入力欄が並ぶはず: " + JSON.stringify(workspace));
}
await page.locator("#entry-list tr", { hasText: "8日の夕食" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
const railEdit = await page.evaluate(() => ({
  modal: !document.getElementById("entry-edit-modal").classList.contains("hidden"),
  title: document.getElementById("form-title").textContent,
  memo: document.getElementById("entry-memo").value,
  marked: document.querySelector("#entry-list tr.is-editing")?.textContent.includes("8日の夕食"),
}));
if (railEdit.modal || railEdit.title !== "記録を編集" || railEdit.memo !== "8日の夕食" || !railEdit.marked) {
  throw new Error("PCでは右側の入力欄で編集するはず: " + JSON.stringify(railEdit));
}
// 編集中に N (記録を追加) を押したら、編集をやめて追加に戻る。
// そのままだと、新しい記録のつもりで打った内容で編集中の記録を上書きしてしまう
await page.locator("body").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("n");
await page.waitForTimeout(300);
const nWhileEditing = await page.evaluate(() => ({
  title: document.getElementById("form-title").textContent,
  id: document.getElementById("entry-id").value,
  focus: document.activeElement?.id,
}));
if (nWhileEditing.title !== "記録を追加" || nWhileEditing.id !== "" || nWhileEditing.focus !== "entry-amount") {
  throw new Error("編集中に N を押したら追加に戻るはず: " + JSON.stringify(nWhileEditing));
}
await page.locator("#entry-list tr", { hasText: "8日の夕食" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
// 編集中に月を移動したら、編集をやめて追加に戻る (編集中の行が一覧から消えるため)
await page.click("#prev-month");
await page.waitForTimeout(300);
const afterMove = await page.evaluate(() => ({
  title: document.getElementById("form-title").textContent,
  id: document.getElementById("entry-id").value,
  submit: document.getElementById("submit-btn").textContent,
}));
if (afterMove.title !== "記録を追加" || afterMove.id !== "" || afterMove.submit !== "追加") {
  throw new Error("月を移動したら編集をやめるはず: " + JSON.stringify(afterMove));
}
await page.click("#today-btn");
await page.waitForTimeout(300);
await page.locator("#entry-list tr", { hasText: "8日の夕食" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
// Esc で編集をやめて追加に戻る (そのまま次の記録を入れても上書きしない)
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
if ((await page.textContent("#form-title")) !== "記録を追加" || (await page.inputValue("#entry-id")) !== "") {
  throw new Error("Esc で編集をやめるはず");
}

// --- PC: 長いメモや立替の印があっても、表は列の幅に収まる ---
// (右に入力欄があるので、はみ出すと操作ボタンが枠の外に押し出される)
await page.click('.type-option:has(input[value="expense"]) span');
await page.fill("#entry-date", `${CUR_Y}-${MM}-09`);
await page.selectOption("#entry-category", "趣味・娯楽");
await page.fill("#entry-amount", "123456");
await page.fill("#entry-memo", "とても長いメモ".repeat(8));
await page.check("#entry-advance");
await page.click("#submit-btn");
await page.waitForTimeout(400);
const fits = await page.evaluate(() => {
  const card = document.getElementById("list-section").getBoundingClientRect();
  const out = [];
  for (const btn of document.querySelectorAll("#entry-list button")) {
    const r = btn.getBoundingClientRect();
    if (r.right > card.right - 8 || r.left < card.left) out.push(btn.getAttribute("aria-label"));
  }
  return out;
});
if (fits.length) throw new Error("一覧の操作ボタンが枠からはみ出している: " + fits.join(", "));
// 作業台が出る一番狭い幅 (1200px) でも、メモの列が読める幅で残る
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForTimeout(300);
const narrowPc = await page.evaluate(() => {
  const memo = document.querySelector("#list-section thead th:nth-child(5)").getBoundingClientRect().width;
  const card = document.getElementById("list-section").getBoundingClientRect();
  const out = [...document.querySelectorAll("#entry-list button")].filter((b) => b.getBoundingClientRect().right > card.right - 8).length;
  return { memo: Math.round(memo), out };
});
if (narrowPc.memo < 80 || narrowPc.out) {
  throw new Error("幅1200pxでメモの列が潰れる・ボタンがはみ出す: " + JSON.stringify(narrowPc));
}
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);
await page.locator("#entry-list tr", { hasText: "とても長いメモ" }).locator("button", { hasText: "削除" }).click();
await page.waitForTimeout(300);

// --- PC: 編集中の行を自分で削除しても、「別の端末で削除」とは言わない ---
const seenDialogs = [];
const recordDialog = (d) => seenDialogs.push(d.message());
page.on("dialog", recordDialog);
await page.locator("#entry-list tr", { hasText: "5日の電車" }).locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
await page.locator("#entry-list tr", { hasText: "5日の電車" }).locator("button", { hasText: "削除" }).click();
await page.waitForTimeout(400);
page.off("dialog", recordDialog);
if (seenDialogs.some((m) => m.includes("別の端末"))) {
  throw new Error("自分で消したのに「別の端末で削除」と出た: " + seenDialogs.join(" / "));
}
if ((await page.textContent("#form-title")) !== "記録を追加") throw new Error("編集中の行を消したら編集をやめるはず");

// --- PC: キーボードショートカット (入力中は効かない) ---
await page.locator("body").click({ position: { x: 5, y: 5 } });
const monthBefore = (await page.textContent("#current-month")).trim();
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(300);
if ((await page.textContent("#current-month")).trim() === monthBefore) throw new Error("← で前の月へ移るはず");
await page.keyboard.press("t");
await page.waitForTimeout(300);
if ((await page.textContent("#current-month")).trim() !== monthBefore) throw new Error("T で今月に戻るはず");
await page.keyboard.press("n");
await page.waitForTimeout(300);
if ((await page.evaluate(() => document.activeElement?.id)) !== "entry-amount") throw new Error("N で金額の欄へ移るはず");
await page.keyboard.type("12");
if ((await page.inputValue("#entry-amount")) !== "12") throw new Error("入力中の文字はショートカットに取られないはず");
await page.fill("#entry-amount", "");
await page.locator("#entry-memo").focus();
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(200);
if ((await page.textContent("#current-month")).trim() !== monthBefore) throw new Error("入力欄の中の矢印キーで月が変わってはいけない");

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

// スマホでは画面が「ホーム / 予算・分析 / 帳簿」の3つに分かれる。
// ホームには入力と一覧だけがあり、予算や帳簿は出ない
const panels = await page.evaluate(() => {
  const shown = (id) => !!document.getElementById(id).offsetParent;
  return {
    tabBar: document.querySelector(".tab-bar").getBoundingClientRect().height > 0,
    form: shown("entry-form-slot"),
    list: shown("list-section"),
    budget: shown("budget-section"),
    book: shown("bookkeeping-section"),
  };
});
if (!panels.tabBar || !panels.form || !panels.list || panels.budget || panels.book) {
  throw new Error("スマホのホームは入力と一覧だけのはず: " + JSON.stringify(panels));
}
await page.click('.tab-btn[data-tab="budget"]');
await page.waitForTimeout(400);
const budgetPanels = await page.evaluate(() => ({
  budget: !!document.getElementById("budget-section").offsetParent,
  nws: !!document.getElementById("nws-section").offsetParent,
  form: !!document.getElementById("entry-form-slot").offsetParent,
  current: document.querySelector('.tab-btn[data-tab="budget"]').getAttribute("aria-current"),
}));
const firstInBudgetTab = await page.evaluate(() =>
  [...document.querySelectorAll("[data-panel='budget']")]
    .filter((e) => e.offsetParent)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]?.id
);
if (firstInBudgetTab !== "nws-section") {
  throw new Error("「予算・分析」タブの一番上は Need/Want/Save のはず: " + firstInBudgetTab);
}
if (!budgetPanels.budget || !budgetPanels.nws || budgetPanels.form || budgetPanels.current !== "page") {
  throw new Error("「予算・分析」タブで予算が出るはず: " + JSON.stringify(budgetPanels));
}

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

// 「＋」でホームの入力欄へ戻り、金額から打ち始められる
await page.click("#tab-add-btn");
await page.waitForTimeout(700);
const afterAdd = await page.evaluate(() => ({
  tab: document.getElementById("app-root").dataset.tab,
  focused: document.activeElement?.id,
  formTop: Math.round(document.getElementById("entry-form-slot").getBoundingClientRect().top),
}));
if (afterAdd.tab !== "home" || afterAdd.focused !== "entry-amount" || afterAdd.formTop > 300) {
  throw new Error("「＋」で入力欄の金額に移るはず: " + JSON.stringify(afterAdd));
}

// PCではタブを使わず、全部のセクションが1ページに並ぶ。
// Need/Want/Save は横に並べた半分幅のカードに入るので、ドーナツと凡例が
// 横に並ぶか、折り返したときはドーナツが中央に来る (左に張り付かない)
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(400);
const desktopDonut = await page.evaluate(() => {
  const wrap = document.querySelector(".nws-wrapper").getBoundingClientRect();
  const chart = document.querySelector("#nws-chart").getBoundingClientRect();
  const legend = document.querySelector("#nws-legend").getBoundingClientRect();
  return {
    leftGap: Math.round(chart.left - wrap.left),
    rightGap: Math.round(wrap.right - chart.right),
    sameRow: Math.abs(chart.top - legend.top) < 100,
    tabBar: document.querySelector(".tab-bar").getBoundingClientRect().height > 0,
    budgetShown: !!document.getElementById("budget-section").offsetParent,
    formShown: !!document.getElementById("entry-form-slot").offsetParent,
  };
});
const donutOk = desktopDonut.sameRow
  ? desktopDonut.leftGap <= 2
  : Math.abs(desktopDonut.leftGap - desktopDonut.rightGap) <= 2;
if (!donutOk || desktopDonut.tabBar || !desktopDonut.budgetShown || !desktopDonut.formShown) {
  throw new Error("PCのレイアウトが崩れている: " + JSON.stringify(desktopDonut));
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
const heights = new Set(
  Object.entries(controls).filter(([k]) => k !== "金額").map(([, c]) => c.height)
);
if (heights.size !== 1) {
  throw new Error("入力欄の高さは揃っているはず: " + JSON.stringify(controls));
}
// スマホでは種別 (支出・収入・貯蓄・振替の4つ) が1段まるごと使って先頭に来る。
// 半分の幅だと1つ38pxしかなく押しにくいため
if (!(controls.種別.bottom <= controls.日付.top)) {
  throw new Error("種別は先頭の段に来るはず: " + JSON.stringify(controls));
}
const typeWidths = await page.evaluate(() =>
  [...document.querySelectorAll(".type-option span")].map((e) => Math.round(e.getBoundingClientRect().width))
);
if (typeWidths.length !== 4 || typeWidths.some((w) => w < 44)) {
  throw new Error("種別の選択肢は4つで、それぞれ44px以上のはず: " + typeWidths.join(","));
}
if (controls.日付.top !== controls.カテゴリ.top || controls.日付.bottom !== controls.カテゴリ.bottom) {
  throw new Error("横に並ぶ欄は上端も下端も揃うはず: " + JSON.stringify(controls));
}
// 金額は入力の主役なので、スマホでは1段まるごと使って大きく出す
if (!(controls.金額.bottom <= controls.日付.top) || controls.金額.height < controls.日付.height) {
  throw new Error("金額は日付・カテゴリより上に、大きく出るはず: " + JSON.stringify(controls));
}
const memoRow = await page.evaluate(() => {
  const m = document.getElementById("entry-memo").getBoundingClientRect();
  const a = document.getElementById("entry-settlement").getBoundingClientRect();
  return { memoTop: m.top, memoBottom: m.bottom, accTop: a.top, accBottom: a.bottom };
});
if (memoRow.memoTop !== memoRow.accTop || memoRow.memoBottom !== memoRow.accBottom) {
  throw new Error("メモと口座が揃っていない: " + JSON.stringify(memoRow));
}

// --- スマホ幅で指で押せる大きさがある ---
// (入力欄にフォーカスがあると下のタブは隠れるので、外してから測る)
await page.evaluate(() => document.activeElement?.blur());
const tiny = await page.evaluate(() => {
  const out = [];
  for (const sel of ["#prev-month", "#next-month", "#today-btn", "#submit-btn",
                     '.view-tab', ".advance-checkbox", "#logout-btn", ".tab-btn", "#tab-add-btn"]) {
    const e = document.querySelector(sel);
    const r = e.getBoundingClientRect();
    if (r.height < 44) out.push(`${sel}: ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out;
});
if (tiny.length) throw new Error("よく押すものは44px以上にするはず: " + tiny.join(", "));

// --- よく使う2つが上のほうにある ---
await page.evaluate(() => window.scrollTo(0, 0));
const order = await page.evaluate(() => {
  const top = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top + window.scrollY);
  return { 入力: top("#entry-form-slot"), 一覧: top("#list-section") };
});
console.log("位置:", JSON.stringify(order));
if (order.一覧 < order.入力) throw new Error("一覧は入力の下にあるはず: " + JSON.stringify(order));
if (order.入力 > 700) throw new Error("入力フォームが下すぎる: " + JSON.stringify(order));

// ---------------------------------------------------------------------------
// スマホのレビューで見つかった不具合の再発防止
// ---------------------------------------------------------------------------
// 同じ日の2件目以降も、スマホのカードでは日付を出す (表ではないのでまとまりが見えない)
const sameDayDates = await page.evaluate(() =>
  [...document.querySelectorAll("#entry-list tr.same-day td.date-cell")].map((td) => getComputedStyle(td).color)
);
if (sameDayDates.some((c) => c === "rgba(0, 0, 0, 0)")) {
  throw new Error("スマホでは同じ日の記録にも日付を出すはず");
}
// 文字を入力しているあいだは、下のタブがキーボードの上で入力欄を覆わないよう隠す
await page.locator("#entry-memo").focus();
if ((await page.locator(".tab-bar").evaluate((e) => getComputedStyle(e).display)) !== "none") {
  throw new Error("入力中は下のタブを隠すはず");
}
await page.locator("#entry-memo").blur();
// 帳簿の合計試算表は、一覧用のカード表示に巻き込まれず表のまま
await page.click('.tab-btn[data-tab="book"]');
await page.waitForTimeout(300);
await page.click('.book-tab[data-book="trial"]');
await page.waitForTimeout(300);
const trial = await page.evaluate(() => {
  const t = document.querySelector("#bookkeeping-body table");
  return t && { display: getComputedStyle(t).display, head: getComputedStyle(t.tHead).position };
});
if (!trial || trial.display !== "table" || trial.head === "absolute") {
  throw new Error("合計試算表は表のまま出るはず: " + JSON.stringify(trial));
}
// 年間の棒グラフは12か月とも画面 (カード) の中に収まる
await page.click('.tab-btn[data-tab="home"]');
await page.click('.view-tab[data-view="year"]');
await page.waitForTimeout(500);
const yearFit = await page.evaluate(() => {
  const card = document.getElementById("yearly-chart-section").getBoundingClientRect();
  return [...document.querySelectorAll("#monthly-bar-chart .month-bar-group")]
    .filter((g) => g.getBoundingClientRect().right > card.right + 1).length;
});
if (yearFit) throw new Error(`年間グラフの ${yearFit} か月分がカードの外にはみ出している`);
await page.click('.view-tab[data-view="month"]');
await page.waitForTimeout(300);
// 幅320pxの端末でも、月の移動ボタンが画面に収まり、金額が「…」で切れない
await page.setViewportSize({ width: 320, height: 640 });
await page.waitForTimeout(400);
const narrow = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const off = ["#prev-month", "#next-month", "#today-btn", "#logout-btn"].filter(
    (sel) => document.querySelector(sel).getBoundingClientRect().right > vw
  );
  const cut = [...document.querySelectorAll(".summary-cards .card-value")]
    .filter((e) => e.scrollWidth > e.clientWidth + 1)
    .map((e) => e.textContent);
  return { off, cut };
});
if (narrow.off.length || narrow.cut.length) {
  throw new Error("幅320pxで画面からはみ出す・金額が切れる: " + JSON.stringify(narrow));
}
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);

await page.screenshot({ path: path.join(scratch, "screens.png"), fullPage: true });
if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL SCREEN/NAVIGATION CHECKS PASSED");
await browser.close();
server.close();

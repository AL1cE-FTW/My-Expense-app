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
await new Promise((r) => server.listen(8981, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
// スマホ相当。フォームと一覧の距離がいちばん問題になるサイズ
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (text.includes("Failed to load resource") || text.includes("net::ERR_")) return;
  errors.push("console: " + text);
});
page.on("dialog", (d) => d.accept());

await page.route("https://www.gstatic.com/firebasejs/**/*.js", async (route) => {
  const url = new URL(route.request().url());
  await route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: fs.readFileSync(path.join(stubRoot, url.pathname.split("/").pop()), "utf-8"),
  });
});

const NOW = new Date();
const CUR_Y = NOW.getFullYear();
const MM = String(NOW.getMonth() + 1).padStart(2, "0");

await page.goto("http://localhost:8981/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);

await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "edit-modal-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

// 一覧が画面下まで伸びるよう、そこそこの件数を入れる
for (let i = 1; i <= 12; i++) {
  await page.fill("#entry-date", `${CUR_Y}-${MM}-${String(i).padStart(2, "0")}`);
  await page.selectOption("#entry-category", "食費");
  await page.fill("#entry-amount", String(1000 + i));
  await page.fill("#entry-memo", `記録${i}`);
  await page.click("#submit-btn");
  await page.waitForTimeout(80);
}
await page.click("#today-btn");
await page.waitForTimeout(300);

const targetRow = () => page.locator("#entry-list tr", { hasText: "記録7" });

// ---------------------------------------------------------------------------
// 1. 「編集」を押してもページがスクロールしない
// ---------------------------------------------------------------------------
await targetRow().locator("button", { hasText: "編集" }).scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const scrollBefore = await page.evaluate(() => window.scrollY);
const rowTopBefore = await targetRow().evaluate((elem) => elem.getBoundingClientRect().top);

await targetRow().locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(500); // スムーススクロールが起きるなら十分な時間

if (!(await page.locator("#entry-edit-modal").isVisible())) {
  throw new Error("editing should open the popup");
}

// 見ていた行が画面上の同じ位置に留まっていること。
// (背景スクロールを止めるため body を位置固定するので window.scrollY は 0 になる。
//  実際に効くのは「見えている位置が動かないこと」なのでそちらで確かめる)
const rowTopDuring = await targetRow().evaluate((elem) => elem.getBoundingClientRect().top);
console.log("row top:", Math.round(rowTopBefore), "->", Math.round(rowTopDuring));
if (Math.abs(rowTopDuring - rowTopBefore) > 4) {
  throw new Error(
    `the row must stay put while editing (was ${rowTopBefore}, now ${rowTopDuring})`
  );
}

// 開いているあいだは裏のページがスクロールしない
await page.mouse.wheel(0, 500);
await page.waitForTimeout(200);
const rowTopAfterWheel = await targetRow().evaluate((elem) => elem.getBoundingClientRect().top);
if (Math.abs(rowTopAfterWheel - rowTopBefore) > 4) {
  throw new Error(
    `the background must not scroll while the popup is open (row moved to ${rowTopAfterWheel})`
  );
}

// ---------------------------------------------------------------------------
// 2. ポップアップの中に入力フォームがあり、値が入っている
// ---------------------------------------------------------------------------
const formInModal = await page.evaluate(
  () => !!document.getElementById("entry-edit-body")?.contains(document.getElementById("entry-form"))
);
if (!formInModal) throw new Error("the entry form should be inside the popup");

if ((await page.locator("#entry-memo").inputValue()) !== "記録7") {
  throw new Error("the popup should be populated with the row's values");
}
if ((await page.locator("#submit-btn").textContent()).trim() !== "更新") {
  throw new Error("the submit button should read 更新 while editing");
}
// 開いた直後はカテゴリにフォーカスがある (直したいのはたいていカテゴリなので)
const focusedId = await page.evaluate(() => document.activeElement?.id);
if (focusedId !== "entry-category") {
  throw new Error("opening the popup should focus the category select, got " + focusedId);
}
// 追加用の見出しは「記録を追加」のまま、ポップアップ側が「記録を編集」
if ((await page.locator("#form-title").textContent()).trim() !== "記録を追加") {
  throw new Error("the inline heading should stay as the add-form heading");
}
if ((await page.locator("#entry-edit-title").textContent()).trim() !== "記録を編集") {
  throw new Error("the popup title should read 記録を編集");
}

// ---------------------------------------------------------------------------
// 3. カテゴリを変えて更新 -> 反映され、ポップアップが閉じ、フォームが元に戻る
// ---------------------------------------------------------------------------
await page.selectOption("#entry-category", "交通");
await page.click("#submit-btn");
await page.waitForTimeout(500);

if (await page.locator("#entry-edit-modal").isVisible()) {
  throw new Error("the popup should close after updating");
}
const backInPlace = await page.evaluate(
  () => !!document.getElementById("entry-form-slot")?.contains(document.getElementById("entry-form"))
);
if (!backInPlace) throw new Error("the form must be moved back into the page after closing");
if ((await page.locator("#form-title").textContent()).trim() !== "記録を追加") {
  throw new Error("the inline form should be back in add mode");
}
if ((await page.locator("#submit-btn").textContent()).trim() !== "追加") {
  throw new Error("the submit button should read 追加 again");
}
// 予約していた高さが解除されている
const reservedHeight = await page.evaluate(
  () => document.getElementById("entry-form-slot").style.minHeight
);
if (reservedHeight !== "") throw new Error("the reserved height should be cleared, got " + reservedHeight);

const updatedRow = await targetRow().textContent();
if (!updatedRow.includes("交通")) throw new Error("the change should be saved: " + updatedRow);

// 閉じたら、編集していた行が元と同じ位置に見えている。
// (スクロール量の数値ではなく行の位置で見る。更新でページの高さが変わることが
//  あるため、同じ数値に戻すと別の場所が映ってしまう)
const rowTopAfterClose = await targetRow().evaluate((elem) => elem.getBoundingClientRect().top);
console.log("row top after closing:", Math.round(rowTopBefore), "->", Math.round(rowTopAfterClose));
if (Math.abs(rowTopAfterClose - rowTopBefore) > 4) {
  throw new Error(`closing should leave the row where it was (${rowTopBefore} -> ${rowTopAfterClose})`);
}
if (await page.evaluate(() => document.body.classList.contains("modal-open"))) {
  throw new Error("the scroll lock should be released after closing");
}
if (await page.evaluate(() => document.body.style.top !== "" || document.body.style.paddingRight !== "")) {
  throw new Error("the scroll lock should clean up its inline styles");
}

// 更新後、フォーカスは同じ行の「編集」ボタンへ戻る
const focusedAfter = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
if (!focusedAfter || !focusedAfter.includes("を編集")) {
  throw new Error("focus should return to the edited row's edit button, got " + focusedAfter);
}

// ---------------------------------------------------------------------------
// 4. キャンセル・× ・Escape・背景クリックのどれで閉じてもフォームが戻る
// ---------------------------------------------------------------------------
for (const [name, close] of [
  ["キャンセルボタン", async () => page.click("#cancel-edit-btn")],
  ["×ボタン", async () => page.click("#entry-edit-close")],
  ["Escape", async () => page.keyboard.press("Escape")],
  ["背景クリック", async () => page.locator("#entry-edit-modal").click({ position: { x: 5, y: 5 } })],
]) {
  await targetRow().locator("button", { hasText: "編集" }).click();
  await page.waitForTimeout(300);
  if (!(await page.locator("#entry-edit-modal").isVisible())) {
    throw new Error(`popup should be open before closing via ${name}`);
  }
  await close();
  await page.waitForTimeout(300);
  if (await page.locator("#entry-edit-modal").isVisible()) {
    throw new Error(`${name} should close the popup`);
  }
  const restored = await page.evaluate(
    () => !!document.getElementById("entry-form-slot")?.contains(document.getElementById("entry-form"))
  );
  if (!restored) throw new Error(`${name} should move the form back into the page`);
  if ((await page.locator("#entry-id").inputValue()) !== "") {
    throw new Error(`${name} should leave edit mode`);
  }
}

// ---------------------------------------------------------------------------
// 5. 給与明細の内訳を含む編集もポップアップの中で完結する
// ---------------------------------------------------------------------------
await page.click('.type-option:has(input[value="income"]) span');
await page.selectOption("#entry-category", "給与");
await page.fill("#entry-date", `${CUR_Y}-${MM}-25`);
await page.click("#payslip-toggle-btn");
await page.waitForTimeout(200);
await page.fill("#payslip-base-salary", "300000");
await page.fill("#payslip-health-insurance", "15000");
await page.fill("#entry-memo", "給与テスト");
await page.click("#submit-btn");
await page.waitForTimeout(400);
await page.click("#today-btn");
await page.waitForTimeout(300);

const payslipRow = page.locator("#entry-list tr", { hasText: "給与テスト" });
await payslipRow.locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(400);

if (!(await page.locator("#entry-edit-modal").isVisible())) {
  throw new Error("editing a payslip entry should also open the popup");
}
if ((await page.locator("#payslip-base-salary").inputValue()) !== "300000") {
  throw new Error("the payslip breakdown should be restored inside the popup");
}
// 長いフォームでもポップアップの中でスクロールし、画面からはみ出さない
const boxFits = await page.evaluate(() => {
  const box = document.querySelector("#entry-edit-modal .modal-box");
  return box.getBoundingClientRect().height <= window.innerHeight + 1;
});
if (!boxFits) throw new Error("the popup must not overflow the viewport with a long form");

await page.click("#cancel-edit-btn");
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// 6. 一覧の途中の行を編集しても、見ていた位置が動かない
// ---------------------------------------------------------------------------
// Safari にはスクロールアンカリング (高さが変わったときの自動補正) が無いため、
// それを切った状態で確かめる。切らないと Chrome が補正してしまい、
// iPhone でだけ起きるずれを見逃す。
await page.addStyleTag({ content: "*{overflow-anchor:none !important}" });

// 一覧を長くして、編集する行が画面の途中に来るようにする
for (let i = 13; i <= 34; i++) {
  await page.fill("#entry-date", `${CUR_Y}-${MM}-${String((i % 28) + 1).padStart(2, "0")}`);
  await page.selectOption("#entry-category", "食費");
  await page.fill("#entry-amount", String(1000 + i));
  await page.fill("#entry-memo", `記録${i}`);
  await page.click("#submit-btn");
  await page.waitForTimeout(50);
}
await page.click("#today-btn");
await page.waitForTimeout(400);

const rowTopOf = (memo) =>
  page.evaluate((m) => {
    const tr = [...document.querySelectorAll("#entry-list tr")].find((r) => r.textContent.includes(m));
    return tr ? Math.round(tr.getBoundingClientRect().top) : null;
  }, memo);
const centerOn = (memo) =>
  page.evaluate((m) => {
    const tr = [...document.querySelectorAll("#entry-list tr")].find((r) => r.textContent.includes(m));
    tr.scrollIntoView({ block: "center", behavior: "instant" });
  }, memo);
const clickEditOf = (memo) =>
  page.evaluate((m) => {
    const tr = [...document.querySelectorAll("#entry-list tr")].find((r) => r.textContent.includes(m));
    [...tr.querySelectorAll("button")].find((b) => b.textContent.trim() === "編集").click();
  }, memo);

// 入力フォームに給与明細の内訳を開いておく。この状態で支出の行を編集すると
// フォームの高さが 900px 以上変わるので、位置がずれやすい
async function openTallAddForm() {
  await page.click('.type-option:has(input[value="income"]) span');
  await page.selectOption("#entry-category", "給与");
  await page.waitForTimeout(200);
  await page.click("#payslip-toggle-btn");
  await page.waitForTimeout(300);
}

for (const [name, prepare, close] of [
  ["そのまま閉じる", null, async () => page.keyboard.press("Escape")],
  ["更新して閉じる", null, async () => {
    await page.selectOption("#entry-category", "交通");
    await page.click("#submit-btn");
  }],
  ["内訳を開いた状態から閉じる", openTallAddForm, async () => page.keyboard.press("Escape")],
  ["内訳を開いた状態から更新", openTallAddForm, async () => {
    await page.selectOption("#entry-category", "日用品");
    await page.click("#submit-btn");
  }],
]) {
  await page.click("#today-btn");
  await page.waitForTimeout(300);
  if (prepare) await prepare();
  await centerOn("記録20");
  await page.waitForTimeout(400);

  const top0 = await rowTopOf("記録20");
  await clickEditOf("記録20");
  await page.waitForTimeout(500);
  const topOpen = await rowTopOf("記録20");
  if (Math.abs(topOpen - top0) > 4) {
    throw new Error(`[${name}] 開いた瞬間に一覧がずれた: ${top0} -> ${topOpen}`);
  }
  await close();
  await page.waitForTimeout(700);
  const topClosed = await rowTopOf("記録20");
  if (Math.abs(topClosed - top0) > 4) {
    throw new Error(`[${name}] 閉じたあとに一覧がずれた: ${top0} -> ${topClosed}`);
  }
  console.log(`  ${name}: ${top0} -> ${topOpen} -> ${topClosed}`);
}

// ---------------------------------------------------------------------------
// 7. ポップアップを開いたままログアウトしても、フォームが行方不明にならない
// ---------------------------------------------------------------------------
await targetRow().locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
await page.locator("#logout-btn").dispatchEvent("click");
await page.waitForTimeout(500);

if (await page.locator("#entry-edit-modal").isVisible()) {
  throw new Error("the popup must not stay open over the login screen");
}
const restoredAfterLogout = await page.evaluate(
  () => !!document.getElementById("entry-form-slot")?.contains(document.getElementById("entry-form"))
);
if (!restoredAfterLogout) throw new Error("the form must be back in the page after logging out");

await page.screenshot({ path: path.join(scratch, "edit-modal.png"), fullPage: true });

if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL EDIT POPUP CHECKS PASSED");
await browser.close();
server.close();

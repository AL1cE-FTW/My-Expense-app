// 要確認 (js/review.js とアプリの表示) を確かめる。
// - 取り込んだのに「その他」のまま・60日たっても仮のまま・いつもの5倍以上の金額を拾う
// - 手入力・給与天引きの家賃・固定費・確認済み・古い記録は拾わない
// - 「このままでOK」で消え、「直す」で編集が始まる
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { reviewItems } from "../js/review.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------
// 1. 拾う記録の判定
// ---------------------------------------------------------------------------
{
  const e = (id, over) => ({ id, type: "expense", category: "食費", amount: 1000, date: "2026-10-10", ...over });
  const entries = [
    e("other", { category: "その他支出", source: "gmail" }),
    e("other-manual", { category: "その他支出" }),
    e("stale", { source: "gmail", date: "2026-08-01" }),
    e("fresh-pending", { source: "gmail", date: "2026-10-01" }),
    e("f1"), e("f2"), e("f3", { amount: 1200 }),
    e("huge", { amount: 2733690, source: "gmail" }),
    e("big-small", { amount: 6000 }), // 6倍でも 1万円未満は拾わない
    e("rent", { category: "住居", amount: 25000, payslipHousingFor: "salary1" }),
    e("r1", { category: "住居", amount: 500 }), e("r2", { category: "住居", amount: 600 }), e("r3", { category: "住居", amount: 700 }),
    e("fixed", { category: "住居", amount: 50000, recurring: "abc" }),
    e("ok", { category: "その他支出", source: "card", reviewed: true }),
    e("old", { category: "その他支出", source: "gmail", date: "2026-01-01" }),
    { id: "income", type: "income", category: "その他収入", amount: 9999999, date: "2026-10-10", source: "card" },
  ];
  const got = reviewItems(entries, "2026-10-30");
  const ids = got.map((x) => x.entry.id).sort();
  assert(ids.join() === ["huge", "other", "stale"].sort().join(), "拾う記録: " + ids);
  const reasons = Object.fromEntries(got.map((x) => [x.entry.id, x.reasons.join("/")]));
  assert(reasons.other.includes("その他"), reasons.other);
  assert(reasons.stale.includes("仮のまま"), reasons.stale);
  assert(reasons.huge.includes("倍"), reasons.huge);
  assert(got[got.length - 1].entry.id === "stale", "新しい順");
}

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
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
await new Promise((r) => server.listen(8976, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("dialog", (d) => d.accept());
await page.route("https://www.gstatic.com/firebasejs/**/*.js", async (route) => {
  const url = new URL(route.request().url());
  await route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: fs.readFileSync(path.join(stubRoot, url.pathname.split("/").pop()), "utf-8"),
  });
});
await page.goto("http://localhost:8976/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "review-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

assert(!(await page.isVisible("#review-section")), "何も無いときは出さない");

const today = new Date();
const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
await page.evaluate((date) => {
  const base = "users/uid-review-test@example.com/entries/";
  window.__seedDoc(base + "a", { date, type: "expense", category: "その他支出", amount: 800, memo: "ナゾノミセ", source: "gmail" });
  window.__seedDoc(base + "b", { date, type: "expense", category: "その他支出", amount: 900, memo: "ベツノミセ", source: "gmail" });
}, ymd);
await page.waitForTimeout(400);
assert(await page.isVisible("#review-section"), "要確認が出るはず");
assert((await page.textContent("#review-title")).includes("2件"), await page.textContent("#review-title"));

await page.locator("#review-list .review-row", { hasText: "ナゾノミセ" }).locator("button", { hasText: "このままでOK" }).click();
await page.waitForTimeout(400);
assert((await page.textContent("#review-title")).includes("1件"), "OKにしたら消える");

await page.locator("#review-list .review-row", { hasText: "ベツノミセ" }).locator("button", { hasText: "直す" }).click();
await page.waitForTimeout(400);
assert((await page.textContent("#form-title")) === "記録を編集", "直すで編集が始まる");
await page.selectOption("#entry-category", "食費");
await page.click("#submit-btn");
await page.waitForTimeout(500);
assert(!(await page.isVisible("#review-section")), "カテゴリを直したら要確認から消える");

if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL REVIEW (要確認) CHECKS PASSED");
await browser.close();
server.close();

// 固定費の自動記録 (js/recurring.js とアプリの流れ) を確かめる。
// - 来ていた月の分だけ記録し、次の月へ進める (31日は月末に寄せる・まとめて追いつく)
// - 支出の追加で「毎月この日に記録する」を付けると登録され、来ていれば自動で記録される
// - 自動で入った記録を消しても、もう一度は入らない / やめたら記録されない
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dueRecurring } from "../js/recurring.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------
// 1. 記録する月の判定
// ---------------------------------------------------------------------------
{
  const items = {
    rent: { day: 27, next: "2026-08" },
    gym: { day: 31, next: "2026-02" },
    later: { day: 28, next: "2026-10" },
    broken: { day: 0, next: "2026-01" },
  };
  const { posts, next } = dueRecurring(items, new Date(2026, 9, 27)); // 2026-10-27
  const dates = (id) => posts.filter((p) => p.id === id).map((p) => p.date);
  assert(dates("rent").join() === "2026-08-27,2026-09-27,2026-10-27", "開かなかった月もまとめて: " + dates("rent"));
  assert(next.rent === "2026-11", "次は11月: " + next.rent);
  assert(dates("gym")[0] === "2026-02-28" && dates("gym").includes("2026-04-30"), "31日は月末に寄せる: " + dates("gym"));
  assert(dates("gym").at(-1) === "2026-09-30", "10/31 はまだ来ていない: " + dates("gym"));
  assert(dates("later").length === 0 && !("later" in next), "その日が来るまでは記録しない");
  assert(dates("broken").length === 0, "壊れた登録は無視する");
  const year = dueRecurring({ y: { day: 1, next: "2026-12" } }, new Date(2027, 0, 1));
  assert(year.posts.map((p) => p.date).join() === "2026-12-01,2027-01-01" && year.next.y === "2027-02", "年をまたぐ");
}

// ---------------------------------------------------------------------------
// 2. アプリでの登録・自動記録・やめる
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
await new Promise((r) => server.listen(8978, r));

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

await page.goto("http://localhost:8978/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "recurring-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

// 先月1日の支出を固定費として登録 → 今月1日の分はもう来ているので、すぐ記録される
const now = new Date();
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
await page.fill("#entry-date", `${ym(prev)}-01`);
await page.selectOption("#entry-category", "通信");
await page.fill("#entry-amount", "3300");
await page.fill("#entry-memo", "スマホ代");
assert(await page.isVisible("#entry-recurring"), "追加のときは固定費のチェックが出る");
await page.check("#entry-recurring");
await page.click("#submit-btn");
await page.waitForTimeout(600);
// 追加すると、追加した記録の月 (先月) を表示するので今月へ戻る
await page.click("#today-btn");
await page.waitForTimeout(300);

const thisMonthRow = page.locator("#entry-list tr", { hasText: "スマホ代" });
assert((await thisMonthRow.count()) === 1, "今月の分が自動で入るはず: " + (await thisMonthRow.count()));
assert((await thisMonthRow.textContent()).includes(`${now.getMonth() + 1}/1`), "今月1日の記録のはず: " + (await thisMonthRow.textContent()));
const listText = await page.textContent("#recurring-list");
assert(listText.includes("1日") && listText.includes("スマホ代") && listText.includes("¥3,300"), "固定費の一覧: " + listText);

// 金額を変える (来月から)
page.removeAllListeners("dialog");
page.on("dialog", (d) => (d.type() === "prompt" ? d.accept("3,800") : d.accept()));
await page.locator("#recurring-list button", { hasText: "金額" }).click();
await page.waitForTimeout(400);
assert((await page.textContent("#recurring-list")).includes("¥3,800"), "金額が変わるはず: " + (await page.textContent("#recurring-list")));
assert((await thisMonthRow.textContent()).includes("¥3,300"), "記録済みの分は変わらない: " + (await page.textContent("#entry-list")));

// 編集のときはチェックを出さない
await thisMonthRow.locator("button", { hasText: "編集" }).click();
await page.waitForTimeout(300);
assert(!(await page.isVisible("#entry-recurring")), "編集のときは固定費のチェックを出さない");
await page.click("#cancel-edit-btn");
await page.waitForTimeout(200);

// 自動で入った記録を消しても、もう一度は入らない
await thisMonthRow.locator("button", { hasText: "削除" }).click();
await page.waitForTimeout(400);
// ログインし直して、固定費をもう一度受け取ったときに入れ直さないことを確かめる
// (スタブのデータはページ内にしか無いので、再読み込みはできない)
await page.locator("#logout-btn").dispatchEvent("click");
await page.waitForTimeout(400);
await page.fill("#auth-email", "recurring-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(600);
assert((await page.locator("#entry-list tr", { hasText: "スマホ代" }).count()) === 0, "消した分を入れ直してはいけない");

// やめる
await page.locator("#recurring-list button", { hasText: "やめる" }).click();
await page.waitForTimeout(400);
assert((await page.textContent("#recurring-list")).includes("固定費はありません"), "やめたら一覧から消える");

if (errors.length) throw new Error("JS errors: " + errors.join("; "));
console.log("ALL RECURRING (固定費) CHECKS PASSED");
await browser.close();
server.close();

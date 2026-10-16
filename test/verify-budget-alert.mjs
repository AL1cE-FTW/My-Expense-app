// 予算の使用率通知: 50% / 80% / 100% を超えたときに一度だけ通知が出ることを確認する。
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
await new Promise((r) => server.listen(8998, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

// 本物の通知の代わりに、出した通知を記録するだけの Notification と Service Worker を置く。
// スマホと同じく Service Worker 経由 (showNotification) で出ることを確かめるため、
// new Notification は失敗させる (Android の Chrome と同じ)
await page.addInitScript(() => {
  window.__notes = [];
  window.Notification = class {
    static permission = "default";
    static async requestPermission() { this.permission = "granted"; return "granted"; }
    constructor() { throw new TypeError("Illegal constructor"); }
  };
  const registration = {
    active: {},
    async showNotification(title, opts) { window.__notes.push(title + " | " + opts.body); },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: { register: async () => registration, getRegistration: async () => registration },
  });
});
await page.route("https://www.gstatic.com/firebasejs/**/*.js", async (route) => {
  const url = new URL(route.request().url());
  await route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: fs.readFileSync(path.join(stubRoot, url.pathname.split("/").pop()), "utf-8"),
  });
});

const NOW = new Date();
const today = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-01`;

await page.goto("http://localhost:8998/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "alert-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

await page.click("#edit-budget-btn");
await page.fill("#budget-input-食費", "10000");
await page.locator("#budget-form button[type=submit]").click();
await page.waitForTimeout(300);

async function addExpense(amount) {
  await page.click('.type-option:has(input[value="expense"]) span');
  await page.fill("#entry-date", today);
  await page.selectOption("#entry-category", "食費");
  await page.fill("#entry-amount", String(amount));
  await page.click("#submit-btn");
  await page.waitForTimeout(400);
}
const notes = () => page.evaluate(() => window.__notes);

// 許可前は通知しない
await addExpense(5500);
if ((await notes()).length !== 0) throw new Error("notified before permission");
if (!(await page.locator("#budget-alert-btn").isVisible())) throw new Error("alert button should show");

// 許可すると、すでに超えている 50% をその場で通知する
await page.click("#budget-alert-btn");
await page.waitForTimeout(300);
if (await page.locator("#budget-alert-btn").isVisible()) throw new Error("alert button should hide after grant");
let n = await notes();
if (n.length !== 1 || !n[0].startsWith("食費の予算を55%使いました") || !n[0].includes("残り ¥4,500")) {
  throw new Error("50% alert wrong: " + JSON.stringify(n));
}

// 80% を超えたら通知、同じ段階では再通知しない
await addExpense(3000);
await addExpense(100);
n = await notes();
if (n.length !== 2 || !n[1].startsWith("食費の予算を85%使いました") || !n[1].includes("残り ¥1,500")) {
  throw new Error("80% alert wrong: " + JSON.stringify(n));
}

// 100% を超えたら一度だけ通知
await addExpense(2000);
await addExpense(100);
n = await notes();
if (n.length !== 3 || !n[2].startsWith("食費の予算を106%使いました") || !n[2].includes("¥600 オーバー")) {
  throw new Error("100% alert wrong: " + JSON.stringify(n));
}

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
server.close();
console.log("budget alert OK");

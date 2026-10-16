// 予算の使用率通知 (アプリ側):
// - 通知を許可すると、この端末の宛先 (FCM のトークン) を Firestore に登録すること
// - sw.js が、届いたプッシュから通知を出すこと
// 通知を送るかどうかの判定は Apps Script 側 (test/verify-apps-script.mjs で確かめる)。
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import vm from "vm";
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

// 通知の許可と Service Worker の偽物
await page.addInitScript(() => {
  window.Notification = class {
    static permission = "default";
    static async requestPermission() { this.permission = "granted"; return "granted"; }
  };
  Object.defineProperty(navigator, "serviceWorker", { value: { register: async () => ({ scope: "/" }) } });
});
// 公開鍵を設定した firebase-config.js にする
await page.route("**/js/firebase-config.js", async (route) => {
  const original = fs.readFileSync(path.join(root, "js", "firebase-config.js"), "utf-8");
  await route.fulfill({ status: 200, contentType: "text/javascript", body: original + '\nexport const fcmVapidKey = "test-vapid-key";\n' });
});
await page.route("https://www.gstatic.com/firebasejs/**/*.js", async (route) => {
  const url = new URL(route.request().url());
  await route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: fs.readFileSync(path.join(stubRoot, url.pathname.split("/").pop()), "utf-8"),
  });
});

await page.goto("http://localhost:8998/", { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="signup"]');
await page.fill("#auth-email", "alert-test@example.com");
await page.fill("#auth-password", "password123");
await page.click("#auth-submit-btn");
await page.waitForTimeout(300);

const savedTokens = () =>
  page.evaluate(async () => {
    const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
    // 偽物のログインでは uid が「uid-メールアドレス」になる
    const snap = await fs.getDoc(fs.doc(null, "users/uid-alert-test@example.com/settings/pushTokens"));
    return snap.exists() ? snap.data().tokens : null;
  });

// 許可前は登録しない
if (!(await page.locator("#budget-alert-btn").isVisible())) throw new Error("alert button should show");
if ((await savedTokens()) !== null) throw new Error("token saved before permission");

// 許可すると、この端末の宛先を登録してボタンを隠す
await page.click("#budget-alert-btn");
await page.waitForTimeout(400);
if (await page.locator("#budget-alert-btn").isVisible()) throw new Error("alert button should hide after grant");
const tokens = await savedTokens();
if (JSON.stringify(tokens) !== '["device-token-1"]') throw new Error("token not saved: " + JSON.stringify(tokens));
const opts = await page.evaluate(() => window.__getTokenOptions);
if (opts.vapidKey !== "test-vapid-key" || !opts.hasRegistration) {
  throw new Error("getToken should get the VAPID key and our service worker: " + JSON.stringify(opts));
}

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
server.close();

// --- sw.js: 届いたプッシュから通知を出す -----------------------------------
const listeners = {};
const shown = [];
const self = {
  addEventListener: (type, fn) => (listeners[type] = fn),
  registration: { showNotification: async (title, opts) => shown.push({ title, ...opts }) },
};
vm.runInNewContext(fs.readFileSync(path.join(root, "sw.js"), "utf-8"), { self });
let waited;
listeners.push({
  data: { json: () => ({ data: { title: "食費の予算を85%使いました", body: "残り ¥1,500 です", tag: "budget-食費" } }) },
  waitUntil: (p) => (waited = p),
});
await waited;
if (JSON.stringify(shown) !== JSON.stringify([{ title: "食費の予算を85%使いました", body: "残り ¥1,500 です", tag: "budget-食費" }])) {
  throw new Error("sw.js should show the pushed notification: " + JSON.stringify(shown));
}

console.log("budget alert OK");

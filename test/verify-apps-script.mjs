// apps-script/vpass-import.gs (Google Apps Script のメール自動取り込み) を、
// Gmail・Firebase のログイン・Firestore の REST をまねた偽物の上で動かして確かめる。
// ブラウザは使わない。
//
// - 読み取りとカテゴリ推測が、アプリ (js/vpass-mail.js) と一字一句同じであること
// - 新しいメールだけを「仮」の記録として書き、取り込み済みメールを記録すること
// - 確定済み・登録済みの取引を二重に入れないこと (アプリと同じ判定)
// - 設定漏れ・ログイン失敗・同時実行のときの振る舞い
// - 予算の使用率通知: 集計がアプリ (js/budget-usage.js) と一字一句同じこと、
//   段階ごとに1回だけ送ること、届かなかったら送り直すこと
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const scriptPath = path.join(root, "apps-script", "vpass-import.gs");
const scriptSource = fs.readFileSync(scriptPath, "utf-8");
const appModule = await import(path.join(root, "js", "vpass-mail.js"));

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 1. 読み取りとカテゴリ推測がアプリと同じ
// ---------------------------------------------------------------------------
// 書き写しが一字一句同じこと (片方だけ直すと、ここで落ちる)
const moduleSource = fs.readFileSync(path.join(root, "js", "vpass-mail.js"), "utf-8");
const sharedPart = moduleSource.slice(moduleSource.indexOf("export const GMAIL_QUERY")).replace(/export /g, "");
assert(
  scriptSource.includes(sharedPart.trim()),
  "apps-script/vpass-import.gs の読み取り部分が js/vpass-mail.js と食い違っている。両方を同じに直すこと"
);

// 集計と使用率通知の判定も一字一句同じ
const usageSource = fs.readFileSync(path.join(root, "js", "budget-usage.js"), "utf-8");
const usageShared = usageSource.slice(usageSource.indexOf("export const CARD_REFUND_CATEGORY")).replace(/export /g, "");
assert(
  scriptSource.includes(usageShared.trim()),
  "apps-script/vpass-import.gs の集計部分が js/budget-usage.js と食い違っている。両方を同じに直すこと"
);

// エディタの「実行」で最初に選ばれているのは、ファイルの一番上の関数。
// そこが引数の要る関数だと、そのまま実行してエラーになる (実際に起きた)
const firstFunction = scriptSource.match(/^function (\w+)/m)?.[1];
assert(firstFunction === "setup", "ファイルの一番上の関数は setup のはず: " + firstFunction);

// ---------------------------------------------------------------------------
// 偽物の Google の環境
// ---------------------------------------------------------------------------
const PROJECT = "demo-project";
const UID = "uid-script-user";
const BASE = `projects/${PROJECT}/databases/(default)/documents`;
const USER = `${BASE}/users/${UID}`;
const IMPORT_DOC = `${USER}/settings/gmailImport`;

// 本物の UUID と同じく、実行をまたいでも重ならない
let uuid = 0;

function makeEnv({ props, mails, docs = new Map(), lockBusy = false, signInFails = false, pushStatus = () => 200 }) {
  const fetchLog = [];
  const pushes = [];
  const value = (v) => {
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "number") return { integerValue: String(v) };
    if (typeof v === "boolean") return { booleanValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
    return { nullValue: null };
  };
  const plain = (fields) => {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) {
      if ("stringValue" in v) out[k] = v.stringValue;
      else if ("integerValue" in v) out[k] = Number(v.integerValue);
      else if ("booleanValue" in v) out[k] = v.booleanValue;
      else if ("arrayValue" in v) out[k] = (v.arrayValue.values || []).map((x) => x.stringValue);
      else out[k] = null;
    }
    return out;
  };
  const response = (code, body) => ({
    getResponseCode: () => code,
    getContentText: () => (body === undefined ? "" : JSON.stringify(body)),
  });

  const UrlFetchApp = {
    fetch(url, options = {}) {
      fetchLog.push({ url, options });
      if (url.startsWith("https://identitytoolkit.googleapis.com/")) {
        const body = JSON.parse(options.payload);
        if (signInFails || body.password !== "correct-password") {
          return response(400, { error: { message: "INVALID_LOGIN_CREDENTIALS" } });
        }
        return response(200, { idToken: "id-token", localId: UID });
      }
      if (url === "https://oauth2.googleapis.com/token") {
        assert(options.payload.assertion.split(".").length === 3, "署名付きの JWT で鍵をもらうはず");
        return response(200, { access_token: "fcm-token" });
      }
      if (url.startsWith("https://fcm.googleapis.com/")) {
        assert(url === `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, "送り先: " + url);
        assert(options.headers?.Authorization === "Bearer fcm-token", "FCM にはサービスアカウントの鍵を付けるはず");
        const { message } = JSON.parse(options.payload);
        const code = pushStatus(message.token);
        if (code === 200) pushes.push({ token: message.token, ...message.data });
        return response(code, code === 200 ? { name: "sent" } : { error: { code } });
      }
      assert(options.headers?.Authorization === "Bearer id-token", "Firestore にはログインで得た鍵を付けるはず");
      const p = url.replace("https://firestore.googleapis.com/v1/", "");
      if (options.method === "get") {
        return docs.has(p) ? response(200, { name: p, fields: docs.get(p) }) : response(404, { error: {} });
      }
      const body = JSON.parse(options.payload);
      if (p.endsWith(":runQuery")) {
        const parent = p.replace(/:runQuery$/, "");
        const min = body.structuredQuery.where.fieldFilter.value.stringValue;
        const rows = [...docs.entries()]
          .filter(([name]) => name.startsWith(parent + "/entries/"))
          .filter(([, f]) => (f.date?.stringValue || "") >= min)
          .map(([name, fields]) => ({ document: { name, fields } }));
        return response(200, rows.length ? rows : [{ readTime: "now" }]);
      }
      if (p.endsWith(":commit")) {
        // 全部確かめてから反映する (本物と同じく、1つでもだめなら何も書かない)
        const seen = new Set();
        for (const w of body.writes) {
          if (w.currentDocument?.exists === false && (docs.has(w.update.name) || seen.has(w.update.name))) {
            return response(409, { error: { message: "already exists" } });
          }
          seen.add(w.update.name);
        }
        for (const w of body.writes) {
          const name = w.update.name;
          const current = docs.get(name) || {};
          if (w.updateMask) {
            const next = { ...current };
            for (const f of w.updateMask.fieldPaths) next[f] = w.update.fields[f];
            for (const t of w.updateTransforms || []) {
              const have = (next[t.fieldPath]?.arrayValue?.values || []).map((x) => x.stringValue);
              for (const add of t.appendMissingElements.values) {
                if (!have.includes(add.stringValue)) have.push(add.stringValue);
              }
              next[t.fieldPath] = value(have);
            }
            docs.set(name, next);
          } else {
            docs.set(name, w.update.fields);
          }
        }
        return response(200, { writeResults: [] });
      }
      throw new Error("想定外の呼び出し: " + url);
    },
  };

  const triggers = [];
  const context = {
    console: { log() {} },
    UrlFetchApp,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
    GmailApp: {
      // 本物と同じく、start から max 件ずつ返す (ページ送り)
      search: (query, start = 0, max = 500) => {
        assert(query === appModule.GMAIL_QUERY, "検索条件はアプリと同じはず: " + query);
        return mails.slice(start, start + max).map((thread) => ({
          getMessages: () =>
            thread.map((m) => ({
              getId: () => m.id,
              getFrom: () => m.from ?? "三井住友カード <statement@vpass.ne.jp>",
              getPlainBody: () => m.body,
              // 受信日時。指定が無ければ「さっき届いた」
              getDate: () => new Date(Date.now() - (m.daysAgo ?? 0) * 86400000),
            })),
        }));
      },
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => !lockBusy, releaseLock() {} }),
    },
    Utilities: {
      getUuid: () => `${String(++uuid).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`,
      formatDate: (date, tz, format) => {
        assert(tz === "Asia/Tokyo" && format === "yyyy-MM", "今月はスクリプトのタイムゾーンで決めるはず");
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      },
      base64EncodeWebSafe: (data) => Buffer.from(data).toString("base64url"),
      computeRsaSha256Signature: (input, key) => {
        assert(key === "-----PRIVATE KEY-----", "サービスアカウントの秘密鍵で署名するはず");
        return [1, 2, 3];
      },
    },
    Session: { getScriptTimeZone: () => "Asia/Tokyo" },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({
        timeBased: () => ({
          everyMinutes: (n) => ({
            create: () => triggers.push({ fn, n, getHandlerFunction: () => fn }),
          }),
        }),
      }),
    },
  };
  vm.createContext(context);
  vm.runInContext(scriptSource, context, { filename: "vpass-import.gs" });
  return { context, docs, fetchLog, triggers, plain, pushes };
}

const PROPS = {
  FIREBASE_API_KEY: "test-api-key",
  FIREBASE_PROJECT_ID: PROJECT,
  KAKEIBO_EMAIL: "me@example.com",
  KAKEIBO_PASSWORD: "correct-password",
};

const mail = (lines) => lines.join("\n");
const MAIL_TWO = mail([
  "三井住友カードをご利用いただきありがとうございます。",
  "◇利用日：2026/10/02 08:10",
  "◇利用先：モバイルＳｕｉｃａ",
  "◇利用金額：１，０００ 円",
  "◇利用日：2026/10/02 12:30",
  "◇利用先：ﾌｧﾐﾘｰﾏｰﾄ",
  "◇利用金額：540円",
]);
const MAIL_CONFIRMED = mail(["◇利用日：2026/10/03 19:00", "◇利用先：ユニクロ", "◇利用金額：3,990円"]);
const MAIL_BROKEN = mail(["このメールには明細がありません"]);

// カテゴリ推測・読み取りの結果もアプリと同じ (書き写しの確認に加えて、実際の値でも)
{
  const { context } = makeEnv({ props: PROPS, mails: [] });
  for (const name of ["モバイルＳｕｉｃａ", "ﾌｧﾐﾘｰﾏｰﾄ", "JR東日本 ニューデイズ", "スーパーオートバックス", "ＧＵ", "SKETCH", "知らない店"]) {
    const a = context.guessCategoryFromMerchant(name);
    const b = appModule.guessCategoryFromMerchant(name);
    assert(a === b, `カテゴリ推測がアプリと違う: ${name} → ${a} / ${b}`);
  }
  for (const text of [MAIL_TWO, MAIL_CONFIRMED, MAIL_BROKEN]) {
    const a = JSON.stringify(context.parseVpassEmails(text));
    const b = JSON.stringify(appModule.parseVpassEmails(text));
    assert(a === b, "メールの読み取り結果がアプリと違う:\n" + a + "\n" + b);
  }
}

// ---------------------------------------------------------------------------
// 2. 新しいメールを「仮」で取り込み、取り込み済みとして記録する
// ---------------------------------------------------------------------------
const docs = new Map();
// 既にカード明細 (CSV) で確定しているユニクロ 3,990円 (10/3)
docs.set(`${USER}/entries/confirmed1`, {
  date: { stringValue: "2026-10-03" }, type: { stringValue: "expense" }, category: { stringValue: "衣服・美容" },
  amount: { integerValue: "3990" }, memo: { stringValue: "ユニクロ 新宿店" }, source: { stringValue: "card" },
});
const mails = [
  [{ id: "m1", body: MAIL_TWO }],
  [{ id: "m2", body: MAIL_CONFIRMED }],
  [{ id: "m3", body: MAIL_BROKEN }],
  // 別の差出人のメールは対象外 (同じスレッドに混ざっていても)
  [{ id: "x1", from: "someone@example.com", body: MAIL_TWO }],
];
let env = makeEnv({ props: PROPS, mails, docs });
let result = env.context.importNewCardMails();
assert(result.mails === 3 && result.added === 2 && result.skipped === 1, "取り込み件数: " + JSON.stringify(result));

const added = [...docs.entries()].filter(([n, f]) => n.startsWith(`${USER}/entries/`) && f.source?.stringValue === "gmail");
assert(added.length === 2, "仮の記録が2件できるはず: " + added.length);
const suica = added.map(([, f]) => env.plain(f)).find((e) => e.memo === "モバイルＳｕｉｃａ");
assert(
  suica && suica.date === "2026-10-02" && suica.type === "expense" && suica.category === "交通" &&
    suica.amount === 1000 && /^\d{4}-\d\d-\d\dT/.test(suica.createdAt),
  "記録の中身がアプリの取り込みと同じ形のはず: " + JSON.stringify(suica)
);
const ids = env.plain(docs.get(IMPORT_DOC)).importedIds;
assert(JSON.stringify(ids) === JSON.stringify(["m1", "m2", "m3"]), "読めなかったメールも含めて取り込み済みにするはず: " + JSON.stringify(ids));
// 記録と取り込み済みIDは1回のまとめ書き込み
const commits = env.fetchLog.filter((f) => f.url.endsWith(":commit"));
assert(commits.length === 1, "書き込みは1回にまとめるはず: " + commits.length);

// ---------------------------------------------------------------------------
// 3. 2回目は何もしない / アプリで先に取り込んだものは二重に入れない
// ---------------------------------------------------------------------------
env = makeEnv({ props: PROPS, mails, docs });
result = env.context.importNewCardMails();
assert(result.mails === 0 && result.added === 0, "2回目は新しいメールが無いはず: " + JSON.stringify(result));
assert(!env.fetchLog.some((f) => f.url.endsWith(":commit")), "新しいメールが無ければ書き込まないはず");

// アプリの「メールから読み込み」で取り込み済みIDを残しそこねた同じ取引 (別のメールID)
env = makeEnv({ props: PROPS, mails: [[{ id: "m4", body: MAIL_TWO }]], docs });
result = env.context.importNewCardMails();
assert(result.added === 0 && result.skipped === 2, "同じ内容の記録があれば入れないはず: " + JSON.stringify(result));
assert(env.plain(docs.get(IMPORT_DOC)).importedIds.includes("m4"), "飛ばしたメールも取り込み済みにするはず");

// ---------------------------------------------------------------------------
// 4. 取り込み済みIDは上限 (2000) を超えたら古いものから捨てる
// ---------------------------------------------------------------------------
{
  const many = new Map();
  const old = Array.from({ length: 2000 }, (_, i) => `old${i}`);
  many.set(IMPORT_DOC, { importedIds: { arrayValue: { values: old.map((s) => ({ stringValue: s })) } } });
  const e = makeEnv({ props: PROPS, mails: [[{ id: "new1", body: MAIL_CONFIRMED }]], docs: many });
  e.context.importNewCardMails();
  const kept = e.plain(many.get(IMPORT_DOC)).importedIds;
  assert(kept.length === 2000 && kept[0] === "old1" && kept.at(-1) === "new1", "上限で古いものから捨てるはず");
}

// ---------------------------------------------------------------------------
// 5. 設定漏れ・ログイン失敗・同時実行
// ---------------------------------------------------------------------------
{
  const e = makeEnv({ props: { ...PROPS, KAKEIBO_PASSWORD: "" }, mails });
  let message = "";
  try { e.context.setup(); } catch (err) { message = err.message; }
  assert(message.includes("KAKEIBO_PASSWORD"), "足りない設定の名前を伝えるはず: " + message);
  assert(e.triggers.length === 0, "設定が足りないうちは定期実行を登録しないはず");
}
{
  const e = makeEnv({ props: { ...PROPS, KAKEIBO_PASSWORD: "wrong" }, mails });
  let message = "";
  try { e.context.importNewCardMails(); } catch (err) { message = err.message; }
  assert(message.includes("ログインに失敗"), "ログインの失敗を伝えるはず: " + message);
}
{
  const e = makeEnv({ props: PROPS, mails, lockBusy: true });
  assert(e.context.importNewCardMails() === undefined && e.fetchLog.length === 0, "前回の実行中なら何もしないはず");
}
{
  // setup は15分ごとの実行を1つだけ登録する (2回実行しても増えない)
  const e = makeEnv({ props: PROPS, mails: [] });
  e.context.setup();
  e.context.setup();
  assert(e.triggers.length === 1 && e.triggers[0].n === 15 && e.triggers[0].fn === "importNewCardMails",
    "15分ごとの実行が1つだけ登録されるはず: " + JSON.stringify(e.triggers));
}

// ---------------------------------------------------------------------------
// 6. 同じ件名のメールが1つの会話 (スレッド) にまとまっていても、
//    検索の範囲 (直近60日) より古いメールは取り込まない
// ---------------------------------------------------------------------------
{
  const d = new Map();
  const oldMail = mail(["◇利用日：2025/12/01 10:00", "◇利用先：去年の店", "◇利用金額：700円"]);
  const e = makeEnv({
    props: PROPS,
    docs: d,
    mails: [[{ id: "old-in-thread", daysAgo: 300, body: oldMail }, { id: "new-in-thread", daysAgo: 1, body: MAIL_CONFIRMED }]],
  });
  const r = e.context.importNewCardMails();
  const memos = [...d.entries()].filter(([n]) => n.includes("/entries/")).map(([, f]) => e.plain(f).memo);
  if (r.mails !== 1 || memos.includes("去年の店") || !memos.includes("ユニクロ")) {
    throw new Error("会話の中の古いメールまで取り込んではいけない: " + JSON.stringify({ r, memos }));
  }
}

// ---------------------------------------------------------------------------
// 7. 検索で100件より多く見つかっても、取りこぼさない (アプリと同じく最大300件)
// ---------------------------------------------------------------------------
{
  const d = new Map();
  const lots = Array.from({ length: 150 }, (_, i) => [{
    id: `bulk${i}`,
    body: mail([`◇利用日：2026/09/${String((i % 28) + 1).padStart(2, "0")} 10:00`, `◇利用先：店${i}`, `◇利用金額：${100 + i}円`]),
  }]);
  const e = makeEnv({ props: PROPS, docs: d, mails: lots });
  const r = e.context.importNewCardMails();
  if (r.mails !== 150 || r.added !== 150) {
    throw new Error("100件を超えても全部読むはず: " + JSON.stringify(r));
  }
}

// ---------------------------------------------------------------------------
// 8. 予算の使用率通知
// ---------------------------------------------------------------------------
{
  const NOW = new Date();
  const MONTH = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}`;
  const ALERT_PROPS = {
    ...PROPS,
    FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: "fcm@example.iam.gserviceaccount.com", private_key: "-----PRIVATE KEY-----" }),
  };
  const ALERTS_DOC = `${USER}/settings/budgetAlerts`;
  const TOKENS_DOC = `${USER}/settings/pushTokens`;
  const fields = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map((x) => ({ stringValue: x })) } } : { integerValue: String(v) }]));
  let n = 0;
  const addEntry = (d, e) => d.set(`${USER}/entries/e${++n}`, fields({ date: `${MONTH}-01`, type: "expense", ...e }));
  const run = (d, opts = {}) => {
    const e = makeEnv({ props: ALERT_PROPS, mails: [], docs: d, ...opts });
    return { r: e.context.importNewCardMails(), e };
  };

  const d = new Map();
  d.set(`${USER}/settings/budget`, fields({ 食費: 10000, 交通: 10000 }));
  d.set(TOKENS_DOC, fields({ tokens: ["phone", "old-phone"] }));
  addEntry(d, { category: "食費", amount: 8500 });
  addEntry(d, { category: "交通", amount: 1000 });
  // まだ返ってきていない立替は数えない (アプリと同じ)
  addEntry(d, { category: "交通", amount: 50000, advance: true });

  // FCM の鍵が無ければ何もしない
  {
    const e = makeEnv({ props: PROPS, mails: [], docs: d });
    assert(e.context.importNewCardMails().alerts === "off" && e.pushes.length === 0, "鍵が無ければ通知しないはず");
  }

  // 食費 85% → 1回送る。もう届かない宛先 (404) は消す
  let { r, e } = run(d, { pushStatus: (t) => (t === "old-phone" ? 404 : 200) });
  assert(e.pushes.length === 1 && e.pushes[0].token === "phone" && e.pushes[0].title === "食費の予算を85%使いました" &&
    e.pushes[0].body.includes("残り ¥1,500") && e.pushes[0].tag === "budget-食費", "85% の通知: " + JSON.stringify(e.pushes));
  assert(JSON.stringify(e.plain(d.get(TOKENS_DOC)).tokens) === '["phone"]', "届かない宛先は消すはず");
  let sent = e.plain(d.get(ALERTS_DOC));
  assert(sent.month === MONTH && sent.keys.includes("食費:0.8") && sent.keys.includes("食費:0.5"), "通知済みを残すはず: " + JSON.stringify(sent));

  // 同じ段階は2回送らない
  ({ e } = run(d));
  assert(e.pushes.length === 0, "同じ段階は1回だけのはず: " + JSON.stringify(e.pushes));

  // 交通が 100%、予算全体 (18,500 / 20,000) が 80% を超える
  addEntry(d, { category: "交通", amount: 9000 });
  ({ e } = run(d));
  const titles = e.pushes.map((p) => p.title).sort();
  assert(JSON.stringify(titles) === JSON.stringify(["予算全体の予算を93%使いました", "交通の予算を100%使いました"]),
    "交通と予算全体の通知: " + JSON.stringify(titles));
  assert(e.pushes.find((p) => p.tag === "budget-交通").body.startsWith("¥0 オーバー"), "100% の本文");

  // 1台にも届かなかったら通知済みにしない (次の実行で送り直す)
  addEntry(d, { category: "食費", amount: 2000 });
  ({ r, e } = run(d, { pushStatus: () => 500 }));
  assert(r.alerts.delivered === 0 && !e.plain(d.get(ALERTS_DOC)).keys.includes("食費:1"), "失敗したら通知済みにしないはず");
  ({ e } = run(d));
  // 食費 10,500 で予算全体 (20,500 / 20,000) も 100% を超える
  assert(JSON.stringify(e.pushes.map((p) => p.title).sort()) === JSON.stringify(["予算全体の予算を102%使いました", "食費の予算を105%使いました"]),
    "次の実行で送り直すはず: " + JSON.stringify(e.pushes));

  // 月が変わったら (先月の印しか無ければ) 送り直す
  d.set(ALERTS_DOC, fields({ month: "2000-01", keys: ["食費:1", "食費:0.8", "食費:0.5"] }));
  ({ e } = run(d));
  assert(e.pushes.some((p) => p.tag === "budget-食費"), "月が変わったら送り直すはず");

  // 通知を許可した端末が無ければ、記録を読まない
  const empty = new Map([[`${USER}/settings/budget`, fields({ 食費: 1 })]]);
  ({ r, e } = run(empty));
  assert(r.alerts === "no devices" && !e.fetchLog.some((f) => f.url.endsWith(":runQuery")), "端末が無ければ何もしないはず");
}

console.log("ALL APPS SCRIPT CHECKS PASSED");

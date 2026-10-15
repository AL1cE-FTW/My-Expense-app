// apps-script/vpass-import.gs (Google Apps Script のメール自動取り込み) を、
// Gmail・Firebase のログイン・Firestore の REST をまねた偽物の上で動かして確かめる。
// ブラウザは使わない。
//
// - 読み取りとカテゴリ推測が、アプリ (js/vpass-mail.js) と一字一句同じであること
// - 新しいメールだけを「仮」の記録として書き、取り込み済みメールを記録すること
// - 確定済み・登録済みの取引を二重に入れないこと (アプリと同じ判定)
// - 設定漏れ・ログイン失敗・同時実行のときの振る舞い
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

function makeEnv({ props, mails, docs = new Map(), lockBusy = false, signInFails = false }) {
  const fetchLog = [];
  const value = (v) => {
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "number") return { integerValue: String(v) };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
    return { nullValue: null };
  };
  const plain = (fields) => {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) {
      if ("stringValue" in v) out[k] = v.stringValue;
      else if ("integerValue" in v) out[k] = Number(v.integerValue);
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
      search: (query) => {
        assert(query === appModule.GMAIL_QUERY, "検索条件はアプリと同じはず: " + query);
        return mails.map((thread) => ({
          getMessages: () =>
            thread.map((m) => ({
              getId: () => m.id,
              getFrom: () => m.from ?? "三井住友カード <statement@vpass.ne.jp>",
              getPlainBody: () => m.body,
            })),
        }));
      },
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => !lockBusy, releaseLock() {} }),
    },
    Utilities: { getUuid: () => `${String(++uuid).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd` },
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
  return { context, docs, fetchLog, triggers, plain };
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

console.log("ALL APPS SCRIPT CHECKS PASSED");

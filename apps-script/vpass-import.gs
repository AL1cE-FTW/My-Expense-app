/**
 * 家計簿: 三井住友カード (Vpass) の利用通知メールを自動で取り込む Google Apps Script
 *
 * アプリを開いていなくても、15分ごとに Gmail の利用通知メールを読み取り、
 * 家計簿 (Firebase Firestore) に「仮」の記録として書き込む。
 * アプリの「メールから読み込み」と同じ「取り込み済みメール」の記録を使うので、
 * どちらで読んでも二重には入らない。
 *
 * 設定 (Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」):
 *   FIREBASE_API_KEY     js/firebase-config.js の apiKey
 *   FIREBASE_PROJECT_ID  js/firebase-config.js の projectId
 *   KAKEIBO_EMAIL        家計簿にログインするメールアドレス
 *   KAKEIBO_PASSWORD     家計簿にログインするパスワード
 *
 * 使い方: 上の4つを入れたら、関数 setup を1回実行する (15分ごとの実行が登録される)。
 * 手順の詳細は README.md の「メールの自動取り込み (Google Apps Script)」を参照。
 *
 * ※ 下の「読み取りとカテゴリ推測」は js/vpass-mail.js の書き写し。
 *    片方だけ直すと食い違うので、直すときは両方を直す
 *    (食い違いは test/verify-apps-script.mjs が見つける)。
 */

// ===========================================================================
// 読み取りとカテゴリ推測 (js/vpass-mail.js と同じ内容)
// ===========================================================================

const GMAIL_QUERY = 'from:statement@vpass.ne.jp subject:"ご利用のお知らせ" newer_than:60d';

// お店の名前からカテゴリを推測する。Suica/PASMO等の交通系は確実、それ以外は
// よくある業態のキーワードで大まかに振り分け、当てはまらなければ「その他支出」。
// 店名のルールは toHalfWidthAscii で半角化したあとの文字列に対して判定するため、
// 英数字は半角で書く (全角のまま書くと絶対に一致しない)。
// 「GU」「ETC」のような短い英字は他の語の一部に紛れ込みやすいので、前後が
// 英字でないことを条件にする (SKETCH の ETC、GUCCI の GU などを避ける)。
// exclude は「パターンには一致するが、このカテゴリではないもの」の除外指定。
const MERCHANT_CATEGORY_RULES = [
  {
    category: "交通",
    pattern:
      /Suica|スイカ|PASMO|パスモ|(?:^|[^A-Za-z])JR(?:[^A-Za-z]|$)|地下鉄|バス|タクシー|(?:^|[^A-Za-z])ETC(?:[^A-Za-z]|$)|ICOCA|イコカ|みどりの窓口|東京メトロ|モノレール|鉄道|交通局/i,
    // 駅ナカの売店は交通費ではなく食費 (「JR東日本 ニューデイズ」など)
    exclude: /ニューデイズ|NEWDAYS|キオスク|KIOSK/i,
  },
  {
    category: "食費",
    // 「フアミリ―マ―ト」のようにカード会社のCSVでは小さい「ァ」や長音記号「ー」が
    // 通常サイズの文字やダッシュに置き換わっていることがあるため、それも拾えるように
    // 「フアミリ」で判定する
    pattern:
      /ファミリーマート|フアミリ|セブン|ローソン|ミニストップ|デイリーヤマザキ|ニューデイズ|キオスク|コンビニ|スーパー|イオン|やまか|西友|マルエツ|東急ストア|ライフ|カフェ|スターバックス|ドトール|ベックス|コージーコーナー|カルディ|珈琲|マクドナルド|吉野家|すき家|松屋|ラーメン|餃子|食堂|レストラン|居酒屋|もんじゃ|大戸屋|ピザ|寿司/i,
    // 「スーパーオートバックス」(カー用品)「ライフカード」(カード会社) のように、
    // 食べ物と無関係なのに部分一致してしまうもの
    exclude: /オートバックス|ライフカード|スーパーホテル|イオンカード|イオン銀行/i,
  },
  {
    category: "日用品",
    pattern: /マツモトキヨシ|ドラッグ|ダイソー|セリア|無印良品|ニトリ|ホームセンター|ロフト|東急ハンズ/i,
  },
  {
    category: "趣味・娯楽",
    pattern: /KODANSHA|SHUEISHA|集英社|講談社|GOOGLE|AMAZON|APPLE|Steam|Netflix|Spotify|BOOTH|PICCOMA|ピッコマ|映画|カラオケ/i,
  },
  {
    category: "衣服・美容",
    pattern: /ユニクロ|UNIQLO|(?:^|[^A-Za-z])GU(?:[^A-Za-z]|$)|美容室|ヘアサロン|理容/i,
  },
];

// 全角英数字・全角スペースを半角に変換する。カード利用履歴CSVでは
// 「ＢＯＯＴＨ」「ＧＯＯＧＬＥ　ＰＬＡＹ　ＪＡＰＡＮ」のように国内加盟店名が
// 全角化されていることが多く、半角前提のカテゴリ判定パターンに掛からないため。
// 半角カナ -> 全角カナ。カード会社のCSVでは「ﾌｧﾐﾘｰﾏｰﾄ」のように半角カナで
// 出ることがあり、そのままだと全角カナ前提のルールを全て素通りしてしまう。
// 濁点・半濁点は独立した文字として続くため、先に合成する。
const HALFWIDTH_KANA = "｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ";
const FULLWIDTH_KANA =
  "。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜";
const VOICED_KANA = "ガギグゲゴザジズゼゾダヂヅデドバビブベボヴ";
const VOICED_BASE = "カキクケコサシスセソタチツテトハヒフヘホウ";

function toFullWidthKana(text) {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const index = HALFWIDTH_KANA.indexOf(text[i]);
    if (index === -1) {
      result += text[i];
      continue;
    }
    const ch = FULLWIDTH_KANA[index];
    const next = text[i + 1];
    if (next === "ﾞ" && VOICED_BASE.includes(ch)) {
      result += VOICED_KANA[VOICED_BASE.indexOf(ch)];
      i++;
    } else if (next === "ﾟ" && "ハヒフヘホ".includes(ch)) {
      result += "パピプペポ"["ハヒフヘホ".indexOf(ch)];
      i++;
    } else {
      result += ch;
    }
  }
  return result;
}

function toHalfWidthAscii(text) {
  return toFullWidthKana(text)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

function guessCategoryFromMerchant(merchant) {
  const normalized = toHalfWidthAscii(merchant);
  for (const rule of MERCHANT_CATEGORY_RULES) {
    if (rule.exclude && rule.exclude.test(normalized)) continue;
    if (rule.pattern.test(normalized)) return rule.category;
  }
  return "その他支出";
}

/**
 * Vpass「ご利用のお知らせ」メールの本文から利用明細を1件抽出する。
 * 解析できなければ null を返す。
 */
/**
 * Vpassの利用通知メールから明細を取り出す。1通に複数件が並ぶことがあるため、
 * 「◇利用日」ごとに区切って全件を返す。
 * (以前は最初の1件しか読まず、残りはメールが「取り込み済み」になることで
 *  二度と取り込まれず永久に失われていた)
 */
function parseVpassEmails(text) {
  const results = [];
  // 「◇利用日」の位置で区切り、各ブロックの中で利用先・利用金額を探す
  const blocks = text.split(/(?=◇利用日[:：])/);
  for (const block of blocks) {
    const dateMatch = block.match(/◇利用日[:：]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    // \s* だと改行にマッチし、利用先が空のとき次の行(◇利用金額…)を
    // 店名として取り込んでしまうため、行内の空白だけに限定する
    const merchantMatch = block.match(/◇利用先[:：][^\S\r\n]*(.+)/);
    // 全角の数字・カンマ、「円」の前の空白も許す(解析できないメールは取り込み済みになり二度と読まれない)
    const amountMatch = block.match(/◇利用金額[:：]\s*([\d０-９,，]+)\s*円/);
    if (!dateMatch || !merchantMatch || !amountMatch) continue;

    const [, y, mo, d] = dateMatch;
    const amount = Number(toHalfWidthAscii(amountMatch[1]).replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const merchant = merchantMatch[1].trim();
    if (!merchant) continue;

    results.push({
      date: `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`,
      type: "expense",
      category: guessCategoryFromMerchant(merchant),
      amount,
      memo: merchant,
      // 利用通知メールは速報。確定明細(カード利用履歴CSV)を取り込むまでは仮
      source: "gmail",
    });
  }
  return results;
}


// ===========================================================================
// 取り込み
// ===========================================================================

// 取り込み済みメールIDの上限 (アプリの IMPORTED_GMAIL_ID_LIMIT と同じ)
const IMPORTED_GMAIL_ID_LIMIT = 2000;
const VPASS_SENDER = "statement@vpass.ne.jp";

/** 最初に1回だけ実行する: 15分ごとに importNewCardMails を動かす */
function setup() {
  config_(); // 設定漏れがあればここで知らせる
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "importNewCardMails") ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger("importNewCardMails").timeBased().everyMinutes(15).create();
  importNewCardMails();
}

/** 15分ごとに呼ばれる本体。手動で実行しても良い */
function importNewCardMails() {
  // 前回の実行が長引いているあいだに次が始まると、同じメールを二重に取り込む
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const result = runImport_();
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function runImport_() {
  const cfg = config_();
  const auth = signIn_(cfg);
  const base = `projects/${cfg.projectId}/databases/(default)/documents`;
  const userPath = `${base}/users/${auth.uid}`;
  const importDocName = `${userPath}/settings/gmailImport`;

  const importedIds = getImportedIds_(cfg, auth, importDocName);
  const imported = new Set(importedIds || []);

  // 新しいメールを集める (検索条件はアプリと同じ: 直近60日)
  const newMessages = [];
  for (const thread of GmailApp.search(GMAIL_QUERY, 0, 100)) {
    for (const message of thread.getMessages()) {
      if (!String(message.getFrom()).includes(VPASS_SENDER)) continue;
      if (imported.has(message.getId())) continue;
      newMessages.push(message);
    }
  }
  if (newMessages.length === 0) return { mails: 0, added: 0 };

  const parsed = [];
  for (const message of newMessages) parsed.push(...parseVpassEmails(message.getPlainBody() || ""));
  const newIds = newMessages.map((m) => m.getId());

  let toAdd = [];
  let skipped = 0;
  if (parsed.length > 0) {
    // アプリと同じ重複チェック: 確定済み (カード明細CSV) の記録と同じ日・同じ金額なら
    // 取り込まない。そのうえで、同じ内容の記録が既にあれば件数ぶん飛ばす
    const minDate = parsed.map((e) => e.date).sort()[0];
    const existing = queryEntriesSince_(cfg, auth, userPath, minDate);
    const { kept, confirmedCount } = dropAlreadyConfirmed_(parsed, existing);
    const deduped = dedupeAgainst_(kept, existing);
    toAdd = deduped.kept;
    skipped = confirmedCount + deduped.skipped;
  }

  // 記録の追加と「取り込み済みメール」の記録を、1回のまとめ書き込みで行う
  // (片方だけ反映されて、二重取り込みや取りこぼしが起きないように)
  const now = new Date().toISOString();
  const writes = toAdd.map((entry) => ({
    update: {
      name: `${userPath}/entries/${newDocId_()}`,
      fields: toFields_({ createdAt: now, ...entry }),
    },
    currentDocument: { exists: false },
  }));
  writes.push(importedIdsWrite_(importDocName, importedIds, newIds));
  firestore_(cfg, auth, "post", `${base}:commit`, { writes });

  return { mails: newMessages.length, added: toAdd.length, skipped };
}

// --- 設定とログイン ---------------------------------------------------------

function config_() {
  const props = PropertiesService.getScriptProperties();
  const cfg = {
    apiKey: props.getProperty("FIREBASE_API_KEY"),
    projectId: props.getProperty("FIREBASE_PROJECT_ID"),
    email: props.getProperty("KAKEIBO_EMAIL"),
    password: props.getProperty("KAKEIBO_PASSWORD"),
  };
  const missing = Object.entries({
    FIREBASE_API_KEY: cfg.apiKey,
    FIREBASE_PROJECT_ID: cfg.projectId,
    KAKEIBO_EMAIL: cfg.email,
    KAKEIBO_PASSWORD: cfg.password,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error("スクリプト プロパティが足りません: " + missing.join(", "));
  }
  return cfg;
}

// 家計簿と同じアカウントでログインして、Firestore に書き込むための鍵 (IDトークン) を得る。
// 書き込みはアプリと同じセキュリティルールで守られる (自分のデータにしか書けない)
function signIn_(cfg) {
  const res = UrlFetchApp.fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(cfg.apiKey)}`,
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ email: cfg.email, password: cfg.password, returnSecureToken: true }),
      muteHttpExceptions: true,
    }
  );
  const body = JSON.parse(res.getContentText() || "{}");
  if (res.getResponseCode() !== 200) {
    const reason = body.error && body.error.message ? body.error.message : res.getResponseCode();
    throw new Error("家計簿へのログインに失敗しました: " + reason);
  }
  return { idToken: body.idToken, uid: body.localId };
}

// --- Firestore (REST) -------------------------------------------------------

function firestore_(cfg, auth, method, path, payload) {
  const options = {
    method,
    headers: { Authorization: `Bearer ${auth.idToken}` },
    muteHttpExceptions: true,
  };
  if (payload !== undefined) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch(`https://firestore.googleapis.com/v1/${path}`, options);
  const code = res.getResponseCode();
  if (code === 404 && method === "get") return null;
  if (code < 200 || code >= 300) {
    throw new Error(`Firestore への${method === "get" ? "読み込み" : "書き込み"}に失敗しました (${code}): ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText() || "{}");
}

// 取り込み済みメールID。文書がまだ無ければ空、読めなければ例外 (読めないまま
// 書くと、上限の切り詰めで履歴を失うおそれがあるため)
function getImportedIds_(cfg, auth, importDocName) {
  const doc = firestore_(cfg, auth, "get", importDocName);
  if (!doc) return [];
  const value = doc.fields && doc.fields.importedIds;
  return value ? fromValue_(value) || [] : [];
}

function queryEntriesSince_(cfg, auth, userPath, minDate) {
  const rows = firestore_(cfg, auth, "post", `${userPath}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId: "entries" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "date" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { stringValue: minDate },
        },
      },
    },
  });
  return (rows || [])
    .filter((row) => row.document)
    .map((row) => ({ id: row.document.name.split("/").pop(), ...fromFields_(row.document.fields || {}) }));
}

// 取り込み済みIDの追記。アプリと同じく上限を超えたら古いものから捨てる
function importedIdsWrite_(importDocName, existingIds, newIds) {
  const existing = existingIds || [];
  if (existing.length + newIds.length > IMPORTED_GMAIL_ID_LIMIT) {
    const trimmed = [...new Set([...existing, ...newIds])].slice(-IMPORTED_GMAIL_ID_LIMIT);
    return {
      update: { name: importDocName, fields: toFields_({ importedIds: trimmed }) },
      updateMask: { fieldPaths: ["importedIds"] },
    };
  }
  // 文書が無ければ作り、あれば importedIds に足す (アプリの arrayUnion と同じ)
  return {
    update: { name: importDocName, fields: {} },
    updateMask: { fieldPaths: [] },
    updateTransforms: [
      {
        fieldPath: "importedIds",
        appendMissingElements: { values: newIds.map((id) => ({ stringValue: id })) },
      },
    ],
  };
}

function newDocId_() {
  return Utilities.getUuid().replace(/-/g, "").slice(0, 20);
}

function toValue_(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue_) } };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "object") return { mapValue: { fields: toFields_(value) } };
  return { stringValue: String(value) };
}

function toFields_(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) fields[key] = toValue_(value);
  return fields;
}

function fromValue_(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue_);
  if ("mapValue" in v) return fromFields_(v.mapValue.fields || {});
  return null;
}

function fromFields_(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields)) obj[key] = fromValue_(value);
  return obj;
}

// --- 重複チェック (アプリの dropAlreadyConfirmed・dedupeAgainstExisting と同じ判定) ---

function dropAlreadyConfirmed_(imported, existing) {
  const confirmed = existing.filter((e) => e.source === "card");
  const used = new Set();
  const kept = [];
  let confirmedCount = 0;
  for (const row of imported) {
    const found = confirmed.find(
      (e) => !used.has(e.id) && e.type === row.type && e.date === row.date && e.amount === row.amount
    );
    if (found) {
      used.add(found.id);
      confirmedCount++;
    } else {
      kept.push(row);
    }
  }
  return { kept, confirmedCount };
}

function normalizeMemo_(memo) {
  return toHalfWidthAscii(String(memo || "")).replace(/\s+/g, "").toUpperCase();
}

function dedupeKey_(e) {
  return JSON.stringify([e.date, e.type, e.category, e.amount, normalizeMemo_(e.memo)]);
}

function dedupeAgainst_(imported, existing) {
  const counts = new Map();
  for (const e of existing) counts.set(dedupeKey_(e), (counts.get(dedupeKey_(e)) || 0) + 1);
  const kept = [];
  let skipped = 0;
  for (const item of imported) {
    const key = dedupeKey_(item);
    const remaining = counts.get(key) || 0;
    if (remaining > 0) {
      counts.set(key, remaining - 1);
      skipped++;
    } else {
      kept.push(item);
    }
  }
  return { kept, skipped };
}

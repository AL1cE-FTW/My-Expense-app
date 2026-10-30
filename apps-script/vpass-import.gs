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
 * 予算の使用率通知: スクリプト プロパティに FCM_SERVICE_ACCOUNT (Firebase の
 * サービスアカウントの鍵の JSON) を入れると、取り込みのたびに今月の予算の使用率を
 * 調べ、50%・80%・100% を超えたらアプリで通知を許可した端末にプッシュ通知を送る。
 * 手順は README.md の「予算の使用率通知」を参照。
 *
 * ※ 下の「読み取りとカテゴリ推測」は js/vpass-mail.js、「集計と使用率通知の判定」は
 *    js/budget-usage.js の書き写し。片方だけ直すと食い違うので、直すときは両方を直す
 *    (食い違いは test/verify-apps-script.mjs が見つける)。
 */

// ===========================================================================
// 実行する関数 (エディタの「実行」の横で選ぶ。最初に1回 setup を実行する)
//
// エディタの関数の選択は、ファイルの一番上の関数が最初に選ばれている。
// 引数が要る関数 (下の toFullWidthKana など) を誤って実行するとエラーになるので、
// 実行してよい関数をいちばん上に置く
// ===========================================================================

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
    const cfg = config_();
    const auth = signIn_(cfg);
    const result = runImport_(cfg, auth);
    // 取り込みが無くても調べる (アプリで手入力した支出も通知の対象にする)
    result.alerts = runBudgetAlerts_(cfg, auth);
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

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

function runImport_(cfg, auth) {
  const base = `projects/${cfg.projectId}/databases/(default)/documents`;
  const userPath = `${base}/users/${auth.uid}`;
  const importDocName = `${userPath}/settings/gmailImport`;

  const importedIds = getImportedIds_(cfg, auth, importDocName);
  const imported = new Set(importedIds || []);

  // 新しいメールを集める (検索条件はアプリと同じ: 直近60日)
  const newMessages = [];
  for (const message of searchVpassMessages_()) {
    if (imported.has(message.getId())) continue;
    newMessages.push(message);
  }
  if (newMessages.length === 0) return { mails: 0, added: 0 };

  const parsed = [];
  for (const message of newMessages) parsed.push(...parseVpassEmails(message.getPlainBody() || ""));
  applyLearnedCategories_(parsed, getMerchantCategories_(cfg, auth, `${userPath}/settings/merchantCategories`));
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

// 検索に当たったメールを集める。
// - Gmail は同じ件名のメールを1つの会話 (スレッド) にまとめる。検索は「直近60日に
//   当たるメールを含む会話」を返すので、会話の中の古いメールまで読むと、何か月も
//   前の利用まで取り込んでしまう。アプリ (Gmail API の検索) はメール単位なので、
//   それに合わせて受信日で絞る
// - 100件ずつページを送り、アプリと同じく最大300件まで読む
const SEARCH_DAYS = 60;
const SEARCH_PAGE = 100;
const SEARCH_LIMIT = 300;

function searchVpassMessages_() {
  const since = Date.now() - SEARCH_DAYS * 86400000;
  const messages = [];
  for (let start = 0; messages.length < SEARCH_LIMIT; start += SEARCH_PAGE) {
    const threads = GmailApp.search(GMAIL_QUERY, start, SEARCH_PAGE);
    for (const thread of threads) {
      for (const message of thread.getMessages()) {
        if (!String(message.getFrom()).includes(VPASS_SENDER)) continue;
        if (message.getDate().getTime() < since) continue;
        messages.push(message);
      }
    }
    if (threads.length < SEARCH_PAGE) break;
  }
  return messages.slice(0, SEARCH_LIMIT);
}

// ===========================================================================
// 予算の使用率通知
// ===========================================================================

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/**
 * 今月の予算の使用率を調べ、まだ通知していない段階を、アプリで通知を許可した
 * 端末 (settings/pushTokens) に送る。通知済みの段階は settings/budgetAlerts に残す
 * (端末をまたいで1回ずつ)。FCM_SERVICE_ACCOUNT が無ければ何もしない。
 */
function runBudgetAlerts_(cfg, auth) {
  const serviceAccountJson = PropertiesService.getScriptProperties().getProperty("FCM_SERVICE_ACCOUNT");
  if (!serviceAccountJson) return "off";

  const base = `projects/${cfg.projectId}/databases/(default)/documents`;
  const userPath = `${base}/users/${auth.uid}`;
  const tokensDocName = `${userPath}/settings/pushTokens`;
  const alertsDocName = `${userPath}/settings/budgetAlerts`;

  const tokens = docFields_(firestore_(cfg, auth, "get", tokensDocName)).tokens || [];
  if (tokens.length === 0) return "no devices";

  const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
  const sentDoc = docFields_(firestore_(cfg, auth, "get", alertsDocName));
  const sentKeys = sentDoc.month === month ? sentDoc.keys || [] : [];
  const budgets = docFields_(firestore_(cfg, auth, "get", `${userPath}/settings/budget`));
  // shortcut: 返金がどの支出を取り消すかを探す範囲を先月の初めからに絞る (毎回全件を読むと
  // Firestore の無料枠を使い切るため)。先々月より前の支出の返金は、アプリと違って
  // 収入のまま数える。ずれが問題になったら範囲を広げる
  const entries = queryEntriesSince_(cfg, auth, userPath, `${previousMonth_(month)}-01`);
  const alerts = budgetAlertsToSend(entries, budgets, month, sentKeys);
  if (alerts.length === 0) return { alerts: 0 };

  const accessToken = fcmAccessToken_(serviceAccountJson);
  const goneTokens = new Set();
  const delivered = [];
  for (const alert of alerts) {
    let ok = false;
    for (const token of tokens) {
      if (goneTokens.has(token)) continue;
      const status = sendPush_(cfg, accessToken, token, alert);
      if (status === "ok") ok = true;
      if (status === "gone") goneTokens.add(token);
    }
    // 1台にも届かなかった段階は通知済みにしない (次の実行で送り直す)
    if (ok) delivered.push(...alert.keys);
  }

  const writes = [];
  if (delivered.length > 0) {
    writes.push({
      update: { name: alertsDocName, fields: toFields_({ month, keys: [...sentKeys, ...delivered] }) },
    });
  }
  if (goneTokens.size > 0) {
    writes.push({
      update: { name: tokensDocName, fields: toFields_({ tokens: tokens.filter((t) => !goneTokens.has(t)) }) },
      updateMask: { fieldPaths: ["tokens"] },
    });
  }
  if (writes.length > 0) firestore_(cfg, auth, "post", `${base}:commit`, { writes });
  return { alerts: alerts.length, delivered: delivered.length, removedDevices: goneTokens.size };
}

function docFields_(doc) {
  return doc && doc.fields ? fromFields_(doc.fields) : {};
}

function previousMonth_(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// サービスアカウントの鍵で署名して、FCM に送るための鍵 (アクセストークン) を得る
function fcmAccessToken_(serviceAccountJson) {
  let account;
  try {
    account = JSON.parse(serviceAccountJson);
  } catch (err) {
    throw new Error("FCM_SERVICE_ACCOUNT が JSON として読めません。鍵のファイルの中身をそのまま貼ってください");
  }
  const encode = (text) => Utilities.base64EncodeWebSafe(text).replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    encode(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    encode(
      JSON.stringify({
        iss: account.client_email,
        scope: FCM_SCOPE,
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      })
    );
  const signature = encode(Utilities.computeRsaSha256Signature(unsigned, account.private_key));
  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("FCM_SERVICE_ACCOUNT の鍵でのログインに失敗しました: " + res.getContentText());
  }
  return JSON.parse(res.getContentText()).access_token;
}

// 1台に送る。"ok" / "gone" (アプリを消した等で、もう届かない宛先) / "error" (次の実行で送り直す)
function sendPush_(cfg, accessToken, token, alert) {
  const res = UrlFetchApp.fetch(`https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${accessToken}` },
    payload: JSON.stringify({
      message: {
        token,
        data: { title: alert.title, body: alert.body, tag: alert.tag },
        webpush: { headers: { Urgency: "high" } },
      },
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 200) return "ok";
  if (code === 404) return "gone";
  console.log(`通知の送信に失敗しました (${code}): ${res.getContentText()}`);
  return "error";
}

// ===========================================================================
// 集計と使用率通知の判定 (js/budget-usage.js と同じ内容)
// ===========================================================================

const CARD_REFUND_CATEGORY = "カード返金";

function normalizeMemo(memo) {
  return toHalfWidthAscii(String(memo || ""))
    .replace(/\s+/g, "")
    .toUpperCase();
}

// --- 立替を自分のお金の出入りに数えない -------------------------------------
//
// 立て替えたお金は「あとで返ってくる権利」(簿記でいう立替金＝資産) で、
// 使ったお金ではない。返金も稼いだお金ではなく、その権利が現金に戻っただけ。
// 両方を支出・収入に数えると、立て替えた月は赤字、返ってきた月は黒字に見える
// (2か月通せば相殺されるが、月ごとの数字が歪む)。
//
// そこで次の記録は、収入・支出・収支・予算・Need/Want/Save・累計貯金額の
// どれにも数えない:
//   - まだ返ってきていない立替 (返ってくる前提で、資産として持っている)
//   - 立替と、それを同じ金額で精算した返金の組
// 精算額が立替額と違う組 (一部しか返ってこなかった等) は、差額が自分の負担・
// 得になるので、両方とも普通の支出・収入として数える (合計では差額だけ残る)。
// 立替の印を付けずに記録した支出を、手で入れた「立替金返金」で相殺している
// 場合もあるので、立替と結びついていない返金は今までどおり収入に数える。

function refundsByAdvanceId(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.advanceRefundFor) map.set(e.advanceRefundFor, e);
  }
  return map;
}

function computeAdvanceFlowIds(entries) {
  const refunds = refundsByAdvanceId(entries);
  const ids = new Set();
  for (const e of entries) {
    if (e.type !== "expense" || e.advance !== true) continue;
    const refund = refunds.get(e.id);
    if (!refund) {
      ids.add(e.id);
    } else if (refund.amount === e.amount) {
      ids.add(e.id);
      ids.add(refund.id);
    }
  }
  return ids;
}

// --- 返金は「支出の取り消し」として数える ----------------------------------
//
// カードの返金 (返品・キャンセル) は稼いだお金ではなく、払ったお金が戻っただけ。
// 収入に数えると、収入と支出が両方膨らみ、返品した支出は予算や Need/Want に
// 残ったままになる (予算オーバーに見える)。簿記でも費用の取り消し (戻し入れ)
// として、元の費用科目を減らす。そこで、元の支出のカテゴリのマイナスの支出に直す。
// 精算額が立替額と違う立替の返金も同じ (差額だけが自分の負担として残る)。

// 返金の記録ID → 取り消す支出のカテゴリ
function computeRefundCategories(entries) {
  const map = new Map();
  const byId = new Map(entries.map((e) => [e.id, e]));
  // 店名ごとの支出 (新しい順)。カードの返金は同じ店の直近の支出を取り消すとみなす
  const expensesByMerchant = new Map();
  for (const e of entries) {
    if (e.type !== "expense" || !e.memo) continue;
    const key = normalizeMemo(e.memo);
    if (!expensesByMerchant.has(key)) expensesByMerchant.set(key, []);
    expensesByMerchant.get(key).push(e);
  }
  for (const list of expensesByMerchant.values()) {
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  for (const e of entries) {
    if (e.type !== "income") continue;
    if (e.advanceRefundFor && byId.get(e.advanceRefundFor)?.advance === true) {
      // 立替の返金 (同額の組は立替の除外で最初から除かれるので、ここに来るのは金額違い)
      map.set(e.id, byId.get(e.advanceRefundFor).category);
    } else if (e.category === CARD_REFUND_CATEGORY) {
      const merchant = String(e.memo || "").replace(/^返金[:：]\s*/, "");
      const original = (expensesByMerchant.get(normalizeMemo(merchant)) || []).find(
        (x) => x.date <= e.date
      );
      map.set(
        e.id,
        original ? original.category : merchant ? guessCategoryFromMerchant(merchant) : "その他支出"
      );
    }
  }
  return map;
}

/**
 * 集計に使う「自分のお金の出入り」に直した記録。
 *   - 立替・同額で精算した返金の組、振替 (現金⇔口座) は除く
 *   - 返金は収入ではなく、元の支出のカテゴリのマイナスの支出にする
 * advanceIds・refundCategories は全記録から作ったもの (上の2つの関数)。
 */
function toOwnFlows(list, advanceIds, refundCategories) {
  const out = [];
  for (const e of list) {
    if (e.type === "transfer" || advanceIds.has(e.id)) continue;
    const category = e.type === "income" ? refundCategories.get(e.id) : null;
    out.push(category ? { ...e, type: "expense", category, amount: -e.amount } : e);
  }
  return out;
}

// --- 予算の使用率通知 -------------------------------------------------------

// 高い段階から並べる。100% を超えたら 80%・50% の通知はもう要らない
const BUDGET_ALERT_LEVELS = [1, 0.8, 0.5];

function yen(amount) {
  return "¥" + String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 今月 (month は "2026-10" の形) の使用率が 50% / 80% / 100% を超えた
 * カテゴリと予算全体のうち、まだ通知していないもの。
 * sentKeys はその月に通知済みの印。返す keys を通知できたら sentKeys に足す。
 */
function budgetAlertsToSend(entries, budgets, month, sentKeys) {
  const monthEntries = entries.filter((e) => String(e.date || "").startsWith(month));
  const flows = toOwnFlows(monthEntries, computeAdvanceFlowIds(entries), computeRefundCategories(entries));
  const actuals = new Map();
  for (const e of flows) {
    if (e.type === "expense") actuals.set(e.category, (actuals.get(e.category) || 0) + e.amount);
  }
  const targets = Object.keys(budgets)
    .filter((c) => budgets[c] > 0)
    .map((c) => ({ name: c, budget: budgets[c], actual: actuals.get(c) || 0 }));
  // 全体は画面の予算バーと同じく、予算を設定したカテゴリだけで数える
  if (targets.length > 1) {
    targets.unshift({
      name: "予算全体",
      budget: targets.reduce((sum, t) => sum + t.budget, 0),
      actual: targets.reduce((sum, t) => sum + t.actual, 0),
    });
  }

  const alerts = [];
  for (const { name, budget, actual } of targets) {
    const reached = BUDGET_ALERT_LEVELS.filter((level) => actual / budget >= level);
    if (reached.length === 0 || sentKeys.includes(`${name}:${reached[0]}`)) continue;
    const percent = Math.round((actual / budget) * 100);
    alerts.push({
      keys: reached.map((level) => `${name}:${level}`),
      title: `${name}の予算を${percent}%使いました`,
      body:
        actual >= budget
          ? `${yen(actual - budget)} オーバーしています (${yen(actual)} / ${yen(budget)})`
          : `残り ${yen(budget - actual)} です (${yen(actual)} / ${yen(budget)})`,
      tag: `budget-${name}`,
    });
  }
  return alerts;
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

// アプリで取り込んだ記録のカテゴリを直すと、店名→カテゴリが settings/merchantCategories に
// 残る (キーは normalizeMemo した店名)。アプリの applyLearnedCategories と同じく上書きする
function getMerchantCategories_(cfg, auth, docName) {
  const doc = firestore_(cfg, auth, "get", docName);
  return doc && doc.fields ? fromFields_(doc.fields) : {};
}

function applyLearnedCategories_(list, learned) {
  for (const e of list) {
    const category = e.type === "expense" ? learned[normalizeMemo(e.memo)] : null;
    if (typeof category === "string" && category) e.category = category;
  }
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

function dedupeKey_(e) {
  return JSON.stringify([e.date, e.type, e.category, e.amount, normalizeMemo(e.memo)]);
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

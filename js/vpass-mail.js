// 三井住友カード (Vpass) の利用通知メールの読み取りと、店名からのカテゴリ推測。
//
// アプリ (js/app.js の「メールから読み込み」・カード利用履歴CSV) と、
// Google Apps Script の自動取り込み (apps-script/vpass-import.gs) の両方で
// 同じ判定をする。Apps Script は ES モジュールを読めないので、向こうには
// この内容を書き写してある。食い違わないことは test/verify-apps-script.mjs が
// 確かめる (ここを直したら、apps-script/vpass-import.gs も同じように直す)。

export const GMAIL_QUERY = 'from:statement@vpass.ne.jp subject:"ご利用のお知らせ" newer_than:60d';

// お店の名前からカテゴリを推測する。Suica/PASMO等の交通系は確実、それ以外は
// よくある業態のキーワードで大まかに振り分け、当てはまらなければ「その他支出」。
// 店名のルールは toHalfWidthAscii で半角化したあとの文字列に対して判定するため、
// 英数字は半角で書く (全角のまま書くと絶対に一致しない)。
// 「GU」「ETC」のような短い英字は他の語の一部に紛れ込みやすいので、前後が
// 英字でないことを条件にする (SKETCH の ETC、GUCCI の GU などを避ける)。
// exclude は「パターンには一致するが、このカテゴリではないもの」の除外指定。
export const MERCHANT_CATEGORY_RULES = [
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

export function toFullWidthKana(text) {
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

export function toHalfWidthAscii(text) {
  return toFullWidthKana(text)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

export function guessCategoryFromMerchant(merchant) {
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
export function parseVpassEmails(text) {
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

// 給与サイトの明細ページから、家計簿の給与明細フォームへ取り込む。
//
// 流れ:
//   1. 給与サイトで明細ページを開いた状態で、ブックマークレットを押す
//   2. ブックマークレットはページから「項目名と値の組」を拾い、家計簿を開いて
//      URL の # 以降で渡す (# 以降はサーバーに送られず、ブラウザの中だけで動く)
//   3. 家計簿は受け取った組を interpretPayslipImport() で本給・所得税などに
//      振り分け、フォームに入れる。保存はせず、確認して「追加」を押してもらう
//
// ブックマークレットには判断を書かず、拾うだけにしている。どれが何の項目かを
// ブックマーク側に書くと、読み取りを直すたびにブックマークを入れ直すことになる。
// 判断はすべてこのファイル (家計簿側) にあるので、ここを直せばすぐ反映される。

export const PAYSLIP_IMPORT_HASH = "#payslip-import=";

// 明細に出てくる項目名の言い回し。会社や給与サービスによって呼び方が違うので、
// 同じものを指す名前を並べておく。比べるときは空白・コロン・全角半角を揃える。
const FIELD_ALIASES = {
  baseSalary: ["本給", "基本給"],
  locationAllowance: ["勤務地手当", "地域手当"],
  commute: ["通勤手当", "通勤費", "交通費", "非課税通勤手当", "通勤手当(非課税)", "課税通勤手当"],
  overtimePay: ["時間外勤務手当", "時間外手当", "残業手当", "時間外労働手当", "超過勤務手当"],
  salaryAdjustment: ["給与調整", "給与調整額", "調整額"],
  housing: ["寮社宅費", "社宅費", "寮費", "社宅家賃", "社宅使用料"],
  healthInsurance: ["健康保険", "健康保険料"],
  nursingInsurance: ["介護保険", "介護保険料"],
  pensionInsurance: ["厚生年金", "厚生年金保険", "厚生年金保険料", "厚年保険", "厚年"],
  employmentInsurance: ["雇用保険", "雇用保険料"],
  incomeTax: ["所得税", "源泉所得税"],
  residentTax: ["住民税", "市県民税", "市町村民税", "特別徴収住民税"],
  childSupportLevy: ["子ども支援金", "子ども・子育て支援金", "子ども子育て支援金", "子育て支援金"],
  bonusAmount: ["賞与", "賞与額", "賞与支給額", "賞与金額"],
};

const TOTAL_ALIASES = {
  gross: ["支給合計", "総支給額", "支給額合計", "支給計", "総支給金額", "支給総額"],
  deductions: ["控除合計", "控除額合計", "控除計", "総控除額", "控除総額"],
  net: [
    "差引支給額", "差引支給合計", "差引支給金額", "振込支給額", "振込額", "振込金額",
    "振込金額1", "銀行振込額", "手取額", "手取り",
  ],
};

// 年末調整で所得税を精算する行。所得税に足し引きする (還付はマイナス)。
// 12月 (か1月) の明細に出て、数万円になることもあるので落とせない。
const TAX_ADJUSTMENT_ALIASES = [
  "年調過不足税額", "年調過不足額", "年末調整過不足額", "年末調整過不足", "年末調整過不足税額",
  "年調還付金", "年調還付", "年末調整還付", "年末調整還付額", "年末調整還付金",
  "年調徴収", "年末調整徴収", "年調精算額", "年末調整精算額", "年末調整",
];

const SALARY_EARNINGS = ["baseSalary", "locationAllowance", "commute", "overtimePay", "salaryAdjustment"];
const SALARY_DEDUCTIONS = [
  "housing", "healthInsurance", "nursingInsurance", "childSupportLevy", "pensionInsurance",
  "employmentInsurance", "incomeTax", "residentTax",
];

// 明細の区切りの見出し。この下にある項目が支給か控除かを見分けるのに使う
const EARNING_SECTIONS = ["支給", "支給項目"];
const DEDUCTION_SECTIONS = ["控除", "控除項目"];
const KNOWN_SECTIONS = [...EARNING_SECTIONS, ...DEDUCTION_SECTIONS, "勤怠", "勤怠項目", "記事", "その他"];
const BONUS_EARNINGS = ["bonusAmount"];
const BONUS_DEDUCTIONS = [
  "healthInsurance", "nursingInsurance", "childSupportLevy", "pensionInsurance",
  "employmentInsurance", "incomeTax",
];

// 全角英数・全角記号を半角に、空白とコロンを取り除く
function normalizeLabel(text) {
  return String(text || "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　:：]/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

// "250,000" "250,000円" "¥250,000" "▲1,000" (マイナス) "２５００００" などを数にする
export function parseAmount(text) {
  const s = String(text || "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，円¥￥\s　]/g, "")
    .replace(/^[▲△－−-]/, "-");
  if (!/^-?\d{1,9}$/.test(s)) return null;
  return Number(s);
}

// "2026年8月25日" "2026/08/25" "2026-8-25" "2026.08.25" を YYYY-MM-DD にする
export function parseDate(text) {
  const s = String(text || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = s.match(/(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// 合計・小計の行 (支給合計・社会保険計 など)。項目として足すと二重に数えてしまう
const TOTAL_LABELS = new Set(Object.values(TOTAL_ALIASES).flat().map(normalizeLabel));
function isSubtotalLabel(label) {
  const n = normalizeLabel(label);
  return TOTAL_LABELS.has(n) || /(合計|小計|計)$/.test(n);
}

/**
 * 別名に当たる行の金額を合計する。
 * - 名前の違う行は足す (「課税通勤手当」と「非課税通勤手当」はどちらも通勤手当)
 * - 同じ名前の行は最初の1つだけ (同じ項目を2か所に表示している明細で二重に数えない)
 * - ▲ (マイナス) も受け取る (給与調整のマイナス、年末調整の還付など)
 * - 区切り (支給/控除) が読めている明細では、別の区切りの行は見ない
 *   (「記事」欄に参考として出ている同じ名前の行を拾わない)
 * 1行も無ければ null。
 */
function collectAmount(pairs, aliases, sections) {
  const wanted = new Set(aliases.map(normalizeLabel));
  const seen = new Set();
  let total = null;
  for (const [label, value, section] of pairs) {
    const key = normalizeLabel(label);
    if (!wanted.has(key) || seen.has(key)) continue;
    if (sections && section && KNOWN_SECTIONS.includes(normalizeLabel(section)) &&
        !sections.includes(normalizeLabel(section))) continue;
    const amount = parseAmount(value);
    if (amount === null) continue;
    seen.add(key);
    total = (total || 0) + amount;
  }
  return total;
}

/**
 * ブックマークレットから受け取った内容を、給与明細フォームの値に振り分ける。
 * 受け取ったものは外から来た値なので、形を確かめてから使う。
 *
 * 戻り値:
 *   { kind: "salary" | "bonus", fields, date, memo, checks, recognized }
 *   読み取れる項目が1つも無ければ null
 */
export function interpretPayslipImport(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.pairs)) return null;

  // 形の崩れた組や、極端に長いものは捨てる。3つ目はどの区切り (支給/控除…) の下か
  const pairs = payload.pairs
    .filter((p) => Array.isArray(p) && (p.length === 2 || p.length === 3))
    .map(([label, value, section]) => [
      String(label).slice(0, 40),
      String(value).slice(0, 40),
      String(section || "").slice(0, 10),
    ])
    .slice(0, 400);

  const hasSections = pairs.some(([, , section]) =>
    [...EARNING_SECTIONS, ...DEDUCTION_SECTIONS].includes(normalizeLabel(section))
  );
  const earningKeys = new Set([...SALARY_EARNINGS, ...BONUS_EARNINGS]);
  const found = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const amount = collectAmount(
      pairs,
      aliases,
      hasSections ? (earningKeys.has(field) ? EARNING_SECTIONS : DEDUCTION_SECTIONS) : null
    );
    if (amount !== null) found[field] = amount;
  }
  // 合計は「振込金額」と「差引支給額」のように同じ額を別の名前で2回出す明細が
  // あるので、足さずに最初の1つを使う
  const totals = {};
  for (const [key, aliases] of Object.entries(TOTAL_ALIASES)) {
    const wanted = new Set(aliases.map(normalizeLabel));
    for (const [label, value] of pairs) {
      const amount = wanted.has(normalizeLabel(label)) ? parseAmount(value) : null;
      if (amount !== null) {
        totals[key] = amount;
        break;
      }
    }
  }

  // 本給があれば給与、本給が無く賞与額があれば賞与
  const bonus =
    found.baseSalary === undefined && (found.bonusAmount !== undefined || payload.bonus === true);
  const kind = bonus ? "bonus" : "salary";
  const earningFields = bonus ? BONUS_EARNINGS : SALARY_EARNINGS;
  const deductionFields = bonus ? BONUS_DEDUCTIONS : SALARY_DEDUCTIONS;

  const fields = {};
  for (const f of [...earningFields, ...deductionFields]) {
    if (found[f] !== undefined) fields[f] = found[f];
  }
  const recognized = Object.keys(fields).length;
  if (recognized === 0) return null;
  // 支給が1つも読めていないなら、明細として扱えない
  if (!earningFields.some((f) => fields[f] > 0)) return null;

  const checks = [];
  const yen = (n) => `${n.toLocaleString("ja-JP")}円`;

  // 年末調整: 所得税に足し引きする。控除欄の ▲ は還付、支給欄に出ていれば還付
  const taxAdjustLabels = new Set(TAX_ADJUSTMENT_ALIASES.map(normalizeLabel));
  let taxAdjustment = 0;
  let refundInEarnings = 0;
  const seenAdjust = new Set();
  for (const [label, value, section] of pairs) {
    const key = normalizeLabel(label);
    if (!taxAdjustLabels.has(key) || seenAdjust.has(key)) continue;
    const amount = parseAmount(value);
    if (amount === null || amount === 0) continue;
    seenAdjust.add(key);
    if (EARNING_SECTIONS.includes(normalizeLabel(section))) {
      taxAdjustment -= amount;
      refundInEarnings += amount;
    } else {
      taxAdjustment += amount;
    }
  }
  if (taxAdjustment !== 0) {
    fields.incomeTax = (fields.incomeTax || 0) + taxAdjustment;
    checks.push({
      ok: true,
      text:
        `年末調整の${taxAdjustment < 0 ? "還付" : "追加徴収"} ${yen(Math.abs(taxAdjustment))}を` +
        "所得税に含めました",
    });
  }

  const sum = (list) => list.reduce((s, f) => s + (fields[f] || 0), 0);
  const gross = sum(earningFields);

  // 慶弔掛金・福祉会費のような個別の控除は、項目名が会社ごとにばらばら。
  // 明細の区切り (支給/控除) が分かれば、控除の下にある「知らない名前」の
  // 項目を名前つきで拾える。分からなければ合計から逆算する。
  // 合計・小計の行や年末調整の行は項目ではないので拾わない。
  const knownLabels = new Set(Object.values(FIELD_ALIASES).flat().map(normalizeLabel));
  const unknownUnder = (sections) => {
    const seen = new Set();
    return pairs.filter(([label, value, section]) => {
      const key = normalizeLabel(label);
      if (!sections.includes(normalizeLabel(section))) return false;
      if (knownLabels.has(key) || taxAdjustLabels.has(key) || isSubtotalLabel(label)) return false;
      const amount = parseAmount(value);
      if (amount === null || amount === 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // 支給の下にある知らない項目は入れる欄が無い。黙って捨てると手取りが
  // 合わなくなるので、名前を出して知らせる
  const unknownEarnings = unknownUnder(EARNING_SECTIONS);
  if (unknownEarnings.length > 0) {
    checks.push({
      ok: false,
      text:
        "支給の " +
        unknownEarnings.map(([l, v]) => `「${l}」${yen(parseAmount(v))}`).join("・") +
        " は入れる欄がありません。金額が合わないので、給与調整に足すなどして直してください",
    });
  }

  let deductions = sum(deductionFields);
  let otherFromNet = false;
  const unknownDeductions = unknownUnder(DEDUCTION_SECTIONS);
  if (unknownDeductions.length > 0) {
    const rest = unknownDeductions.reduce((s, [, v]) => s + parseAmount(v), 0);
    if (bonus) {
      checks.push({
        ok: false,
        text: `控除の ${unknownDeductions.map(([l]) => `「${l}」`).join("・")} は賞与の欄にありません`,
      });
    } else {
      fields.otherDeductions = rest;
      deductions += rest;
      checks.push({
        ok: true,
        text:
          unknownDeductions.map(([l]) => l).join("・") +
          ` (計 ${yen(rest)}) を「その他控除」に入れました`,
      });
    }
  } else if (!bonus && !hasSections) {
    // 区切りが読めないときは合計から逆算する
    let rest = null;
    if (totals.deductions !== undefined) {
      rest = totals.deductions - deductions;
    } else if (totals.net !== undefined) {
      rest = gross - deductions - totals.net;
      otherFromNet = true;
    }
    if (rest !== null && rest > 0) {
      fields.otherDeductions = rest;
      deductions += rest;
      checks.push({
        ok: true,
        text: `名前の分からない控除 ${yen(rest)}を「その他控除」に入れました (合計からの逆算)`,
      });
    } else if (rest !== null && rest < 0) {
      otherFromNet = false;
      checks.push({
        ok: false,
        text: "控除が明細の合計より多くなっています。控除の欄を確認してください",
      });
    }
  }

  if (totals.gross !== undefined) {
    checks.push(
      totals.gross === gross + refundInEarnings
        ? { ok: true, text: "支給合計が明細と一致しました" }
        : {
            ok: false,
            text:
              `支給合計が明細 (${totals.gross.toLocaleString("ja-JP")}円) と ` +
              `${Math.abs(totals.gross - gross - refundInEarnings).toLocaleString("ja-JP")}円 合いません。` +
              "読み取れなかった支給項目があります",
          }
    );
  }
  if (totals.net !== undefined && !otherFromNet) {
    const net = gross - deductions;
    checks.push(
      totals.net === net
        ? { ok: true, text: "差引支給額 (振込額) が明細と一致しました" }
        : {
            ok: false,
            text:
              `差引支給額が明細 (${totals.net.toLocaleString("ja-JP")}円) と合いません。` +
              "内訳を確認してください",
          }
    );
  }
  if (totals.gross === undefined && totals.net === undefined) {
    checks.push({ ok: false, text: "明細の合計欄が見つからず、読み取りを検算できませんでした" });
  }

  // 支給日。ページの「支給日：2026年06月26日」を優先し、無ければ「支給日」の組
  let date = parseDate(payload.payDate);
  for (const [label, value] of date ? [] : pairs) {
    if (normalizeLabel(label).includes("支給日")) {
      date = parseDate(value);
      if (date) break;
    }
  }

  // 「2026年8月度」があればメモに使う
  let memo = bonus ? "賞与" : "給与";
  const period = String(payload.period || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (period) memo = `${Number(period[2])}月度${bonus ? "賞与" : "給与"}`;

  return { kind, fields, date, memo, checks, recognized };
}

/**
 * 給与サイトの明細ページの上で動くコード。ブックマークレットにして使う。
 * ページから「項目名」と、その右 (または下) にある値の組を拾い、家計簿を開いて渡す。
 *
 * 注意: この関数は toString() でそのままブックマークに入るので、外の変数を
 * 参照しない・行コメント (//) を使わない (改行が消えると後ろが全部コメントになる)。
 */
function bookmarkletBody(appUrl) {
  var docs = [];
  (function collect(d) {
    docs.push(d);
    var frames = d.querySelectorAll("iframe, frame");
    for (var i = 0; i < frames.length; i++) {
      try { if (frames[i].contentDocument) collect(frames[i].contentDocument); } catch (e) { /* 別サイトの枠は読めない */ }
    }
  })(document);

  function text(el) { return String(el && el.textContent || "").replace(/[\s　]+/g, " ").trim(); }
  function isValue(t) {
    var s = t.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); });
    return /^[▲△－−-]?[¥￥]?[\d,，]{1,13}円?$/.test(s.replace(/\s/g, "")) ||
      /\d{4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}/.test(s);
  }
  function isLeaf(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) { if (text(c)) return false; }
    return true;
  }
  function nextFilled(el) {
    var n = el.nextElementSibling;
    while (n && !text(n)) n = n.nextElementSibling;
    return n;
  }
  function valueFor(el) {
    var base = (el.closest && el.closest("td, th")) || el;
    var right = nextFilled(base);
    if (right && isValue(text(right))) return text(right);
    /* 右が項目名なら「項目名の行の下に金額の行」がある表とみなし、同じ列の下を見る */
    if (base.cellIndex !== undefined && base.parentElement) {
      var row = base.parentElement.nextElementSibling;
      for (var k = 0; k < 2 && row; k++) {
        if (row.cells && row.cells[base.cellIndex] && isValue(text(row.cells[base.cellIndex]))) {
          return text(row.cells[base.cellIndex]);
        }
        row = row.nextElementSibling;
      }
    }
    /* div で「項目」と「金額」を別々に包んでいる形 */
    if (!right && el.parentElement) {
      var up = nextFilled(el.parentElement);
      if (up && isValue(text(up))) return text(up);
    }
    return null;
  }

  var SECTION = /^(勤怠|支給|控除|記事|勤怠項目|支給項目|控除項目|その他)$/;
  var section = "";
  var pairs = [];
  var bodyText = "";
  for (var d = 0; d < docs.length; d++) {
    if (!docs[d].body) continue;
    bodyText += " " + text(docs[d].body);
    var all = docs[d].body.getElementsByTagName("*");
    for (var i = 0; i < all.length && pairs.length < 400; i++) {
      var el = all[i];
      if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName) || !isLeaf(el)) continue;
      var t = text(el);
      if (!t || t.length > 30) continue;
      /* 「支給」「控除」などの見出し。この下にある項目がどちらかを家計簿に伝える */
      if (SECTION.test(t.replace(/[\s\u3000]/g, ""))) { section = t.replace(/[\s\u3000]/g, ""); continue; }
      /* 1つの要素に「本給 250,000」のように並んでいる形 */
      var same = t.match(/^(\D{1,20}?)[\s:：]+([▲△－−-]?[¥￥]?[\d,，]{1,13}円?)$/);
      if (same) { pairs.push([same[1], same[2], section]); continue; }
      if (isValue(t)) continue;
      var v = valueFor(el);
      if (v !== null) pairs.push([t, v, section]);
    }
  }

  if (pairs.length === 0) {
    alert("このページから給与明細の項目を見つけられませんでした。\n明細の画面を開いてから押してください。");
    return;
  }
  var periodMatch = bodyText.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*度?/);
  var payDateMatch = bodyText.match(/支給日\s*[:：]?\s*(\d{4}\s*[年\/.-]\s*\d{1,2}\s*[月\/.-]\s*\d{1,2})/);
  var payload = {
    v: 1,
    pairs: pairs,
    period: periodMatch ? periodMatch[0] : "",
    payDate: payDateMatch ? payDateMatch[1] : "",
    bonus: /賞与/.test(bodyText) && !/本給|基本給/.test(bodyText)
  };
  var url = appUrl + "#payslip-import=" + encodeURIComponent(JSON.stringify(payload));
  var w = window.open(url, "_blank");
  if (!w) location.href = url;
}

/**
 * ブックマークに登録する文字列を作る。appUrl は家計簿のURL (# より前)。
 * 全体を encodeURIComponent しているので、スマホのブックマーク編集で改行が
 * 消えても壊れない。
 */
export function buildBookmarklet(appUrl) {
  const code = `(${bookmarkletBody.toString()})(${JSON.stringify(appUrl)});`;
  return "javascript:" + encodeURIComponent(code);
}

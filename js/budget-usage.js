// 集計に使う「自分のお金の出入り」と、予算の使用率通知の判定。
// apps-script/vpass-import.gs に書き写して、アプリを閉じていても Apps Script が
// 同じ計算で通知を出す。片方だけ直すと食い違うので、直すときは両方を直す
// (食い違いは test/verify-apps-script.mjs が見つける)。
// ※ 下の import の行より後ろが書き写しの対象。
import { guessCategoryFromMerchant, toHalfWidthAscii } from "./vpass-mail.js";

export const CARD_REFUND_CATEGORY = "カード返金";

export function normalizeMemo(memo) {
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

export function refundsByAdvanceId(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.advanceRefundFor) map.set(e.advanceRefundFor, e);
  }
  return map;
}

export function computeAdvanceFlowIds(entries) {
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
export function computeRefundCategories(entries) {
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
export function toOwnFlows(list, advanceIds, refundCategories) {
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
export const BUDGET_ALERT_LEVELS = [1, 0.8, 0.5];

function yen(amount) {
  return "¥" + String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 今月 (month は "2026-10" の形) の使用率が 50% / 80% / 100% を超えた
 * カテゴリと予算全体のうち、まだ通知していないもの。
 * sentKeys はその月に通知済みの印。返す keys を通知できたら sentKeys に足す。
 */
export function budgetAlertsToSend(entries, budgets, month, sentKeys) {
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

// 「要確認」: 取り込みの誤りに月末を待たずに気づけるよう、怪しい記録を拾う。
// 「確認済み」にした記録 (reviewed: true) は出さない。

const LOOKBACK_DAYS = 120;
// 仮のままこれだけ経ったら、カード明細に出てこなかったと考える
const STALE_PENDING_DAYS = 60;
// そのカテゴリのいつもの金額 (中央値) の何倍で「大きい」とするか
const LARGE_FACTOR = 5;
const LARGE_MIN = 10000;

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
}

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * entries: 全記録。today: "YYYY-MM-DD"。
 * 戻り値: [{ entry, reasons: [文字列] }] (新しい順)
 */
export function reviewItems(entries, today) {
  const amountsByCategory = new Map();
  for (const e of entries) {
    if (e.type !== "expense") continue;
    if (!amountsByCategory.has(e.category)) amountsByCategory.set(e.category, []);
    amountsByCategory.get(e.category).push(e.amount);
  }

  const items = [];
  for (const e of entries) {
    if (e.type !== "expense" || e.reviewed === true || !e.date) continue;
    // 給与天引きの家賃・固定費は、毎月決まった額なので見ない
    if (e.payslipHousingFor || e.recurring) continue;
    const age = daysBetween(e.date, today);
    if (age > LOOKBACK_DAYS) continue;
    const imported = e.source === "gmail" || e.source === "card";
    const reasons = [];
    if (imported && e.category === "その他支出") reasons.push("カテゴリが「その他」のまま");
    if (e.source === "gmail" && age >= STALE_PENDING_DAYS) {
      reasons.push(`${age}日たっても仮のまま (カード明細に出てこない)`);
    }
    // 自分を除いた同じカテゴリの金額が3件以上あるときだけ比べる
    const others = [...(amountsByCategory.get(e.category) || [])];
    others.splice(others.indexOf(e.amount), 1);
    if (others.length >= 3 && e.amount >= LARGE_MIN) {
      const usual = median(others);
      if (e.amount >= usual * LARGE_FACTOR) {
        reasons.push(`いつもの${Math.round(e.amount / usual)}倍の金額`);
      }
    }
    if (reasons.length > 0) items.push({ entry: e, reasons });
  }
  return items.sort((a, b) => (a.entry.date < b.entry.date ? 1 : -1));
}

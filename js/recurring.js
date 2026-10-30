// 固定費 (毎月同じ日・同じ額の支出) の自動記録。
//
// 登録した固定費は settings/recurring に { [id]: item } で入る。
// item.next は「次に記録する月 (YYYY-MM)」。記録したら先へ進めるので、
// 自動で入った記録を消しても、もう一度は入らない。

function nextMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// 31日のように、その月に無い日は月末にする
function dateIn(ym, day) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * 今日までに来た分の記録を返す。アプリを何か月か開かなかったときは、
 * 来ていた月の分をまとめて返す。
 * 戻り値: { posts: [{ id, item, date, month }], next: { [id]: 次の月 } }
 */
export function dueRecurring(items, today) {
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate()
  ).padStart(2, "0")}`;
  const posts = [];
  const next = {};
  for (const [id, item] of Object.entries(items || {})) {
    if (!item || !/^\d{4}-\d{2}$/.test(item.next || "") || !(item.day >= 1)) continue;
    let month = item.next;
    // shortcut: 1回に最大24か月分まで。それより長く開かなかったら、残りは次に開いたとき
    for (let i = 0; i < 24 && dateIn(month, item.day) <= todayStr; i++) {
      posts.push({ id, item, month, date: dateIn(month, item.day) });
      month = nextMonth(month);
    }
    if (month !== item.next) next[id] = month;
  }
  return { posts, next };
}

export { nextMonth };

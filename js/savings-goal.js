// 貯金の目標 (settings/savingsGoal: { amount, deadline: "YYYY-MM" })。
// 累計貯金額がいくらになれば達成か、期限の月末までに毎月いくら残せばいいかを出す。

/**
 * total: 今の累計貯金額。today: Date。
 * 戻り値: { done, overdue, remaining, months, perMonth } / 目標が無ければ null
 */
export function goalProgress(total, goal, today) {
  if (!goal || !(goal.amount > 0) || !/^\d{4}-\d{2}$/.test(goal.deadline || "")) return null;
  const [y, m] = goal.deadline.split("-").map(Number);
  // 今月も含めて、期限の月まで何か月あるか
  const months = y * 12 + m - (today.getFullYear() * 12 + today.getMonth() + 1) + 1;
  const remaining = goal.amount - total;
  if (remaining <= 0) return { done: true, overdue: false, remaining: 0, months, perMonth: 0 };
  if (months <= 0) return { done: false, overdue: true, remaining, months: 0, perMonth: remaining };
  return { done: false, overdue: false, remaining, months, perMonth: Math.ceil(remaining / months) };
}

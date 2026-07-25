"use strict";

const FIREBASE_SDK_VERSION = "10.14.1";
const FIREBASE_CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

// Firebase SDK は動的 import で読み込む。CDN に到達できない環境
// (ネットワーク不調・広告ブロッカー等) でもアプリを固まらせず、
// エラー画面を出せるようにするため。
let firestoreApi = null;
let authApi = null;

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const CATEGORIES = {
  expense: [
    "食費",
    "日用品",
    "住居",
    "水道・光熱",
    "通信",
    "交通",
    "医療",
    "教育",
    "交際費",
    "趣味・娯楽",
    "衣服・美容",
    "その他支出",
  ],
  income: ["給与", "賞与", "副収入", "その他収入"],
  save: ["株式", "投資信託", "定期預金", "その他貯蓄"],
};

const TYPE_LABELS = { expense: "支出", income: "収入", save: "貯蓄" };

// 収入目標の「賞与」は月額ではなく、ボーナス月・給与の何か月分かで計算する
const BONUS_CATEGORY = "賞与";

// 給与明細の内訳入力を出すカテゴリ
const PAYSLIP_CATEGORY = "給与";
const PAYSLIP_EARNING_FIELDS = ["baseSalary", "commute", "overtimePay"];
const PAYSLIP_DEDUCTION_FIELDS = [
  "healthInsurance",
  "nursingInsurance",
  "pensionInsurance",
  "employmentInsurance",
  "incomeTax",
  "residentTax",
  "otherDeductions",
];
const PAYSLIP_FIELDS = [...PAYSLIP_EARNING_FIELDS, ...PAYSLIP_DEDUCTION_FIELDS];

// Need / Want / Save (50:30:20) の分類。ここに無い支出カテゴリはWant扱い。
const NEED_CATEGORIES = ["食費", "住居", "水道・光熱", "通信", "交通", "医療", "教育", "日用品"];
const WANT_CATEGORIES = ["交際費", "趣味・娯楽", "衣服・美容", "その他支出"];
const NWS_TARGET_RATIO = { need: 0.5, want: 0.3, save: 0.2 };
const NWS_BUCKET_COLORS = { need: "#2f7dea", want: "#f5c518" };

function categoryBucket(category) {
  return NEED_CATEGORIES.includes(category) ? "need" : "want";
}

const AUTH_ERROR_MESSAGES = {
  "auth/email-already-in-use": "このメールアドレスは既に登録されています。",
  "auth/invalid-email": "メールアドレスの形式が正しくありません。",
  "auth/weak-password": "パスワードは6文字以上にしてください。",
  "auth/user-not-found": "メールアドレスまたはパスワードが正しくありません。",
  "auth/wrong-password": "メールアドレスまたはパスワードが正しくありません。",
  "auth/invalid-credential": "メールアドレスまたはパスワードが正しくありません。",
  "auth/too-many-requests": "試行回数が多すぎます。しばらく待ってから再度お試しください。",
  "auth/network-request-failed": "ネットワークエラーが発生しました。接続をご確認ください。",
};

function authErrorMessage(err) {
  return AUTH_ERROR_MESSAGES[err.code] || `エラーが発生しました (${err.code || err.message})`;
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

/** @type {{id: string, date: string, type: "income"|"expense", category: string, amount: number, memo: string}[]} */
let entries = [];

// カテゴリ名 -> 月間予算額 (支出カテゴリのみ)
let budgets = {};

// カテゴリ名 -> 月間収入目標額 (収入カテゴリのみ)
let incomeBudgets = {};

// 表示中の月 (毎月1日の Date)
let currentMonth = startOfMonth(new Date());

// 表示モード: "month" (月別) または "year" (年間)
let viewMode = "month";

let db = null;
let auth = null;
let currentUid = null;
let unsubscribeEntries = null;
let unsubscribeBudget = null;
let unsubscribeIncomeBudget = null;
let authMode = "login";

// 記録一覧の並び替え
let sortColumn = "date";
let sortDirection = "desc";
const SORT_DEFAULT_DIRECTION = { date: "desc", type: "asc", category: "asc", amount: "desc" };

// 記録一覧の絞り込み
let filterType = "all";
let filterCategory = "all";

// Gmail 連携 (メールからの読み込み)
let googleClientId = null;
let googleTokenClient = null;
let gmailAccessToken = null;

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function formatYen(amount) {
  return "¥" + amount.toLocaleString("ja-JP");
}

function formatMonth(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function toDateInputValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function entriesForMonth(monthDate) {
  const prefix = `${monthDate.getFullYear()}-${String(
    monthDate.getMonth() + 1
  ).padStart(2, "0")}`;
  return entries
    .filter((e) => e.date.startsWith(prefix))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function entriesForYear(monthDate) {
  const prefix = String(monthDate.getFullYear());
  return entries
    .filter((e) => e.date.startsWith(prefix))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function periodEntries() {
  return viewMode === "year" ? entriesForYear(currentMonth) : entriesForMonth(currentMonth);
}

// ---------------------------------------------------------------------------
// DOM 参照
// ---------------------------------------------------------------------------

const el = {
  loadingScreen: document.getElementById("loading-screen"),
  setupScreen: document.getElementById("setup-screen"),
  sdkErrorScreen: document.getElementById("sdk-error-screen"),
  authScreen: document.getElementById("auth-screen"),
  appRoot: document.getElementById("app-root"),

  authTabs: document.querySelectorAll(".auth-tab"),
  authForm: document.getElementById("auth-form"),
  authEmail: document.getElementById("auth-email"),
  authPassword: document.getElementById("auth-password"),
  authError: document.getElementById("auth-error"),
  authSubmitBtn: document.getElementById("auth-submit-btn"),
  authForgotBtn: document.getElementById("auth-forgot-btn"),

  userEmail: document.getElementById("user-email"),
  logoutBtn: document.getElementById("logout-btn"),

  viewTabs: document.querySelectorAll(".view-tab"),
  currentMonth: document.getElementById("current-month"),
  prevMonth: document.getElementById("prev-month"),
  nextMonth: document.getElementById("next-month"),
  todayBtn: document.getElementById("today-btn"),
  budgetSectionTitle: document.getElementById("budget-section-title"),
  listSectionTitle: document.getElementById("list-section-title"),
  cumulativeSavings: document.getElementById("cumulative-savings"),
  cumulativeChange: document.getElementById("cumulative-change"),
  totalIncome: document.getElementById("total-income"),
  totalExpense: document.getElementById("total-expense"),
  balance: document.getElementById("balance"),
  totalSave: document.getElementById("total-save"),
  form: document.getElementById("entry-form"),
  formTitle: document.getElementById("form-title"),
  entryId: document.getElementById("entry-id"),
  entryDate: document.getElementById("entry-date"),
  entryCategory: document.getElementById("entry-category"),
  entryAmount: document.getElementById("entry-amount"),
  entryMemo: document.getElementById("entry-memo"),
  payslipSection: document.getElementById("payslip-section"),
  payslipToggleBtn: document.getElementById("payslip-toggle-btn"),
  payslipBreakdown: document.getElementById("payslip-breakdown"),
  payslipBaseSalary: document.getElementById("payslip-base-salary"),
  payslipCommute: document.getElementById("payslip-commute"),
  payslipOvertimePay: document.getElementById("payslip-overtime-pay"),
  payslipHealthInsurance: document.getElementById("payslip-health-insurance"),
  payslipNursingInsurance: document.getElementById("payslip-nursing-insurance"),
  payslipPensionInsurance: document.getElementById("payslip-pension-insurance"),
  payslipEmploymentInsurance: document.getElementById("payslip-employment-insurance"),
  payslipIncomeTax: document.getElementById("payslip-income-tax"),
  payslipResidentTax: document.getElementById("payslip-resident-tax"),
  payslipOtherDeductions: document.getElementById("payslip-other-deductions"),
  payslipGrossValue: document.getElementById("payslip-gross-value"),
  payslipDeductionValue: document.getElementById("payslip-deduction-value"),
  payslipNetValue: document.getElementById("payslip-net-value"),
  payslipClearBtn: document.getElementById("payslip-clear-btn"),
  submitBtn: document.getElementById("submit-btn"),
  cancelEditBtn: document.getElementById("cancel-edit-btn"),
  yearlyChartSection: document.getElementById("yearly-chart-section"),
  monthlyBarYaxis: document.getElementById("monthly-bar-yaxis"),
  monthlyBarChart: document.getElementById("monthly-bar-chart"),
  nwsChart: document.getElementById("nws-chart"),
  nwsLegend: document.getElementById("nws-legend"),
  budgetOverall: document.getElementById("budget-overall"),
  budgetBreakdown: document.getElementById("budget-breakdown"),
  editBudgetBtn: document.getElementById("edit-budget-btn"),
  budgetForm: document.getElementById("budget-form"),
  budgetInputs: document.getElementById("budget-inputs"),
  cancelBudgetBtn: document.getElementById("cancel-budget-btn"),
  planActualSectionTitle: document.getElementById("plan-actual-section-title"),
  expensePlanActual: document.getElementById("expense-plan-actual"),
  incomePlanActual: document.getElementById("income-plan-actual"),
  editIncomeBudgetBtn: document.getElementById("edit-income-budget-btn"),
  incomeBudgetForm: document.getElementById("income-budget-form"),
  incomeBudgetInputs: document.getElementById("income-budget-inputs"),
  bonusMonthGrid: document.getElementById("bonus-month-grid"),
  bonusMultiplierInput: document.getElementById("bonus-multiplier-input"),
  cancelIncomeBudgetBtn: document.getElementById("cancel-income-budget-btn"),
  entryList: document.getElementById("entry-list"),
  filterType: document.getElementById("filter-type"),
  filterCategory: document.getElementById("filter-category"),
  listEmptyMessage: document.getElementById("list-empty-message"),
  exportCsvBtn: document.getElementById("export-csv-btn"),
  importCsvInput: document.getElementById("import-csv-input"),
  gmailImportBtn: document.getElementById("gmail-import-btn"),
};

function selectedType() {
  return document.querySelector('input[name="entry-type"]:checked').value;
}

// ---------------------------------------------------------------------------
// 画面切り替え
// ---------------------------------------------------------------------------

function showOnly(screen) {
  el.loadingScreen.classList.toggle("hidden", screen !== "loading");
  el.setupScreen.classList.toggle("hidden", screen !== "setup");
  el.sdkErrorScreen.classList.toggle("hidden", screen !== "sdk-error");
  el.authScreen.classList.toggle("hidden", screen !== "auth");
  el.appRoot.classList.toggle("hidden", screen !== "app");
}

function showAuthScreen() {
  if (unsubscribeEntries) {
    unsubscribeEntries();
    unsubscribeEntries = null;
  }
  if (unsubscribeBudget) {
    unsubscribeBudget();
    unsubscribeBudget = null;
  }
  if (unsubscribeIncomeBudget) {
    unsubscribeIncomeBudget();
    unsubscribeIncomeBudget = null;
  }
  entries = [];
  budgets = {};
  incomeBudgets = {};
  currentUid = null;
  el.authForm.reset();
  el.authError.classList.add("hidden");
  showOnly("auth");
}

function showApp(user) {
  currentUid = user.uid;
  el.userEmail.textContent = user.email;
  showOnly("app");
  subscribeEntries(user.uid);
  subscribeBudget(user.uid);
  subscribeIncomeBudget(user.uid);
  resetForm();
  closeBudgetForm();
  closeIncomeBudgetForm();
}

// ---------------------------------------------------------------------------
// Firestore 連携
// ---------------------------------------------------------------------------

function entriesCollection(uid) {
  return firestoreApi.collection(db, `users/${uid}/entries`);
}

function subscribeEntries(uid) {
  if (unsubscribeEntries) unsubscribeEntries();
  const q = firestoreApi.query(entriesCollection(uid), firestoreApi.orderBy("date", "desc"));
  unsubscribeEntries = firestoreApi.onSnapshot(
    q,
    (snapshot) => {
      entries = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    },
    (error) => {
      console.error(error);
      alert("データの取得に失敗しました: " + error.message);
    }
  );
}

async function addEntryToDb(data) {
  await firestoreApi.addDoc(entriesCollection(currentUid), data);
}

async function updateEntryInDb(id, data) {
  await firestoreApi.updateDoc(firestoreApi.doc(db, `users/${currentUid}/entries/${id}`), data);
}

async function deleteEntryFromDb(id) {
  await firestoreApi.deleteDoc(firestoreApi.doc(db, `users/${currentUid}/entries/${id}`));
}

async function importEntriesToDb(items) {
  const CHUNK_SIZE = 400;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const batch = firestoreApi.writeBatch(db);
    for (const item of chunk) {
      batch.set(firestoreApi.doc(entriesCollection(currentUid)), item);
    }
    await batch.commit();
  }
}

function budgetDocRef(uid) {
  return firestoreApi.doc(db, `users/${uid}/settings/budget`);
}

function subscribeBudget(uid) {
  if (unsubscribeBudget) unsubscribeBudget();
  unsubscribeBudget = firestoreApi.onSnapshot(
    budgetDocRef(uid),
    (snap) => {
      budgets = snap.exists() ? snap.data() : {};
      render();
    },
    (error) => {
      console.error(error);
      alert("予算の取得に失敗しました: " + error.message);
    }
  );
}

async function saveBudgetsToDb(newBudgets) {
  await firestoreApi.setDoc(budgetDocRef(currentUid), newBudgets);
}

function incomeBudgetDocRef(uid) {
  return firestoreApi.doc(db, `users/${uid}/settings/incomeBudget`);
}

function subscribeIncomeBudget(uid) {
  if (unsubscribeIncomeBudget) unsubscribeIncomeBudget();
  unsubscribeIncomeBudget = firestoreApi.onSnapshot(
    incomeBudgetDocRef(uid),
    (snap) => {
      incomeBudgets = snap.exists() ? snap.data() : {};
      render();
    },
    (error) => {
      console.error(error);
      alert("収入目標の取得に失敗しました: " + error.message);
    }
  );
}

async function saveIncomeBudgetsToDb(newBudgets) {
  await firestoreApi.setDoc(incomeBudgetDocRef(currentUid), newBudgets);
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function render() {
  el.currentMonth.textContent =
    viewMode === "year" ? `${currentMonth.getFullYear()}年` : formatMonth(currentMonth);

  const periodLabel = viewMode === "year" ? "今年" : "今月";
  el.budgetSectionTitle.textContent = `${periodLabel}の予算`;
  el.planActualSectionTitle.textContent = `${periodLabel}の予定と実績`;
  el.listSectionTitle.textContent = `${periodLabel}の記録`;

  renderCumulativeSavings();

  const targetMultiplier = viewMode === "year" ? 12 : 1;
  const entriesInPeriod = periodEntries();
  renderSummary(entriesInPeriod);
  renderMonthlyBarChart();
  const budgetTotals = renderBudget(entriesInPeriod, targetMultiplier);
  renderPlanActual(entriesInPeriod, targetMultiplier, budgetTotals);
  renderNeedWantSave(entriesInPeriod);
  renderList(entriesInPeriod);
}

// 縦軸の目盛り幅をキリの良い数値 (1, 2, 5 × 10^n) から選ぶ
const CHART_STEP_CANDIDATES = [
  1000, 2000, 5000,
  10000, 20000, 50000,
  100000, 200000, 500000,
  1000000, 2000000, 5000000,
];

function chartStepFor(max) {
  const minStep = max / 6;
  return (
    CHART_STEP_CANDIDATES.find((step) => step >= minStep) ||
    CHART_STEP_CANDIDATES[CHART_STEP_CANDIDATES.length - 1]
  );
}

// 年間表示のときだけ、月ごとの収入・支出を棒グラフで表示する
function renderMonthlyBarChart() {
  el.yearlyChartSection.classList.toggle("hidden", viewMode !== "year");
  if (viewMode !== "year") return;

  const year = currentMonth.getFullYear();
  const monthlyTotals = Array.from({ length: 12 }, () => ({ income: 0, expense: 0 }));
  for (const e of entriesForYear(currentMonth)) {
    if (e.type !== "income" && e.type !== "expense") continue;
    const month = Number(e.date.slice(5, 7)) - 1;
    monthlyTotals[month][e.type] += e.amount;
  }

  const dataMax = Math.max(0, ...monthlyTotals.flatMap((m) => [m.income, m.expense]));
  const step = chartStepFor(dataMax > 0 ? dataMax : 1);
  const chartMax = dataMax > 0 ? Math.ceil(dataMax / step) * step : step;
  const currentRealMonth =
    year === new Date().getFullYear() ? new Date().getMonth() : -1;

  el.monthlyBarYaxis.innerHTML = "";
  for (let value = chartMax; value >= 0; value -= step) {
    const label = document.createElement("span");
    label.className = "monthly-bar-yaxis-label";
    label.style.top = `${100 - (value / chartMax) * 100}%`;
    label.textContent = formatYen(value);
    el.monthlyBarYaxis.appendChild(label);
  }

  el.monthlyBarChart.innerHTML = "";
  monthlyTotals.forEach((totals, index) => {
    const group = document.createElement("div");
    group.className = "month-bar-group";

    const bars = document.createElement("div");
    bars.className = "month-bars";

    const incomeBar = document.createElement("div");
    incomeBar.className = "month-bar income";
    incomeBar.style.height = `${(totals.income / chartMax) * 100}%`;
    incomeBar.title = `${index + 1}月 収入 ${formatYen(totals.income)}`;

    const expenseBar = document.createElement("div");
    expenseBar.className = "month-bar expense";
    expenseBar.style.height = `${(totals.expense / chartMax) * 100}%`;
    expenseBar.title = `${index + 1}月 支出 ${formatYen(totals.expense)}`;

    bars.append(incomeBar, expenseBar);

    const label = document.createElement("div");
    label.className = "month-bar-label" + (index === currentRealMonth ? " current" : "");
    label.textContent = `${index + 1}月`;

    group.append(bars, label);
    el.monthlyBarChart.appendChild(group);
  });
}

function renderCumulativeSavings() {
  let total = 0;
  for (const e of entries) {
    if (e.type === "income") total += e.amount;
    else if (e.type === "expense") total -= e.amount;
    // "save" (貯蓄・投資) は現金が資産に形を変えただけなので加減算しない
  }
  el.cumulativeSavings.textContent = (total < 0 ? "-" : "") + formatYen(Math.abs(total));
  el.cumulativeSavings.classList.toggle("positive", total > 0);
  el.cumulativeSavings.classList.toggle("negative", total < 0);

  // 今月(実際のカレンダー上の今月)の貯蓄額と、累計貯金額に対する増減率
  let thisMonthNet = 0;
  for (const e of entriesForMonth(startOfMonth(new Date()))) {
    if (e.type === "income") thisMonthNet += e.amount;
    else if (e.type === "expense") thisMonthNet -= e.amount;
  }
  const previousTotal = total - thisMonthNet;

  const sign = thisMonthNet > 0 ? "+" : thisMonthNet < 0 ? "-" : "";
  let changeText = `今月の貯蓄額: ${sign}${formatYen(Math.abs(thisMonthNet))}`;
  if (previousTotal !== 0) {
    const rate = (thisMonthNet / Math.abs(previousTotal)) * 100;
    changeText += ` (${rate > 0 ? "+" : ""}${rate.toFixed(1)}%)`;
  }
  el.cumulativeChange.textContent = changeText;
  el.cumulativeChange.classList.toggle("positive", thisMonthNet > 0);
  el.cumulativeChange.classList.toggle("negative", thisMonthNet < 0);
}

function renderSummary(monthEntries) {
  let income = 0;
  let expense = 0;
  let saved = 0;
  for (const e of monthEntries) {
    if (e.type === "income") income += e.amount;
    else if (e.type === "save") saved += e.amount;
    else expense += e.amount;
  }
  const balance = income - expense;

  el.totalIncome.textContent = formatYen(income);
  el.totalExpense.textContent = formatYen(expense);
  el.balance.textContent = (balance < 0 ? "-" : "") + formatYen(Math.abs(balance));
  el.balance.classList.toggle("positive", balance > 0);
  el.balance.classList.toggle("negative", balance < 0);
  el.totalSave.textContent = formatYen(saved);
}

function budgetBarClass(ratio) {
  if (ratio >= 1) return "budget-bar over";
  if (ratio >= 0.8) return "budget-bar warning";
  return "budget-bar";
}

function renderBudget(monthEntries, targetMultiplier = 1) {
  const actuals = new Map();
  for (const e of monthEntries) {
    if (e.type !== "expense") continue;
    actuals.set(e.category, (actuals.get(e.category) || 0) + e.amount);
  }

  const budgetedCategories = Object.keys(budgets).filter((c) => budgets[c] > 0);
  const totalBudget = budgetedCategories.reduce((sum, c) => sum + budgets[c], 0) * targetMultiplier;
  const totalActual = [...actuals.values()].reduce((sum, v) => sum + v, 0);

  el.budgetOverall.innerHTML = "";
  if (totalBudget > 0) {
    const ratio = totalActual / totalBudget;
    const percent = Math.round(ratio * 100);

    const text = document.createElement("div");
    text.className = "budget-overall-text";
    const label = document.createElement("span");
    label.textContent = `${formatYen(totalActual)} / ${formatYen(totalBudget)}`;
    const percentEl = document.createElement("span");
    percentEl.className = "budget-percent";
    percentEl.textContent = `${percent}%`;
    text.append(label, percentEl);

    const track = document.createElement("div");
    track.className = "budget-bar-track";
    const bar = document.createElement("div");
    bar.className = budgetBarClass(ratio);
    bar.style.width = `${Math.min(ratio, 1) * 100}%`;
    track.appendChild(bar);

    el.budgetOverall.append(text, track);
  }

  // 予算が設定されているカテゴリを使用率の高い順に、
  // その後に予算未設定だが支出のあるカテゴリを金額順に表示する
  const rows = [
    ...budgetedCategories
      .map((category) => ({
        category,
        budget: budgets[category] * targetMultiplier,
        actual: actuals.get(category) || 0,
      }))
      .sort((a, b) => b.actual / b.budget - a.actual / a.budget),
    ...[...actuals.entries()]
      .filter(([category]) => !budgets[category])
      .map(([category, actual]) => ({ category, budget: 0, actual }))
      .sort((a, b) => b.actual - a.actual),
  ];

  el.budgetBreakdown.innerHTML = "";

  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = "予算が設定されていません";
    el.budgetBreakdown.appendChild(p);
    return { totalActual, totalBudget };
  }

  for (const { category, budget, actual } of rows) {
    const row = document.createElement("div");
    row.className = "budget-row";

    const name = createCategoryLabel(category);

    const percentText = document.createElement("span");
    percentText.className = "budget-percent-text";
    if (budget > 0) {
      const ratio = actual / budget;
      percentText.textContent = `${Math.round(ratio * 100)}%`;
      percentText.classList.toggle("over", ratio >= 1);
      percentText.classList.toggle("warning", ratio >= 0.8 && ratio < 1);
    } else {
      percentText.textContent = "―";
    }

    const amountText = document.createElement("span");
    amountText.className = "budget-amount-text";
    if (budget > 0) {
      amountText.textContent = `${formatYen(actual)} / ${formatYen(budget)}`;
      amountText.classList.toggle("over", actual > budget);
    } else {
      amountText.textContent = `${formatYen(actual)} (予算未設定)`;
    }

    row.append(name, percentText, amountText);
    el.budgetBreakdown.appendChild(row);
  }

  return { totalActual, totalBudget };
}

// ---------------------------------------------------------------------------
// 予定と実績 (支出は予算、収入は収入目標との比較)
// ---------------------------------------------------------------------------

function renderPlanActual(monthEntries, targetMultiplier, budgetTotals) {
  renderPlanActualChart(
    el.expensePlanActual,
    budgetTotals.totalBudget,
    budgetTotals.totalActual,
    "支出の予定が設定されていません(上の「予算を編集」から設定できます)",
    "expense"
  );

  const totalIncomeBudget = computeIncomeBudgetTotal(targetMultiplier);
  let totalIncomeActual = 0;
  for (const e of monthEntries) {
    if (e.type === "income") totalIncomeActual += e.amount;
  }

  renderPlanActualChart(
    el.incomePlanActual,
    totalIncomeBudget,
    totalIncomeActual,
    "収入の目標が設定されていません(「収入目標を編集」から設定できます)",
    "income"
  );

  renderBonusNote();
}

// 収入目標の合計を計算する。「賞与」は月額ではなく、ボーナス月に
// 給与の指定した月数分を上乗せする形で計算する
function computeIncomeBudgetTotal(targetMultiplier) {
  const baseCategories = CATEGORIES.income.filter((c) => c !== BONUS_CATEGORY);
  const baseMonthly = baseCategories.reduce((sum, c) => sum + (incomeBudgets[c] || 0), 0);

  const bonusMonths = Array.isArray(incomeBudgets.bonusMonths) ? incomeBudgets.bonusMonths : [];
  const bonusMultiplier = Number(incomeBudgets.bonusMultiplier) || 0;
  const bonusPerOccurrence = (incomeBudgets["給与"] || 0) * bonusMultiplier;

  if (targetMultiplier === 12) {
    // 年間表示: 月額×12 + ボーナス月数分のボーナス
    return baseMonthly * 12 + bonusPerOccurrence * bonusMonths.length;
  }
  // 月別表示: 月額 + (表示中の月がボーナス月ならその分を上乗せ)
  const isBonusMonth = bonusMonths.includes(currentMonth.getMonth() + 1);
  return baseMonthly + (isBonusMonth ? bonusPerOccurrence : 0);
}

function renderBonusNote() {
  const existing = el.incomePlanActual.parentElement.querySelector(".plan-actual-note");
  if (existing) existing.remove();

  const bonusMonths = Array.isArray(incomeBudgets.bonusMonths) ? incomeBudgets.bonusMonths : [];
  const bonusMultiplier = Number(incomeBudgets.bonusMultiplier) || 0;
  if (bonusMonths.length === 0 || bonusMultiplier <= 0) return;

  const note = document.createElement("p");
  note.className = "plan-actual-note";
  const monthsLabel = [...bonusMonths].sort((a, b) => a - b).map((m) => `${m}月`).join("・");
  note.textContent = `賞与: ${monthsLabel}に給与${bonusMultiplier}か月分を計上`;
  el.incomePlanActual.insertAdjacentElement("afterend", note);
}

function renderPlanActualChart(container, planned, actual, emptyMessage, kind) {
  container.innerHTML = "";

  if (planned <= 0) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = emptyMessage;
    container.appendChild(p);
    return;
  }

  const max = Math.max(planned, actual, 1);
  const planRow = buildPlanActualRow("予定", planned, max, "plan");
  const actualRow = buildPlanActualRow(
    "実績",
    actual,
    max,
    kind === "income" ? "actual-income" : "actual-expense"
  );
  container.append(planRow, actualRow);
}

function buildPlanActualRow(label, amount, max, barClass) {
  const row = document.createElement("div");
  row.className = "plan-actual-row";

  const labelEl = document.createElement("span");
  labelEl.className = "plan-actual-label";
  labelEl.textContent = label;

  const track = document.createElement("div");
  track.className = "budget-bar-track";
  const bar = document.createElement("div");
  bar.className = `budget-bar ${barClass}`;
  bar.style.width = `${Math.min(amount / max, 1) * 100}%`;
  track.appendChild(bar);

  const valueEl = document.createElement("span");
  valueEl.className = "plan-actual-value";
  valueEl.textContent = formatYen(amount);

  row.append(labelEl, track, valueEl);
  return row;
}

const NWS_SVG_NS = "http://www.w3.org/2000/svg";
const NWS_RADIUS = 50;
const NWS_STROKE_WIDTH = 90;
const NWS_CIRCUMFERENCE = 2 * Math.PI * NWS_RADIUS;
const NWS_COLORS = { ...NWS_BUCKET_COLORS, save: "#4caf50" };
const NWS_BG_COLORS = { need: "#bcd7fa", want: "#faedb0", save: "#c3e6c4" };
const NWS_LABELS = { need: "🏠 Need", want: "🛍️ Want", save: "🐷 Save" };
const NWS_CATEGORY_DESCRIPTIONS = {
  need: NEED_CATEGORIES.join("・"),
  want: WANT_CATEGORIES.join("・") + " など",
  save: "収入 − Need − Want (実際に残った金額)",
};

function nwsArc(offset, length, color) {
  const circle = document.createElementNS(NWS_SVG_NS, "circle");
  circle.setAttribute("cx", "100");
  circle.setAttribute("cy", "100");
  circle.setAttribute("r", String(NWS_RADIUS));
  circle.setAttribute("fill", "none");
  circle.setAttribute("stroke", color);
  circle.setAttribute("stroke-width", String(NWS_STROKE_WIDTH));
  circle.setAttribute(
    "stroke-dasharray",
    `${Math.max(length, 0)} ${NWS_CIRCUMFERENCE - Math.max(length, 0)}`
  );
  circle.setAttribute("stroke-dashoffset", String(-offset));
  return circle;
}

function renderNeedWantSave(monthEntries) {
  let totalIncome = 0;
  let needSpent = 0;
  let wantSpent = 0;
  for (const e of monthEntries) {
    if (e.type === "income") {
      totalIncome += e.amount;
    } else if (e.type === "save") {
      // 貯蓄・投資は使ったお金ではないので Need/Want に数えない。
      // Save実績 (income - need - want) には自然に残る形で反映される。
    } else if (NEED_CATEGORIES.includes(e.category)) {
      needSpent += e.amount;
    } else {
      wantSpent += e.amount;
    }
  }

  el.nwsChart.innerHTML = "";
  el.nwsLegend.innerHTML = "";

  if (totalIncome <= 0) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = `${viewMode === "year" ? "今年" : "今月"}の収入を登録すると表示されます`;
    el.nwsLegend.appendChild(p);
    return;
  }

  const saveAmount = totalIncome - needSpent - wantSpent;
  const buckets = [
    { key: "need", actual: needSpent, target: totalIncome * NWS_TARGET_RATIO.need },
    { key: "want", actual: wantSpent, target: totalIncome * NWS_TARGET_RATIO.want },
    { key: "save", actual: saveAmount, target: totalIncome * NWS_TARGET_RATIO.save },
  ];

  const group = document.createElementNS(NWS_SVG_NS, "g");
  group.setAttribute("transform", "rotate(-90 100 100)");

  let offset = 0;
  for (const bucket of buckets) {
    const segmentLength = NWS_CIRCUMFERENCE * NWS_TARGET_RATIO[bucket.key];
    group.appendChild(nwsArc(offset, segmentLength, NWS_BG_COLORS[bucket.key]));

    const ratio = bucket.target > 0 ? bucket.actual / bucket.target : 0;
    const isOver = bucket.key === "save" ? ratio < 0 : ratio > 1;
    const fillLength = segmentLength * Math.min(Math.max(ratio, 0), 1);
    const fillColor = isOver ? "#ef4444" : NWS_COLORS[bucket.key];
    group.appendChild(nwsArc(offset, fillLength, fillColor));

    bucket.ratio = ratio;
    bucket.isOver = isOver;
    offset += segmentLength;
  }
  el.nwsChart.appendChild(group);

  for (const bucket of buckets) {
    const item = document.createElement("div");
    item.className = "nws-legend-item";

    const main = document.createElement("div");
    main.className = "nws-legend-main";

    const swatch = document.createElement("span");
    swatch.className = "nws-swatch";
    swatch.style.background = bucket.isOver ? "#ef4444" : NWS_COLORS[bucket.key];

    const label = document.createElement("span");
    label.className = "nws-legend-label";
    label.textContent = `${NWS_LABELS[bucket.key]} ${Math.round(NWS_TARGET_RATIO[bucket.key] * 100)}%`;

    const detail = document.createElement("span");
    detail.className = "nws-legend-detail";
    detail.classList.toggle("over", bucket.isOver);
    const percent = Math.round(bucket.ratio * 100);
    detail.textContent = `${formatYen(Math.round(bucket.actual))} / ${formatYen(Math.round(bucket.target))} (${percent}%)`;

    main.append(swatch, label, detail);

    const categories = document.createElement("div");
    categories.className = "nws-legend-categories";
    categories.textContent = NWS_CATEGORY_DESCRIPTIONS[bucket.key];

    item.append(main, categories);
    el.nwsLegend.appendChild(item);
  }
}

function createCategoryLabel(category) {
  const wrap = document.createElement("span");
  wrap.className = "category-label";

  const dot = document.createElement("span");
  dot.className = "category-dot";
  dot.style.background = NWS_BUCKET_COLORS[categoryBucket(category)];
  dot.title = categoryBucket(category) === "need" ? "Need" : "Want";

  const text = document.createElement("span");
  text.textContent = category;

  wrap.append(dot, text);
  return wrap;
}

function sortEntries(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    let cmp;
    switch (sortColumn) {
      case "type":
        cmp = TYPE_LABELS[a.type].localeCompare(TYPE_LABELS[b.type], "ja");
        break;
      case "category":
        cmp = a.category.localeCompare(b.category, "ja");
        break;
      case "amount":
        cmp = a.amount - b.amount;
        break;
      case "date":
      default:
        cmp = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
        break;
    }
    return sortDirection === "asc" ? cmp : -cmp;
  });
  return sorted;
}

function updateSortIndicators() {
  document.querySelectorAll(".entry-table th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortColumn) {
      th.classList.add(sortDirection === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

function handleSortClick(column) {
  if (sortColumn === column) {
    sortDirection = sortDirection === "asc" ? "desc" : "asc";
  } else {
    sortColumn = column;
    sortDirection = SORT_DEFAULT_DIRECTION[column] || "asc";
  }
  render();
}

function applyFilters(list) {
  return list.filter((e) => {
    if (filterType !== "all" && e.type !== filterType) return false;
    if (filterCategory !== "all" && e.category !== filterCategory) return false;
    return true;
  });
}

function renderFilterCategoryOptions() {
  const categoryLists =
    filterType === "all"
      ? [...CATEGORIES.expense, ...CATEGORIES.income, ...CATEGORIES.save]
      : CATEGORIES[filterType];
  const uniqueCategories = [...new Set(categoryLists)];

  const previousValue = filterCategory;
  el.filterCategory.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "すべてのカテゴリ";
  el.filterCategory.appendChild(allOption);
  for (const category of uniqueCategories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    el.filterCategory.appendChild(option);
  }

  // 以前選んでいたカテゴリが引き続き選択肢にあれば維持する
  filterCategory = uniqueCategories.includes(previousValue) ? previousValue : "all";
  el.filterCategory.value = filterCategory;
}

function renderList(monthEntries) {
  const filtered = applyFilters(monthEntries);
  const isFiltered = filterType !== "all" || filterCategory !== "all";

  el.entryList.innerHTML = "";
  el.listEmptyMessage.classList.toggle("hidden", filtered.length > 0);

  const periodLabel = viewMode === "year" ? "今年" : "今月";
  el.listEmptyMessage.textContent =
    monthEntries.length === 0 && !isFiltered
      ? `${periodLabel}の記録はまだありません。上のフォームから追加してください。`
      : "条件に一致する記録がありません。";
  updateSortIndicators();

  for (const entry of sortEntries(filtered)) {
    const tr = document.createElement("tr");

    const dateTd = document.createElement("td");
    const [, m, d] = entry.date.split("-");
    dateTd.textContent = `${Number(m)}/${Number(d)}`;

    const typeTd = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `type-badge ${entry.type}`;
    badge.textContent = TYPE_LABELS[entry.type];
    typeTd.appendChild(badge);

    const categoryTd = document.createElement("td");
    categoryTd.textContent = entry.category;

    const amountTd = document.createElement("td");
    amountTd.className = `amount-cell ${entry.type}`;
    amountTd.textContent =
      (entry.type === "income" ? "+" : "-") + formatYen(entry.amount);

    const memoTd = document.createElement("td");
    memoTd.className = "memo-cell";
    memoTd.textContent = entry.memo || "";

    const actionsTd = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";

    let detailRow = null;
    if (entry.payslip) {
      detailRow = buildPayslipDetailRow(entry);
      const detailBtn = document.createElement("button");
      detailBtn.className = "icon-btn";
      detailBtn.textContent = "内訳";
      detailBtn.addEventListener("click", () => detailRow.classList.toggle("hidden"));
      actions.appendChild(detailBtn);
    }

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", () => startEdit(entry.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn delete";
    deleteBtn.textContent = "削除";
    deleteBtn.addEventListener("click", () => deleteEntry(entry.id));

    actions.append(editBtn, deleteBtn);
    actionsTd.appendChild(actions);

    tr.append(dateTd, typeTd, categoryTd, amountTd, memoTd, actionsTd);
    el.entryList.appendChild(tr);
    if (detailRow) el.entryList.appendChild(detailRow);
  }
}

// 給与明細の内訳を表示する行 (「内訳」ボタンで開閉)
function buildPayslipDetailRow(entry) {
  const p = entry.payslip;
  const row = document.createElement("tr");
  row.className = "payslip-detail-row hidden";

  const td = document.createElement("td");
  td.colSpan = 6;

  let parts;
  if (p.baseSalary !== undefined) {
    const gross = PAYSLIP_EARNING_FIELDS.reduce((sum, field) => sum + (p[field] || 0), 0);
    const deductions = PAYSLIP_DEDUCTION_FIELDS.reduce((sum, field) => sum + (p[field] || 0), 0);
    parts = [
      `本給 ${formatYen(p.baseSalary || 0)}`,
      `通勤手当 ${formatYen(p.commute || 0)}`,
      `時間外勤務手当 ${formatYen(p.overtimePay || 0)}`,
      `支給合計 ${formatYen(gross)}`,
      `健康保険 ${formatYen(p.healthInsurance || 0)}`,
      `介護保険 ${formatYen(p.nursingInsurance || 0)}`,
      `厚生年金 ${formatYen(p.pensionInsurance || 0)}`,
      `雇用保険料 ${formatYen(p.employmentInsurance || 0)}`,
      `所得税 ${formatYen(p.incomeTax || 0)}`,
      `住民税 ${formatYen(p.residentTax || 0)}`,
      `その他控除 ${formatYen(p.otherDeductions || 0)}`,
      `控除合計 ${formatYen(deductions)}`,
      `手取り ${formatYen(entry.amount)}`,
    ];
  } else {
    // 旧形式(総支給額・社会保険料まとめ)で保存された記録との互換表示
    parts = [`総支給額 ${formatYen(p.gross || 0)}`];
    if (p.commute) parts.push(`うち交通費 ${formatYen(p.commute)}`);
    parts.push(`所得税 ${formatYen(p.incomeTax || 0)}`);
    parts.push(`住民税 ${formatYen(p.residentTax || 0)}`);
    parts.push(`社会保険料 ${formatYen(p.socialInsurance || 0)}`);
    parts.push(`手取り ${formatYen(entry.amount)}`);
  }
  td.textContent = parts.join(" / ");

  row.appendChild(td);
  return row;
}

function renderCategoryOptions(type, selected) {
  el.entryCategory.innerHTML = "";
  for (const category of CATEGORIES[type]) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    if (category === selected) option.selected = true;
    el.entryCategory.appendChild(option);
  }
}

// ---------------------------------------------------------------------------
// 給与明細の内訳 (支給の内訳・控除の内訳 -> 手取りを自動計算)
// ---------------------------------------------------------------------------

function payslipInputEl(field) {
  return {
    baseSalary: el.payslipBaseSalary,
    commute: el.payslipCommute,
    overtimePay: el.payslipOvertimePay,
    healthInsurance: el.payslipHealthInsurance,
    nursingInsurance: el.payslipNursingInsurance,
    pensionInsurance: el.payslipPensionInsurance,
    employmentInsurance: el.payslipEmploymentInsurance,
    incomeTax: el.payslipIncomeTax,
    residentTax: el.payslipResidentTax,
    otherDeductions: el.payslipOtherDeductions,
  }[field];
}

function payslipFieldValue(field) {
  return Math.floor(Number(payslipInputEl(field).value)) || 0;
}

function computePayslipTotals() {
  const gross = PAYSLIP_EARNING_FIELDS.reduce((sum, field) => sum + payslipFieldValue(field), 0);
  const deductions = PAYSLIP_DEDUCTION_FIELDS.reduce(
    (sum, field) => sum + payslipFieldValue(field),
    0
  );
  return { gross, deductions, net: Math.max(0, gross - deductions) };
}

function updatePayslipPreview() {
  const { gross, deductions, net } = computePayslipTotals();
  el.payslipGrossValue.textContent = formatYen(gross);
  el.payslipDeductionValue.textContent = formatYen(deductions);
  el.payslipNetValue.textContent = formatYen(net);
  el.entryAmount.value = net;
}

function openPayslipBreakdown() {
  el.payslipBreakdown.classList.remove("hidden");
  el.payslipToggleBtn.classList.add("hidden");
  el.entryAmount.readOnly = true;
  updatePayslipPreview();
}

function closePayslipBreakdown({ clearValues = true } = {}) {
  el.payslipBreakdown.classList.add("hidden");
  el.payslipToggleBtn.classList.remove("hidden");
  el.entryAmount.readOnly = false;
  if (clearValues) {
    for (const field of PAYSLIP_FIELDS) payslipInputEl(field).value = "";
  }
}

// 種別が「収入」・カテゴリが「給与」のときだけ内訳入力欄を出す
function updatePayslipVisibility() {
  const isSalary = selectedType() === "income" && el.entryCategory.value === PAYSLIP_CATEGORY;
  el.payslipSection.classList.toggle("hidden", !isSalary);
  if (!isSalary) closePayslipBreakdown();
}

// 内訳が入力されていれば {gross, commute, incomeTax, residentTax, socialInsurance} を、
// 入力されていなければ null を返す
function buildPayslipData() {
  if (el.payslipBreakdown.classList.contains("hidden")) return null;
  const payslip = {};
  for (const field of PAYSLIP_FIELDS) {
    payslip[field] = payslipFieldValue(field);
  }
  const gross = PAYSLIP_EARNING_FIELDS.reduce((sum, field) => sum + payslip[field], 0);
  return gross > 0 ? payslip : null;
}

// ---------------------------------------------------------------------------
// 予算編集フォーム
// ---------------------------------------------------------------------------

function renderBudgetInputs() {
  el.budgetInputs.innerHTML = "";
  for (const category of CATEGORIES.expense) {
    const group = document.createElement("div");
    group.className = "form-group";

    const label = document.createElement("label");
    label.htmlFor = `budget-input-${category}`;
    const dot = document.createElement("span");
    dot.className = "category-dot";
    dot.style.background = NWS_BUCKET_COLORS[categoryBucket(category)];
    label.append(dot, document.createTextNode(category));

    const input = document.createElement("input");
    input.type = "number";
    input.id = `budget-input-${category}`;
    input.dataset.category = category;
    input.min = "0";
    input.step = "1";
    input.placeholder = "0";
    if (budgets[category] > 0) input.value = budgets[category];

    group.append(label, input);
    el.budgetInputs.appendChild(group);
  }
}

function openBudgetForm() {
  renderBudgetInputs();
  el.budgetForm.classList.remove("hidden");
  el.budgetForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeBudgetForm() {
  el.budgetForm.classList.add("hidden");
}

async function handleBudgetSubmit(event) {
  event.preventDefault();

  const newBudgets = {};
  for (const input of el.budgetInputs.querySelectorAll("input[data-category]")) {
    const amount = Math.floor(Number(input.value));
    if (Number.isFinite(amount) && amount > 0) {
      newBudgets[input.dataset.category] = amount;
    }
  }

  try {
    await saveBudgetsToDb(newBudgets);
  } catch (err) {
    alert("予算の保存に失敗しました: " + err.message);
    return;
  }
  closeBudgetForm();
}

function renderIncomeBudgetInputs() {
  el.incomeBudgetInputs.innerHTML = "";
  // 賞与は月額ではなく、下のボーナス設定 (月・給与の何か月分か) で計算するため除外
  for (const category of CATEGORIES.income.filter((c) => c !== BONUS_CATEGORY)) {
    const group = document.createElement("div");
    group.className = "form-group";

    const label = document.createElement("label");
    label.htmlFor = `income-budget-input-${category}`;
    label.textContent = category;

    const input = document.createElement("input");
    input.type = "number";
    input.id = `income-budget-input-${category}`;
    input.dataset.category = category;
    input.min = "0";
    input.step = "1";
    input.placeholder = "0";
    if (incomeBudgets[category] > 0) input.value = incomeBudgets[category];

    group.append(label, input);
    el.incomeBudgetInputs.appendChild(group);
  }
}

function renderBonusSettingsInputs() {
  const savedMonths = Array.isArray(incomeBudgets.bonusMonths) ? incomeBudgets.bonusMonths : [];

  el.bonusMonthGrid.innerHTML = "";
  for (let month = 1; month <= 12; month++) {
    const label = document.createElement("label");
    label.className = "bonus-month-checkbox";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.month = month;
    checkbox.checked = savedMonths.includes(month);

    label.append(checkbox, document.createTextNode(`${month}月`));
    el.bonusMonthGrid.appendChild(label);
  }

  el.bonusMultiplierInput.value = incomeBudgets.bonusMultiplier > 0 ? incomeBudgets.bonusMultiplier : "";
}

function openIncomeBudgetForm() {
  renderIncomeBudgetInputs();
  renderBonusSettingsInputs();
  el.incomeBudgetForm.classList.remove("hidden");
  el.incomeBudgetForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeIncomeBudgetForm() {
  el.incomeBudgetForm.classList.add("hidden");
}

async function handleIncomeBudgetSubmit(event) {
  event.preventDefault();

  const newIncomeBudgets = {};
  for (const input of el.incomeBudgetInputs.querySelectorAll("input[data-category]")) {
    const amount = Math.floor(Number(input.value));
    if (Number.isFinite(amount) && amount > 0) {
      newIncomeBudgets[input.dataset.category] = amount;
    }
  }

  const bonusMonths = [...el.bonusMonthGrid.querySelectorAll("input[type=checkbox]:checked")].map(
    (cb) => Number(cb.dataset.month)
  );
  if (bonusMonths.length > 0) newIncomeBudgets.bonusMonths = bonusMonths;
  const bonusMultiplier = Number(el.bonusMultiplierInput.value);
  if (Number.isFinite(bonusMultiplier) && bonusMultiplier > 0) {
    newIncomeBudgets.bonusMultiplier = bonusMultiplier;
  }

  try {
    await saveIncomeBudgetsToDb(newIncomeBudgets);
  } catch (err) {
    alert("収入目標の保存に失敗しました: " + err.message);
    return;
  }
  closeIncomeBudgetForm();
}

// ---------------------------------------------------------------------------
// フォーム操作
// ---------------------------------------------------------------------------

function resetForm() {
  el.entryId.value = "";
  el.form.reset();
  el.entryDate.value = toDateInputValue(new Date());
  renderCategoryOptions("expense");
  updatePayslipVisibility();
  el.formTitle.textContent = "記録を追加";
  el.submitBtn.textContent = "追加";
  el.cancelEditBtn.classList.add("hidden");
}

function startEdit(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  el.entryId.value = entry.id;
  el.entryDate.value = entry.date;
  document.querySelector(
    `input[name="entry-type"][value="${entry.type}"]`
  ).checked = true;
  renderCategoryOptions(entry.type, entry.category);
  el.entryAmount.value = entry.amount;
  el.entryMemo.value = entry.memo || "";

  updatePayslipVisibility();
  if (entry.payslip) {
    for (const field of PAYSLIP_FIELDS) {
      payslipInputEl(field).value = entry.payslip[field] || "";
    }
    openPayslipBreakdown();
    el.entryAmount.value = entry.amount;
  }

  el.formTitle.textContent = "記録を編集";
  el.submitBtn.textContent = "更新";
  el.cancelEditBtn.classList.remove("hidden");
  el.form.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function deleteEntry(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  const label = `${entry.date} ${entry.category} ${formatYen(entry.amount)}`;
  if (!confirm(`この記録を削除しますか?\n${label}`)) return;

  try {
    await deleteEntryFromDb(id);
  } catch (err) {
    alert("削除に失敗しました: " + err.message);
    return;
  }
  if (el.entryId.value === id) resetForm();
}

async function handleSubmit(event) {
  event.preventDefault();

  const amount = Math.floor(Number(el.entryAmount.value));
  if (!Number.isFinite(amount) || amount <= 0) {
    alert("金額は1以上の数値で入力してください。");
    return;
  }

  const data = {
    date: el.entryDate.value,
    type: selectedType(),
    category: el.entryCategory.value,
    amount,
    memo: el.entryMemo.value.trim(),
    payslip: buildPayslipData(),
  };

  const editingId = el.entryId.value;
  el.submitBtn.disabled = true;
  try {
    if (editingId) {
      await updateEntryInDb(editingId, data);
    } else {
      await addEntryToDb(data);
    }
  } catch (err) {
    alert("保存に失敗しました: " + err.message);
    return;
  } finally {
    el.submitBtn.disabled = false;
  }

  resetForm();

  // 追加・更新した記録の月を表示する
  currentMonth = startOfMonth(new Date(data.date + "T00:00:00"));
  render();
}

// ---------------------------------------------------------------------------
// CSV エクスポート / インポート
// ---------------------------------------------------------------------------

const CSV_HEADER = ["日付", "種別", "カテゴリ", "金額", "メモ"];

function csvEscape(value) {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function exportCsv() {
  if (entries.length === 0) {
    alert("エクスポートする記録がありません。");
    return;
  }

  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1));
  const lines = [CSV_HEADER.join(",")];
  for (const e of sorted) {
    lines.push(
      [
        e.date,
        TYPE_LABELS[e.type],
        csvEscape(e.category),
        e.amount,
        csvEscape(e.memo || ""),
      ].join(",")
    );
  }

  // BOM 付き UTF-8 (Excel で文字化けしないように)
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kakeibo_${toDateInputValue(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * シンプルな CSV パーサ (ダブルクォート・改行入りフィールド対応)
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * 日付文字列を YYYY-MM-DD に正規化する。
 * 対応形式: 2026-07-20 / 2026/7/20 / 2026.7.20 / 2026年7月20日 / 26/7/20 (2桁年)
 */
function normalizeDate(value) {
  const m = String(value)
    .trim()
    .match(/^(\d{2}|\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) return null;
  let [, y, mo, d] = m;
  if (y.length === 2) y = "20" + y;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(mo) - 1 ||
    date.getDate() !== Number(d)
  ) {
    return null;
  }
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function parseType(value) {
  const s = String(value).trim().toLowerCase();
  if (s === "収入" || s === "income") return "income";
  if (s === "支出" || s === "expense") return "expense";
  if (s === "貯蓄" || s === "save" || s === "投資" || s === "invest") return "save";
  return null;
}

function parseCsvAmount(value) {
  return Math.floor(Number(String(value ?? "").replace(/[,¥\s]/g, "")));
}

// スプレッドシートのカテゴリ名 -> アプリのカテゴリ名。
// 完全一致しない場合はこの表で読み替え、それでも見つからなければ
// 「その他支出」「その他収入」に分類する (取り込み自体は諦めない)。
const CATEGORY_ALIASES = {
  expense: {
    "水道光熱費": "水道・光熱",
    "通信費": "通信",
    "住居費": "住居",
    "交通費": "交通",
    "その他": "その他支出",
    "医療費": "医療",
    "教育費": "教育",
    "学費": "教育",
    "娯楽費": "趣味・娯楽",
    "趣味": "趣味・娯楽",
    "美容費": "衣服・美容",
    "衣服費": "衣服・美容",
    "サブスクリプション": "その他支出",
    "サブスク": "その他支出",
  },
  income: {
    "給料": "給与",
    "ボーナス": "賞与",
    "利息": "副収入",
    "その他": "その他収入",
    "仕送り": "その他収入",
    "貯蓄": "その他収入",
  },
};

function resolveCategory(rawCategory, type) {
  const trimmed = String(rawCategory ?? "").trim();
  if (CATEGORIES[type].includes(trimmed)) return trimmed;
  const alias = CATEGORY_ALIASES[type][trimmed];
  if (alias) return alias;
  return type === "expense" ? "その他支出" : "その他収入";
}

/**
 * 「日付,種別,カテゴリ,金額,メモ」の縦持ち形式 (エクスポート形式と同じ) を解析する。
 */
function parseSimpleFormat(rows) {
  let start = 0;
  if (normalizeDate(rows[0][0]) === null) start = 1; // 先頭行がヘッダーならスキップ

  const imported = [];
  const errors = [];

  for (let i = start; i < rows.length; i++) {
    const cols = rows[i];
    const lineNo = i + 1;
    const date = normalizeDate(cols[0] ?? "");
    const type = parseType(cols[1] ?? "");
    const category = String(cols[2] ?? "").trim();
    const amount = parseCsvAmount(cols[3]);
    const memo = String(cols[4] ?? "").trim();

    if (!date) {
      errors.push(`${lineNo}行目: 日付を認識できません (${cols[0] ?? ""})`);
      continue;
    }
    if (!type) {
      errors.push(
        `${lineNo}行目: 種別は「収入」か「支出」で指定してください (${cols[1] ?? ""})`
      );
      continue;
    }
    if (!category) {
      errors.push(`${lineNo}行目: カテゴリが空です`);
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`${lineNo}行目: 金額を認識できません (${cols[3] ?? ""})`);
      continue;
    }

    imported.push({ date, type, category, amount, memo });
  }

  return { imported, errors };
}

function isWideFormatHeaderRow(cols) {
  return (
    String(cols[1] ?? "").trim() === "日付" &&
    String(cols[2] ?? "").trim() === "金額" &&
    String(cols[3] ?? "").trim() === "説明" &&
    String(cols[4] ?? "").trim() === "カテゴリ"
  );
}

/**
 * 「概要」スプレッドシートの [取引] タブをそのままエクスポートした形式を解析する。
 * 支出の表 (列1-4: 日付,金額,説明,カテゴリ) と収入の表 (列6-9: 同じ並び) が
 * 左右に並んでおり、どちらの表にも属さない解説行・空行が混在する。
 * この形式のヘッダー行が見つからない場合は null を返す。
 */
function parseWideFormat(rows) {
  const headerIndex = rows.findIndex(isWideFormatHeaderRow);
  if (headerIndex === -1) return null;

  const imported = [];
  const errors = [];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cols = rows[i];
    const lineNo = i + 1;

    const expenseDateRaw = String(cols[1] ?? "").trim();
    if (expenseDateRaw) {
      const date = normalizeDate(expenseDateRaw);
      const amount = parseCsvAmount(cols[2]);
      if (!date) {
        errors.push(`${lineNo}行目 (支出): 日付を認識できません (${expenseDateRaw})`);
      } else if (!Number.isFinite(amount) || amount <= 0) {
        errors.push(`${lineNo}行目 (支出): 金額を認識できません (${cols[2] ?? ""})`);
      } else {
        imported.push({
          date,
          type: "expense",
          category: resolveCategory(cols[4], "expense"),
          amount,
          memo: String(cols[3] ?? "").trim(),
        });
      }
    }

    const incomeDateRaw = String(cols[6] ?? "").trim();
    if (incomeDateRaw) {
      const date = normalizeDate(incomeDateRaw);
      const amount = parseCsvAmount(cols[7]);
      if (!date) {
        errors.push(`${lineNo}行目 (収入): 日付を認識できません (${incomeDateRaw})`);
      } else if (!Number.isFinite(amount) || amount <= 0) {
        errors.push(`${lineNo}行目 (収入): 金額を認識できません (${cols[7] ?? ""})`);
      } else {
        imported.push({
          date,
          type: "income",
          category: resolveCategory(cols[9], "income"),
          amount,
          memo: String(cols[8] ?? "").trim(),
        });
      }
    }
  }

  return { imported, errors };
}

// 先頭行が「氏名,マスクされたカード番号,カードブランド」の形式かどうかで、
// カード会社サイト (Vpassなど) からダウンロードした利用履歴CSVを判定する。
// 例: 山田　太郎　様,1234-56**-****-****,Ｏｌｉｖｅ／クレジット
function isCardUsageHeaderRow(cols) {
  return /^\d{4}-\d{2}\*+-\*+-\*+$/.test(String(cols[1] ?? "").trim());
}

/**
 * クレジットカードサイトからダウンロードした利用履歴CSVを解析する。
 * 各行は「利用日,利用先,利用金額,支払回数,今回回数,今回支払金額,備考」の形式。
 * 日付が空の行は、末尾の合計行(例: ,,,,,131507,)であることが多いため、
 * そこに記載された合計金額を expectedTotal として取り出し、取り込んだ金額の
 * 合計と突き合わせて正しく読み取れたかを確認できるようにする。
 */
function parseCardUsageFormat(rows) {
  if (!isCardUsageHeaderRow(rows[0])) return null;

  const imported = [];
  const errors = [];
  let expectedTotal = null;

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const lineNo = i + 1;
    const dateRaw = String(cols[0] ?? "").trim();
    if (!dateRaw) {
      const totalCandidate = parseCsvAmount(cols[5]);
      if (Number.isFinite(totalCandidate) && totalCandidate > 0) expectedTotal = totalCandidate;
      continue;
    }

    const date = normalizeDate(dateRaw);
    const merchant = String(cols[1] ?? "").trim();
    const amount = parseCsvAmount(cols[2]);

    if (!date) {
      errors.push(`${lineNo}行目: 日付を認識できません (${dateRaw})`);
      continue;
    }
    if (!merchant) {
      errors.push(`${lineNo}行目: 利用先が空です`);
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`${lineNo}行目: 金額を認識できません (${cols[2] ?? ""})`);
      continue;
    }

    imported.push({
      date,
      type: "expense",
      category: guessCategoryFromMerchant(merchant),
      amount,
      memo: merchant,
    });
  }

  return { imported, errors, expectedTotal };
}

// 取り込み対象のうち、既存の記録と (日付・種別・カテゴリ・金額・メモ) が
// 完全一致するものを重複とみなしてスキップする。同じCSVを誤って2回読み込んだ
// 場合などに二重登録されるのを防ぐ。件数ベースで比較するため、同じ内容の取引が
// 本当に複数回あった場合(同日同額の別々の買い物など)は正しく残す。
function dedupeAgainstExisting(imported) {
  const existingCounts = new Map();
  for (const e of entries) {
    const key = [e.date, e.type, e.category, e.amount, e.memo || ""].join(" ");
    existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
  }

  const deduped = [];
  let skippedCount = 0;
  for (const item of imported) {
    const key = [item.date, item.type, item.category, item.amount, item.memo || ""].join(" ");
    const remaining = existingCounts.get(key) || 0;
    if (remaining > 0) {
      existingCounts.set(key, remaining - 1);
      skippedCount++;
    } else {
      deduped.push(item);
    }
  }
  return { deduped, skippedCount };
}

// UTF-8として不正な文字が含まれる場合は Shift_JIS (カード利用履歴CSVでよく使われる)
// として読み直す。BOM付きUTF-8やUTF-8のみのCSV(自分でエクスポートしたものなど)は
// そのまま使われる。
function decodeCsvBuffer(buffer) {
  const utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (!utf8Text.includes("�")) return utf8Text.replace(/^﻿/, "");
  return new TextDecoder("shift_jis").decode(buffer);
}

function importCsv(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const text = decodeCsvBuffer(reader.result);
    const rows = parseCsv(text).filter(
      (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== "")
    );

    if (rows.length === 0) {
      alert("CSVにデータがありません。");
      return;
    }

    const { imported, errors, expectedTotal } =
      parseWideFormat(rows) || parseCardUsageFormat(rows) || parseSimpleFormat(rows);

    if (imported.length === 0) {
      alert("インポートできる行がありませんでした。\n\n" + errors.slice(0, 10).join("\n"));
      return;
    }

    // CSVに記載された合計金額(カード利用履歴CSVの末尾行など)と、実際に読み取れた
    // 金額の合計を突き合わせ、正しく取り込めているかを確認する
    let verificationNote = "";
    if (expectedTotal != null) {
      const parsedTotal = imported.reduce((sum, e) => sum + e.amount, 0);
      verificationNote =
        parsedTotal === expectedTotal
          ? `\n\n✓ CSV記載の合計金額(${formatYen(expectedTotal)})と一致しました。`
          : `\n\n⚠️ CSV記載の合計金額(${formatYen(expectedTotal)})と読み取れた金額の合計(${formatYen(
              parsedTotal
            )})が一致しません。一部の行が正しく取り込めていない可能性があります。`;
    }

    const { deduped, skippedCount } = dedupeAgainstExisting(imported);

    if (deduped.length === 0) {
      alert(
        `すべて(${skippedCount}件)既に登録済みのため、新しく追加する記録はありませんでした。` +
          verificationNote
      );
      return;
    }

    let message = `${deduped.length}件の記録をインポートします。よろしいですか?`;
    if (skippedCount > 0) {
      message += `\n\n(${skippedCount}件は既に登録済みのためスキップされます)`;
    }
    if (errors.length > 0) {
      message += `\n\n(${errors.length}件の行はスキップされます)\n` + errors.slice(0, 5).join("\n");
    }
    message += verificationNote;
    if (!confirm(message)) return;

    try {
      await importEntriesToDb(deduped);
    } catch (err) {
      alert("インポートに失敗しました: " + err.message);
      return;
    }
    alert(`${deduped.length}件をインポートしました。`);
  };
  reader.onerror = () => alert("ファイルの読み込みに失敗しました。");
  reader.readAsArrayBuffer(file);
}

// ---------------------------------------------------------------------------
// Gmail 連携 (メールからの読み込み)
// ---------------------------------------------------------------------------

const GMAIL_QUERY = 'from:statement@vpass.ne.jp subject:"ご利用のお知らせ" newer_than:60d';

// お店の名前からカテゴリを推測する。Suica/PASMO等の交通系は確実、それ以外は
// よくある業態のキーワードで大まかに振り分け、当てはまらなければ「その他支出」。
const MERCHANT_CATEGORY_RULES = [
  {
    category: "交通",
    pattern: /Ｓｕｉｃａ|Suica|ＰＡＳＭＯ|PASMO|ＪＲ|(?:^|[^A-Za-z])JR(?:[^A-Za-z]|$)|地下鉄|バス|タクシー|ＥＴＣ|ICOCA|みどりの窓口|東京メトロ|モノレール/i,
  },
  {
    category: "食費",
    // 「フアミリ―マ―ト」のようにカード会社のCSVでは小さい「ァ」や長音記号「ー」が
    // 通常サイズの文字やダッシュに置き換わっていることがあるため、それも拾えるように
    // 「フアミリ」で判定する
    pattern: /ファミリーマート|フアミリ|セブン|ローソン|ミニストップ|デイリーヤマザキ|ニューデイズ|キオスク|コンビニ|スーパー|イオン|やまか|西友|マルエツ|東急ストア|ライフ|カフェ|スターバックス|ドトール|ベックス|コージーコーナー|カルディ|珈琲|マクドナルド|吉野家|すき家|松屋|ラーメン|餃子|食堂|レストラン|居酒屋|もんじゃ|大戸屋|ピザ|寿司/i,
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
    pattern: /ユニクロ|UNIQLO|ＧＵ|美容室|ヘアサロン|理容/i,
  },
];

// 全角英数字・全角スペースを半角に変換する。カード利用履歴CSVでは
// 「ＢＯＯＴＨ」「ＧＯＯＧＬＥ　ＰＬＡＹ　ＪＡＰＡＮ」のように国内加盟店名が
// 全角化されていることが多く、半角前提のカテゴリ判定パターンに掛からないため。
function toHalfWidthAscii(text) {
  return text
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

function guessCategoryFromMerchant(merchant) {
  const normalized = toHalfWidthAscii(merchant);
  for (const rule of MERCHANT_CATEGORY_RULES) {
    if (rule.pattern.test(normalized)) return rule.category;
  }
  return "その他支出";
}

function decodeBase64Url(data) {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function findPlainTextPart(payload) {
  if (!payload) return null;
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = findPlainTextPart(part);
    if (found) return found;
  }
  return null;
}

/**
 * Vpass「ご利用のお知らせ」メールの本文から利用明細を1件抽出する。
 * 解析できなければ null を返す。
 */
function parseVpassEmail(text) {
  const dateMatch = text.match(/◇利用日[:：]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const merchantMatch = text.match(/◇利用先[:：]\s*(.+)/);
  const amountMatch = text.match(/◇利用金額[:：]\s*([\d,]+)円/);
  if (!dateMatch || !merchantMatch || !amountMatch) return null;

  const [, y, mo, d] = dateMatch;
  const amount = Number(amountMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const merchant = merchantMatch[1].trim();
  if (!merchant) return null;

  return {
    date: `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`,
    type: "expense",
    category: guessCategoryFromMerchant(merchant),
    amount,
    memo: merchant,
  };
}

async function gmailApiFetch(path, params) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${gmailAccessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail APIエラー (${res.status})`);
  }
  return res.json();
}

function gmailImportDocRef() {
  return firestoreApi.doc(db, `users/${currentUid}/settings/gmailImport`);
}

async function getImportedGmailIds() {
  const snap = await firestoreApi.getDoc(gmailImportDocRef());
  return snap.exists() ? snap.data().importedIds || [] : [];
}

async function markGmailIdsImported(ids) {
  if (ids.length === 0) return;
  try {
    await firestoreApi.updateDoc(gmailImportDocRef(), {
      importedIds: firestoreApi.arrayUnion(...ids),
    });
  } catch {
    // 初回はドキュメントがまだ存在しない
    await firestoreApi.setDoc(gmailImportDocRef(), { importedIds: ids });
  }
}

function requestGmailAccessToken() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error("Googleの認証ライブラリを読み込めませんでした。"));
      return;
    }
    if (!googleTokenClient) {
      googleTokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: googleClientId,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        callback: (response) => {
          if (response.error) {
            reject(new Error(response.error));
            return;
          }
          gmailAccessToken = response.access_token;
          resolve(gmailAccessToken);
        },
        error_callback: (err) => reject(new Error(err.type || "認証に失敗しました")),
      });
    }
    googleTokenClient.requestAccessToken({ prompt: gmailAccessToken ? "" : "consent" });
  });
}

async function importFromGmail() {
  if (!googleClientId) {
    alert(
      "メールからの読み込み機能を使うには設定が必要です。\n\n" +
        "js/google-config.example.js をコピーして js/google-config.js を作成し、" +
        "README.md の「メールからの読み込み機能のセットアップ」の手順に沿って設定してください。"
    );
    return;
  }

  el.gmailImportBtn.disabled = true;
  el.gmailImportBtn.textContent = "接続中...";
  try {
    if (!gmailAccessToken) {
      await requestGmailAccessToken();
    }

    el.gmailImportBtn.textContent = "検索中...";
    const importedIds = new Set(await getImportedGmailIds());

    const listResult = await gmailApiFetch("messages", { q: GMAIL_QUERY, maxResults: "50" });
    const messages = listResult.messages || [];
    const newMessages = messages.filter((m) => !importedIds.has(m.id));

    if (newMessages.length === 0) {
      alert("新しい利用通知メールは見つかりませんでした。");
      return;
    }

    el.gmailImportBtn.textContent = "解析中...";
    const imported = [];
    const newIds = [];
    for (const m of newMessages) {
      const full = await gmailApiFetch(`messages/${m.id}`, { format: "full" });
      const text = findPlainTextPart(full.payload);
      newIds.push(m.id); // 解析できなくても既読扱いにし、毎回取得し直さないようにする
      if (!text) continue;
      const entry = parseVpassEmail(text);
      if (entry) imported.push(entry);
    }

    if (imported.length === 0) {
      await markGmailIdsImported(newIds);
      alert("新しい利用通知メールは見つかりましたが、内容を解析できませんでした。");
      return;
    }

    const total = imported.reduce((sum, e) => sum + e.amount, 0);
    const preview = imported
      .slice(0, 5)
      .map((e) => `${e.date} ${e.memo} ${formatYen(e.amount)} (${e.category})`)
      .join("\n");
    const message =
      `${imported.length}件の利用明細が見つかりました (合計 ${formatYen(total)})。取り込みますか?\n\n` +
      preview +
      (imported.length > 5 ? `\n...ほか${imported.length - 5}件` : "") +
      "\n\nカテゴリは自動推測です。あとで必要に応じて編集してください。";
    if (!confirm(message)) return;

    await importEntriesToDb(imported);
    await markGmailIdsImported(newIds);

    alert(`${imported.length}件をインポートしました。`);
  } catch (err) {
    console.error(err);
    alert("メールの読み込みに失敗しました: " + err.message);
  } finally {
    el.gmailImportBtn.disabled = false;
    el.gmailImportBtn.textContent = "メールから読み込み";
  }
}

// ---------------------------------------------------------------------------
// 認証
// ---------------------------------------------------------------------------

function setupAuthForm() {
  for (const tab of el.authTabs) {
    tab.addEventListener("click", () => {
      authMode = tab.dataset.mode;
      for (const t of el.authTabs) t.classList.toggle("active", t === tab);
      el.authSubmitBtn.textContent = authMode === "login" ? "ログイン" : "新規登録";
      el.authError.classList.add("hidden");
    });
  }

  el.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = el.authEmail.value.trim();
    const password = el.authPassword.value;
    el.authError.classList.add("hidden");
    el.authSubmitBtn.disabled = true;
    try {
      if (authMode === "login") {
        await authApi.signInWithEmailAndPassword(auth, email, password);
      } else {
        await authApi.createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      el.authError.textContent = authErrorMessage(err);
      el.authError.classList.remove("hidden");
    } finally {
      el.authSubmitBtn.disabled = false;
    }
  });

  el.authForgotBtn.addEventListener("click", async () => {
    const email = el.authEmail.value.trim();
    if (!email) {
      el.authError.textContent = "パスワード再設定にはメールアドレスを入力してください。";
      el.authError.classList.remove("hidden");
      return;
    }
    try {
      await authApi.sendPasswordResetEmail(auth, email);
      alert("パスワード再設定用のメールを送信しました。");
    } catch (err) {
      el.authError.textContent = authErrorMessage(err);
      el.authError.classList.remove("hidden");
    }
  });

  el.logoutBtn.addEventListener("click", () => authApi.signOut(auth));
}

// ---------------------------------------------------------------------------
// イベント登録・初期化
// ---------------------------------------------------------------------------

function setupAppEventListeners() {
  el.prevMonth.addEventListener("click", () => {
    currentMonth =
      viewMode === "year"
        ? new Date(currentMonth.getFullYear() - 1, currentMonth.getMonth(), 1)
        : new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    render();
  });

  el.nextMonth.addEventListener("click", () => {
    currentMonth =
      viewMode === "year"
        ? new Date(currentMonth.getFullYear() + 1, currentMonth.getMonth(), 1)
        : new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    render();
  });

  el.todayBtn.addEventListener("click", () => {
    currentMonth = startOfMonth(new Date());
    render();
  });

  for (const tab of el.viewTabs) {
    tab.addEventListener("click", () => {
      viewMode = tab.dataset.view;
      for (const t of el.viewTabs) t.classList.toggle("active", t === tab);
      el.todayBtn.textContent = viewMode === "year" ? "今年" : "今月";
      render();
    });
  }

  for (const radio of document.querySelectorAll('input[name="entry-type"]')) {
    radio.addEventListener("change", () => {
      renderCategoryOptions(selectedType());
      updatePayslipVisibility();
    });
  }

  el.entryCategory.addEventListener("change", updatePayslipVisibility);
  el.payslipToggleBtn.addEventListener("click", openPayslipBreakdown);
  el.payslipClearBtn.addEventListener("click", () => closePayslipBreakdown());
  for (const field of PAYSLIP_FIELDS) {
    payslipInputEl(field).addEventListener("input", updatePayslipPreview);
  }

  el.form.addEventListener("submit", handleSubmit);
  el.cancelEditBtn.addEventListener("click", resetForm);
  el.exportCsvBtn.addEventListener("click", exportCsv);

  el.editBudgetBtn.addEventListener("click", () => {
    if (el.budgetForm.classList.contains("hidden")) openBudgetForm();
    else closeBudgetForm();
  });
  el.cancelBudgetBtn.addEventListener("click", closeBudgetForm);
  el.budgetForm.addEventListener("submit", handleBudgetSubmit);

  el.editIncomeBudgetBtn.addEventListener("click", () => {
    if (el.incomeBudgetForm.classList.contains("hidden")) openIncomeBudgetForm();
    else closeIncomeBudgetForm();
  });
  el.cancelIncomeBudgetBtn.addEventListener("click", closeIncomeBudgetForm);
  el.incomeBudgetForm.addEventListener("submit", handleIncomeBudgetSubmit);

  el.importCsvInput.addEventListener("change", () => {
    const file = el.importCsvInput.files[0];
    if (file) importCsv(file);
    el.importCsvInput.value = "";
  });

  el.gmailImportBtn.addEventListener("click", importFromGmail);

  document.querySelectorAll(".entry-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => handleSortClick(th.dataset.sort));
  });

  el.filterType.addEventListener("change", () => {
    filterType = el.filterType.value;
    renderFilterCategoryOptions();
    render();
  });

  el.filterCategory.addEventListener("change", () => {
    filterCategory = el.filterCategory.value;
    render();
  });

  renderFilterCategoryOptions();
  setupSidebarScrollSpy();
}

// サイドバーのリンクを、現在スクロールして表示中のセクションに応じてハイライトする
// (ヘッダー直下のライン(referenceY)を最後に通過したセクションをアクティブにする。
//  最後のセクションはページ末尾でスクロールが頭打ちになり画面中央まで届かない
//  ことがあるため、IntersectionObserverの領域判定ではなく通過判定を使う)
let sidebarScrollSpyBound = false;

function setupSidebarScrollSpy() {
  if (sidebarScrollSpyBound) return;
  sidebarScrollSpyBound = true;

  const links = [...document.querySelectorAll(".sidebar-link")];
  if (links.length === 0) return;
  const sections = links
    .map((link) => document.getElementById(link.getAttribute("href").slice(1)))
    .filter(Boolean);
  if (sections.length === 0) return;

  const REFERENCE_Y = 140;

  function updateActiveSidebarLink() {
    // ページ最下部までスクロールすると、最後のセクションがページの高さ不足で
    // REFERENCE_Y まで届かないことがあるため、末尾到達時は最後のリンクを優先する
    const atBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;

    let current = sections[0];
    if (atBottom) {
      current = sections[sections.length - 1];
    } else {
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= REFERENCE_Y) current = section;
      }
    }

    for (const link of links) {
      link.classList.toggle("active", link.getAttribute("href") === `#${current.id}`);
    }
  }

  // 初期状態 (ログイン前で #app-root がまだ非表示のときは getBoundingClientRect が
  // 全て0になってしまうため、レイアウト計算に頼らず先頭リンクを既定でアクティブにする)
  links[0].classList.add("active");
  window.addEventListener("scroll", updateActiveSidebarLink, { passive: true });
}

async function main() {
  let appModule, authModule, firestoreModule;
  try {
    [appModule, authModule, firestoreModule] = await Promise.all([
      import(`${FIREBASE_CDN}/firebase-app.js`),
      import(`${FIREBASE_CDN}/firebase-auth.js`),
      import(`${FIREBASE_CDN}/firebase-firestore.js`),
    ]);
  } catch (err) {
    console.error("Firebase SDK の読み込みに失敗しました:", err);
    showOnly("sdk-error");
    return;
  }
  authApi = authModule;
  firestoreApi = firestoreModule;

  let firebaseConfig;
  try {
    ({ firebaseConfig } = await import("./firebase-config.js"));
  } catch {
    showOnly("setup");
    return;
  }

  try {
    ({ googleClientId } = await import("./google-config.js"));
  } catch {
    // 未設定でもアプリ自体は使える (「メールから読み込み」ボタンのみ案内を表示)
    googleClientId = null;
  }

  const app = appModule.initializeApp(firebaseConfig);
  auth = authApi.getAuth(app);
  db = firestoreApi.initializeFirestore(app, {
    localCache: firestoreApi.persistentLocalCache({
      tabManager: firestoreApi.persistentMultipleTabManager(),
    }),
  });

  setupAuthForm();
  setupAppEventListeners();

  authApi.onAuthStateChanged(auth, (user) => {
    if (user) showApp(user);
    else showAuthScreen();
  });
}

main();

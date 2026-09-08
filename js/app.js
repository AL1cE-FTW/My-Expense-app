import { createIcon, hydrateIcons } from "./icons.js";

// このファイルが評価まで到達したことの合図。index.html の見張りが見ている。
// (import しているファイルが1つでも読めないと、ここより下は一切動かない)
window.__appScriptLoaded = true;

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
  income: ["給与", "賞与", "副収入", "立替金返金", "カード返金", "その他収入"],
  save: ["株式", "投資信託", "定期預金", "その他貯蓄"],
};

const TYPE_LABELS = { expense: "支出", income: "収入", save: "貯蓄" };

// 収入目標の「賞与」は月額ではなく、ボーナス月・給与の何か月分かで計算する
const BONUS_CATEGORY = "賞与";

// 立替金(仮払い)の精算で自動作成される収入のカテゴリ。
// 賞与と同じく「目標を立てる収入」ではないため、収入目標の入力欄からは除外する。
const ADVANCE_REFUND_CATEGORY = "立替金返金";

// カード利用履歴CSVのマイナス金額(返金・キャンセル)から作られる収入のカテゴリ。
const CARD_REFUND_CATEGORY = "カード返金";

// 「稼いだお金」ではなく、払ったお金が戻ってきただけの収入。
// 目標・達成率・Need/Want/Save の収入ベースからは除く
// (含めると、10万円のキャンセルだけで「収入目標133%達成」に見えてしまう)。
const REFUND_CATEGORIES = [ADVANCE_REFUND_CATEGORY, CARD_REFUND_CATEGORY];

function isRefundIncome(entry) {
  return entry.type === "income" && REFUND_CATEGORIES.includes(entry.category);
}

// 記録の出どころ。
//   gmail  : カード会社の「ご利用のお知らせ」メールから取り込んだもの。これは
//            速報(未確定)で、売上が確定するときに金額や計上日が動くことがある
//            (海外利用の為替確定、ガソリンスタンドなど)。キャンセルされれば
//            そもそも請求に載らない。
//   card   : カード会社サイトからダウンロードした利用履歴CSVから取り込んだもの。
//            これが確定版で、その期間のカード利用の正解リストにあたる。
//   manual : 手で入力したもの。現金やその他の支払いなので、カード明細とは
//            そもそも突き合わせない。
// 古い記録には source が無い。その場合は「不明」であり、未確定とは扱わない。
const SOURCE_GMAIL = "gmail";
const SOURCE_CARD = "card";
const SOURCE_MANUAL = "manual";

// 未確定(仮)の記録か。メールから取り込んだものだけが未確定。
function isPendingEntry(entry) {
  return entry.source === SOURCE_GMAIL;
}

// 収入目標を設定できるカテゴリ (賞与・返金系は別扱いのため除外)
function incomeBudgetCategories() {
  return CATEGORIES.income.filter(
    (c) => c !== BONUS_CATEGORY && !REFUND_CATEGORIES.includes(c)
  );
}

// 給与明細の内訳入力を出すカテゴリ (給与=通常の給与明細、賞与=賞与明細で項目が異なる)
const PAYSLIP_CATEGORY = "給与";
const PAYSLIP_SALARY_EARNING_FIELDS = [
  "baseSalary",
  "locationAllowance",
  "commute",
  "overtimePay",
  "salaryAdjustment",
];
const PAYSLIP_SALARY_DEDUCTION_FIELDS = [
  "housing",
  "healthInsurance",
  "nursingInsurance",
  "pensionInsurance",
  "employmentInsurance",
  "incomeTax",
  "residentTax",
  "otherDeductions",
];
const PAYSLIP_BONUS_EARNING_FIELDS = ["bonusAmount"];
const PAYSLIP_BONUS_DEDUCTION_FIELDS = [
  "healthInsurance",
  "nursingInsurance",
  "childSupportLevy",
  "pensionInsurance",
  "employmentInsurance",
  "incomeTax",
];

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
let unsubscribeAccounts = null;
// 口座の期首残高とカードの締め日・支払日 (settings/accounts)
let accountSettings = {};
let unsubscribeIncomeBudget = null;
let authMode = "login";

// 記録一覧の並び替え
let sortColumn = "date";
let sortDirection = "desc";
const SORT_DEFAULT_DIRECTION = {
  date: "desc",
  type: "asc",
  category: "asc",
  amount: "desc",
  createdAt: "desc",
};

// 記録一覧の絞り込み
let filterType = "all";
let filterCategory = "all";
// 特定の日だけ表示する ("YYYY-MM-DD"、空文字なら日付で絞り込まない)
let filterDate = "";

// Gmail 連携 (メールからの読み込み)
let googleClientId = null;
let googleTokenClient = null;
let gmailAccessToken = null;
let googleTokenGranted = false;

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

// マイナスは「¥-96,000」ではなく「-¥96,000」にする (アプリ内の他の表示と揃える)
function formatYen(amount) {
  const sign = amount < 0 ? "-" : "";
  return sign + "¥" + Math.abs(amount).toLocaleString("ja-JP");
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

// 記録を作成した日時 (ISO文字列)。取引日 (entry.date) とは別に、
// 「いつ記入・インポートしたか」を残しておくために使う。
function nowTimestamp() {
  return new Date().toISOString();
}

// "YYYY-MM-DD" -> "2026年8月16日"
function formatDateLabel(value) {
  const [y, m, d] = value.split("-");
  return `${Number(y)}年${Number(m)}月${Number(d)}日`;
}

// createdAt (ISO文字列) を表示用の M/D に整形する。未設定の古い記録は "—"。
function formatCreatedAt(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getMonth() + 1}/${date.getDate()}`;
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
  listPendingNote: document.getElementById("list-pending-note"),
  bookkeepingSectionTitle: document.getElementById("bookkeeping-section-title"),
  bookkeepingBody: document.getElementById("bookkeeping-body"),
  bookkeepingNote: document.getElementById("bookkeeping-note"),
  bookTabs: document.querySelectorAll(".book-tab"),
  editAccountsBtn: document.getElementById("edit-accounts-btn"),
  accountsForm: document.getElementById("accounts-form"),
  accountsInputs: document.getElementById("accounts-inputs"),
  accountsOpeningDate: document.getElementById("accounts-opening-date"),
  cardClosingDay: document.getElementById("card-closing-day"),
  cardPaymentDay: document.getElementById("card-payment-day"),
  cardPaymentMonths: document.getElementById("card-payment-months"),
  cancelAccountsBtn: document.getElementById("cancel-accounts-btn"),
  entrySettlement: document.getElementById("entry-settlement"),
  cumulativeSavings: document.getElementById("cumulative-savings"),
  cumulativeChange: document.getElementById("cumulative-change"),
  totalIncome: document.getElementById("total-income"),
  totalExpense: document.getElementById("total-expense"),
  balance: document.getElementById("balance"),
  totalSave: document.getElementById("total-save"),
  form: document.getElementById("entry-form"),
  entryFormSlot: document.getElementById("entry-form-slot"),
  entryEditModal: document.getElementById("entry-edit-modal"),
  entryEditBody: document.getElementById("entry-edit-body"),
  entryEditClose: document.getElementById("entry-edit-close"),
  entryId: document.getElementById("entry-id"),
  entryDate: document.getElementById("entry-date"),
  entryCategory: document.getElementById("entry-category"),
  entryAmount: document.getElementById("entry-amount"),
  entryMemo: document.getElementById("entry-memo"),
  advanceToggle: document.getElementById("advance-toggle"),
  entryAdvance: document.getElementById("entry-advance"),
  advanceOutstandingTotal: document.getElementById("advance-outstanding-total"),
  advanceList: document.getElementById("advance-list"),
  advanceSettleModal: document.getElementById("advance-settle-modal"),
  advanceSettleSummary: document.getElementById("advance-settle-summary"),
  advanceSettleDate: document.getElementById("advance-settle-date"),
  advanceSettleConfirm: document.getElementById("advance-settle-confirm"),
  advanceSettleCancel: document.getElementById("advance-settle-cancel"),
  advanceSettleClose: document.getElementById("advance-settle-close"),
  payslipSection: document.getElementById("payslip-section"),
  payslipToggleBtn: document.getElementById("payslip-toggle-btn"),
  payslipBreakdown: document.getElementById("payslip-breakdown"),
  payslipSalaryFields: document.getElementById("payslip-salary-fields"),
  payslipBaseSalary: document.getElementById("payslip-base-salary"),
  payslipLocationAllowance: document.getElementById("payslip-location-allowance"),
  payslipHousing: document.getElementById("payslip-housing"),
  payslipSalaryAdjustment: document.getElementById("payslip-salary-adjustment"),
  payslipCommute: document.getElementById("payslip-commute"),
  payslipOvertimePay: document.getElementById("payslip-overtime-pay"),
  payslipHealthInsurance: document.getElementById("payslip-health-insurance"),
  payslipNursingInsurance: document.getElementById("payslip-nursing-insurance"),
  payslipPensionInsurance: document.getElementById("payslip-pension-insurance"),
  payslipEmploymentInsurance: document.getElementById("payslip-employment-insurance"),
  payslipIncomeTax: document.getElementById("payslip-income-tax"),
  payslipResidentTax: document.getElementById("payslip-resident-tax"),
  payslipOtherDeductions: document.getElementById("payslip-other-deductions"),
  payslipBonusFields: document.getElementById("payslip-bonus-fields"),
  payslipBonusAmount: document.getElementById("payslip-bonus-amount"),
  payslipBonusHealthInsurance: document.getElementById("payslip-bonus-health-insurance"),
  payslipBonusNursingInsurance: document.getElementById("payslip-bonus-nursing-insurance"),
  payslipBonusChildSupport: document.getElementById("payslip-bonus-child-support"),
  payslipBonusPensionInsurance: document.getElementById("payslip-bonus-pension-insurance"),
  payslipBonusEmploymentInsurance: document.getElementById("payslip-bonus-employment-insurance"),
  payslipBonusIncomeTax: document.getElementById("payslip-bonus-income-tax"),
  payslipGrossValue: document.getElementById("payslip-gross-value"),
  payslipDeductionValue: document.getElementById("payslip-deduction-value"),
  payslipNetValue: document.getElementById("payslip-net-value"),
  payslipHousingNote: document.getElementById("payslip-housing-note"),
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
  filterDate: document.getElementById("filter-date"),
  filterDateClear: document.getElementById("filter-date-clear"),
  listEmptyMessage: document.getElementById("list-empty-message"),
  payslipDetailModal: document.getElementById("payslip-detail-modal"),
  payslipDetailContent: document.getElementById("payslip-detail-content"),
  payslipDetailClose: document.getElementById("payslip-detail-close"),
  exportCsvBtn: document.getElementById("export-csv-btn"),
  exportAnalysisBtn: document.getElementById("export-analysis-btn"),
  importCsvInput: document.getElementById("import-csv-input"),
  importCsvBtn: document.getElementById("import-csv-btn"),
  gmailImportBtn: document.getElementById("gmail-import-btn"),
};

function selectedType() {
  return document.querySelector('input[name="entry-type"]:checked').value;
}

// ---------------------------------------------------------------------------
// 画面切り替え
// ---------------------------------------------------------------------------

function showOnly(screen) {
  // モーダルは #app-root の外にあるので、明示的に閉じないと
  // ログイン画面などの上に浮いたまま残る
  closeAllModals();
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
  if (unsubscribeAccounts) {
    unsubscribeAccounts();
    unsubscribeAccounts = null;
  }
  entries = [];
  budgets = {};
  incomeBudgets = {};
  accountSettings = {};
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
  subscribeAccounts(user.uid);
  resetForm();
  closeBudgetForm();
  closeIncomeBudgetForm();
  closeAccountsForm();
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
  const ref = await firestoreApi.addDoc(entriesCollection(currentUid), data);
  return ref?.id;
}

async function updateEntryInDb(id, data) {
  await firestoreApi.updateDoc(firestoreApi.doc(db, `users/${currentUid}/entries/${id}`), data);
}

async function deleteEntryFromDb(id) {
  await firestoreApi.deleteDoc(firestoreApi.doc(db, `users/${currentUid}/entries/${id}`));
}

async function importEntriesToDb(items) {
  const CHUNK_SIZE = 400;
  // インポートした日時を記録しておく (CSV・メールからの取り込み共通)
  const importedAt = nowTimestamp();
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const batch = firestoreApi.writeBatch(db);
    for (const item of chunk) {
      batch.set(firestoreApi.doc(entriesCollection(currentUid)), {
        createdAt: importedAt,
        ...item,
      });
    }
    await batch.commit();
  }
}

// 複数の記録をまとめて更新する。updateDoc と同じく、渡したキーだけを書き換える
// (source を確定に変えても、手で直したカテゴリやメモはそのまま残る)。
async function updateEntriesInDb(updates) {
  const CHUNK_SIZE = 400;
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const batch = firestoreApi.writeBatch(db);
    for (const { id, data } of updates.slice(i, i + CHUNK_SIZE)) {
      batch.update(firestoreApi.doc(db, `users/${currentUid}/entries/${id}`), data);
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

function accountsDocRef(uid) {
  return firestoreApi.doc(db, `users/${uid}/settings/accounts`);
}

function subscribeAccounts(uid) {
  if (unsubscribeAccounts) unsubscribeAccounts();
  unsubscribeAccounts = firestoreApi.onSnapshot(
    accountsDocRef(uid),
    (snap) => {
      accountSettings = snap.exists() ? snap.data() : {};
      render();
    },
    (error) => {
      console.error(error);
      alert("口座の設定の取得に失敗しました: " + error.message);
    }
  );
}

async function saveAccountSettingsToDb(settings) {
  await firestoreApi.setDoc(accountsDocRef(currentUid), settings);
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
  el.bookkeepingSectionTitle.textContent = `${periodLabel}の帳簿`;

  renderCumulativeSavings();

  const targetMultiplier = viewMode === "year" ? elapsedMonthsInYear() : 1;
  const entriesInPeriod = periodEntries();
  renderSummary(entriesInPeriod);
  renderMonthlyBarChart();
  const budgetTotals = renderBudget(entriesInPeriod, targetMultiplier);
  renderPlanActual(entriesInPeriod, targetMultiplier, budgetTotals);
  renderAdvances();
  renderNeedWantSave(entriesInPeriod, targetMultiplier);
  renderBookkeeping(entriesInPeriod);
  renderList(entriesInPeriod);
}

// ---------------------------------------------------------------------------
// 立替金 (仮払い)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// モーダル共通
// ---------------------------------------------------------------------------

// モーダルを開く前にフォーカスがあった要素。閉じたときにここへ戻す
// (戻さないとページ先頭に飛ばされ、キーボード操作だと元の位置を見失う)
let modalReturnFocus = null;

const FOCUSABLE_IN_MODAL =
  'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

function focusableElementsIn(overlay) {
  return [...overlay.querySelectorAll(FOCUSABLE_IN_MODAL)].filter(
    (elem) => !elem.disabled && elem.offsetParent !== null
  );
}

// Tab がモーダルの外へ抜けないようにする。aria-modal は読み上げの範囲を
// 絞るだけでフォーカス順には影響しないため、暗幕の下の「ログアウト」などに
// たどり着けてしまう。
function trapFocus(event) {
  if (event.key !== "Tab") return;
  const overlay = document.querySelector(".modal-overlay:not(.hidden)");
  if (!overlay) return;
  const items = focusableElementsIn(overlay);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !overlay.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

// モーダルを開いている間、裏のページがスクロールしてしまうのを止める。
// iOS Safari は body の overflow:hidden を無視するため、位置を固定して
// スクロール量ぶんずらす方式にする (見た目は動かない)。
let scrollLockY = 0;

function lockBodyScroll() {
  if (document.body.classList.contains("modal-open")) return;
  scrollLockY = window.scrollY;
  // スクロールバーが消えるぶん内容が右にずれるのを防ぐ (PC)
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
  document.body.style.top = `-${scrollLockY}px`;
  document.body.classList.add("modal-open");
}

function unlockBodyScroll() {
  if (!document.body.classList.contains("modal-open")) return;
  document.body.classList.remove("modal-open");
  document.body.style.top = "";
  document.body.style.paddingRight = "";
  // html { scroll-behavior: smooth } が効くとアニメーションになってしまうので、
  // 復元は必ず一瞬で行う
  window.scrollTo({ top: scrollLockY, left: 0, behavior: "instant" });
}

function openModal(overlay, focusTarget) {
  // 既に開いているモーダルがある場合、復帰先を上書きすると元の位置を失う
  if (!document.querySelector(".modal-overlay:not(.hidden)")) {
    modalReturnFocus = document.activeElement;
  }
  lockBodyScroll();
  overlay.classList.remove("hidden");
  // フォーカス時にブラウザが勝手にスクロールしないようにする
  // (位置を固定しているあいだにずれると、閉じたときに元へ戻せなくなる)
  if (focusTarget) focusTarget.focus({ preventScroll: true });
}

function closeModal(overlay) {
  overlay.classList.add("hidden");
  // 他にまだ開いているものが無ければスクロールを戻す
  if (!document.querySelector(".modal-overlay:not(.hidden)")) unlockBodyScroll();
  // 復帰先が再描画で消えていることがある (一覧は毎回作り直されるため)。
  // その場合はページ先頭に飛ばさず、せめて記録一覧の見出しへ移す。
  if (modalReturnFocus && document.contains(modalReturnFocus)) {
    modalReturnFocus.focus({ preventScroll: true });
  } else if (modalReturnFocus) {
    el.listSectionTitle?.focus({ preventScroll: true });
  }
  modalReturnFocus = null;
}

// 画面を切り替えるときは開いているモーダルも閉じる。
// モーダルは #app-root の外にあるため、本体を隠すだけでは
// ログイン画面の上に浮いたまま残ってしまう。
function closeAllModals() {
  for (const overlay of document.querySelectorAll(".modal-overlay:not(.hidden)")) {
    overlay.classList.add("hidden");
  }
  restoreEntryForm();
  unlockBodyScroll();
  settlingAdvance = null;
  modalReturnFocus = null;
}

// ---------------------------------------------------------------------------
// 記録の編集ポップアップ
//
// 入力フォームはページの上のほう、記録一覧はいちばん下にあるため、
// 「編集」を押すたびに長い距離をスクロールで往復することになっていた。
// 編集のあいだだけフォーム要素そのものをポップアップへ移し、
// 閉じたら元の場所へ戻す。要素ごと動かすのでイベントリスナーは付いたまま。
// ---------------------------------------------------------------------------

function entryFormIsInModal() {
  return el.entryEditBody.contains(el.form);
}

// フォームを抜くとページがその高さぶん縮み、下にある記録一覧がずり上がって
// 見ていた行を見失う。Chrome のスクロールアンカリングは効くが Safari は
// 効かないため、元の高さを確保しておく。
//
// 確保は「フォームの中身を書き換える前」に行う必要がある。編集内容を流し込むと
// 給与明細の内訳が開閉して高さが変わるため、あとから測ると縮んだ後の高さを
// 覚えてしまい、一覧が大きくずれる。
function reserveEntryFormHeight() {
  if (entryFormIsInModal()) return;
  if (el.entryFormSlot.style.minHeight) return;
  el.entryFormSlot.style.minHeight = `${el.entryFormSlot.offsetHeight}px`;
}

function openEntryEditModal() {
  if (!entryFormIsInModal()) {
    reserveEntryFormHeight();
    el.entryEditBody.appendChild(el.form);
  }
  // 直したいのはたいていカテゴリなので、そこにフォーカスを置く
  openModal(el.entryEditModal, el.entryCategory);
}

function restoreEntryForm() {
  // 元の場所は見出し (#form-title) の直後。appendChild で並び順も戻る
  if (!entryFormIsInModal()) return;
  el.entryFormSlot.appendChild(el.form);
  el.entryFormSlot.style.minHeight = "";
}

function closeEntryEditModal() {
  if (el.entryEditModal.classList.contains("hidden")) return;
  // 先にフォームを元の場所へ戻してページの高さを確定させてから閉じる。
  // 逆にするとスクロール位置を復元した直後に高さが変わり、位置がずれる
  restoreEntryForm();
  closeModal(el.entryEditModal);
  restoreEditAnchor();
}

// 編集していた行を目印に、閉じたあとも同じ位置に見えるようにする。
//
// スクロール位置の数値をそのまま戻すだけでは足りない。編集を始めると入力欄の
// 中身が入れ替わってフォームの高さが変わるため、閉じたときのページは開く前より
// 短い(または長い)ことがあり、同じ数値に戻すと別の場所が映る。
// 行そのものを基準にすれば、高さがどう変わっても見た目の位置を保てる。
let editAnchor = null;

function editRowElement(id) {
  return document.querySelector(`#entry-list [data-edit-id="${CSS.escape(id)}"]`)?.closest("tr");
}

function rememberEditAnchor(id) {
  const row = editRowElement(id);
  editAnchor = row ? { id, top: row.getBoundingClientRect().top } : null;
}

function restoreEditAnchor() {
  const anchor = editAnchor;
  editAnchor = null;
  if (!anchor) return;
  // 一覧の作り直し (render) まで終わってから測りたいので、次の描画直前に回す
  requestAnimationFrame(() => {
    const row = editRowElement(anchor.id);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) window.scrollBy({ top: delta, left: 0, behavior: "instant" });
  });
}

/**
 * 立替金の精算状態は保存せず、返金記録の有無から導出する。
 * (「精算済み」フラグを両方に書くと、片方を消したときに整合性が崩れるため)
 * 立替entryのid -> 返金entry の Map を1回の走査で作る。
 */
// 給与から天引きされた家賃 (寮社宅費) に対応する「支出・住居」の記録。
// 立替金と返金と同じく、給与の記録と対にして扱う。
// 別々に管理すると、給与を消したときに家賃だけ残って累計貯金額がずれる。
const PAYSLIP_HOUSING_CATEGORY = "住居";
const PAYSLIP_HOUSING_MEMO = "給与天引き: 寮社宅費";

function payslipHousingAmount(entry) {
  if (!entry || entry.type !== "income" || !entry.payslip) return 0;
  if (entry.payslip.kind === "bonus") return 0;
  return entry.payslip.housing || 0;
}

function housingEntryFor(salaryId) {
  return entries.find((e) => e.payslipHousingFor === salaryId);
}

// 給与の記録に合わせて、対になる住居の支出を作る・直す・消す
async function syncPayslipHousingEntry(salaryId, data) {
  const housing = payslipHousingAmount(data);
  const existing = housingEntryFor(salaryId);

  if (housing <= 0) {
    if (existing) await deleteEntryFromDb(existing.id);
    return;
  }

  const housingData = {
    date: data.date,
    type: "expense",
    category: PAYSLIP_HOUSING_CATEGORY,
    amount: housing,
    memo: PAYSLIP_HOUSING_MEMO,
    payslip: null,
    advance: false,
    payslipHousingFor: salaryId,
    // 給与から天引きされる家賃なので、現金ではなく振込先の口座から出ていく形。
    // 現金扱いにすると、実際には持っていない現金が減ってしまう。
    settlement: "bank",
  };

  if (existing) {
    await updateEntryInDb(existing.id, housingData);
  } else {
    await addEntryToDb({ ...housingData, createdAt: nowTimestamp() });
  }
}

function refundsByAdvanceId() {
  const map = new Map();
  for (const e of entries) {
    if (e.advanceRefundFor) map.set(e.advanceRefundFor, e);
  }
  return map;
}

// 未回収の立替金。期間(今月/今年)では絞り込まない —
// 先月の立替でも返金されるまでは未回収のままなので、常に全期間が対象。
function outstandingAdvances(refundMap = refundsByAdvanceId()) {
  return entries
    .filter((e) => e.advance === true && !refundMap.has(e.id))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function renderAdvances() {
  const outstanding = outstandingAdvances();
  const total = outstanding.reduce((sum, e) => sum + e.amount, 0);
  el.advanceOutstandingTotal.textContent = formatYen(total);

  el.advanceList.innerHTML = "";

  if (outstanding.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = "未回収の立替金はありません。";
    el.advanceList.appendChild(p);
    return;
  }

  for (const entry of outstanding) {
    const row = document.createElement("div");
    row.className = "advance-row";

    const dateEl = document.createElement("span");
    dateEl.className = "advance-row-date";
    const [, m, d] = entry.date.split("-");
    dateEl.textContent = `${Number(m)}/${Number(d)}`;

    const categoryEl = document.createElement("span");
    categoryEl.textContent = entry.category;

    const memoEl = document.createElement("span");
    memoEl.className = "advance-row-memo";
    memoEl.textContent = entry.memo || "";

    const amountEl = document.createElement("span");
    amountEl.className = "advance-row-amount";
    amountEl.textContent = formatYen(entry.amount);

    const settleBtn = document.createElement("button");
    settleBtn.type = "button";
    settleBtn.className = "icon-btn";
    settleBtn.textContent = "精算";
    settleBtn.setAttribute(
      "aria-label",
      `${entry.date} ${entry.category} ${formatYen(entry.amount)} の立替金を精算`
    );
    settleBtn.addEventListener("click", () => openAdvanceSettleModal(entry));

    row.append(dateEl, categoryEl, memoEl, amountEl, settleBtn);
    el.advanceList.appendChild(row);
  }
}

// 精算するために選択中の立替entry
let settlingAdvance = null;

function openAdvanceSettleModal(entry) {
  settlingAdvance = entry;
  el.advanceSettleSummary.textContent =
    `${entry.date} ${entry.category} ${formatYen(entry.amount)}` +
    (entry.memo ? ` (${entry.memo})` : "");
  el.advanceSettleDate.value = toDateInputValue(new Date());
  openModal(el.advanceSettleModal, el.advanceSettleDate);
}

function closeAdvanceSettleModal() {
  closeModal(el.advanceSettleModal);
  settlingAdvance = null;
}

async function confirmAdvanceSettle() {
  if (!settlingAdvance) return;
  const refundDate = el.advanceSettleDate.value;
  if (!refundDate) {
    alert("返金された日を入力してください。");
    return;
  }

  // モーダルを開いている間に別の端末・タブで変更されている可能性があるため、
  // 保持しているオブジェクトではなく id で引き直す。
  const advance = entries.find((e) => e.id === settlingAdvance.id);
  if (!advance || advance.advance !== true) {
    alert("この立替金は既に削除されたか、立替ではなくなっています。");
    closeAdvanceSettleModal();
    return;
  }
  if (refundsByAdvanceId().has(advance.id)) {
    alert("この立替金は既に精算済みです。");
    closeAdvanceSettleModal();
    return;
  }

  // オフラインだと addDoc はサーバー応答まで解決しないため、先にモーダルを閉じる。
  // (待っているとボタンが無効のまま固まり、その裏で記録だけ現れる)
  closeAdvanceSettleModal();
  try {
    await addEntryToDb({
      date: refundDate,
      type: "income",
      category: ADVANCE_REFUND_CATEGORY,
      amount: advance.amount,
      memo: `立替金精算: ${advance.memo || advance.category}`,
      payslip: null,
      advance: false,
      advanceRefundFor: advance.id,
      createdAt: nowTimestamp(),
    });
  } catch (err) {
    alert("精算の記録に失敗しました: " + err.message);
  }
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
  el.cumulativeSavings.textContent = formatYen(total);
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
  el.balance.textContent = formatYen(balance);
  el.balance.classList.toggle("positive", balance > 0);
  el.balance.classList.toggle("negative", balance < 0);
  el.totalSave.textContent = formatYen(saved);
}

/**
 * 年間表示の目標を何か月分にするか。
 * 当年は3月に「3か月分の実績 vs 12か月分の目標」を比べても意味がないため、
 * 経過した月数(表示中の月を含む)で按分する。過去の年は12か月分のまま。
 */
function elapsedMonthsInYear() {
  const now = new Date();
  const shownYear = currentMonth.getFullYear();
  // 未来の年はまだ実績が無いだけなので、年間フルの目標を素直に見せる。
  // 0 を返すと目標が全て 0 になり、設定済みの予算が「予算未設定」と
  // 表示されてしまう (設定が消えたように見える)。
  if (shownYear !== now.getFullYear()) return 12;
  return now.getMonth() + 1;
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

  // 分子も予算を設定したカテゴリだけにする。分母が「予算のあるカテゴリ」なのに
  // 分子が全支出だと、食費だけ3万の予算で交際費に5万使うと「233%」と真っ赤に
  // なるのに、予算を設定したカテゴリは全て予算内、という噛み合わない表示になる。
  let totalActual = 0;
  let unbudgetedActual = 0;
  for (const [category, amount] of actuals) {
    if (budgets[category] > 0) totalActual += amount;
    else unbudgetedActual += amount;
  }

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

    // 予算を設定していないカテゴリの支出は、上のバーに含まれず見えなくなるため別行で出す
    if (unbudgetedActual > 0) {
      const extra = document.createElement("div");
      extra.className = "budget-unbudgeted";
      extra.textContent = `予算外: ${formatYen(unbudgetedActual)}`;
      el.budgetOverall.appendChild(extra);
    }
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
    return { totalActual, totalBudget, unbudgetedActual };
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

  return { totalActual, totalBudget, unbudgetedActual };
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

  // 実績は予算を設定したカテゴリの支出だけ。サマリーの「支出」と額が違うので、
  // 差がどこから来ているのかを添える (何も書かないと集計漏れに見える)。
  if (budgetTotals.totalBudget > 0 && budgetTotals.unbudgetedActual > 0) {
    const note = document.createElement("p");
    note.className = "plan-actual-note";
    note.id = "unbudgeted-note";
    note.textContent =
      `実績は予算を設定したカテゴリのみ。ほかに予算外の支出が ` +
      `${formatYen(budgetTotals.unbudgetedActual)} あります。`;
    el.expensePlanActual.appendChild(note);
  }

  const totalIncomeBudget = computeIncomeBudgetTotal(targetMultiplier);
  // 返金(立替金の精算・カードのキャンセル)は「稼いだお金」ではないので、
  // 目標側 (incomeBudgetCategories) と同じく実績側からも除く。
  // 含めると、給与目標30万・給与30万・立替精算5万で「117%達成」に見えてしまう。
  let totalIncomeActual = 0;
  for (const e of monthEntries) {
    if (e.type === "income" && !isRefundIncome(e)) {
      totalIncomeActual += e.amount;
    }
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
  const baseMonthly = incomeBudgetCategories().reduce(
    (sum, c) => sum + (incomeBudgets[c] || 0),
    0
  );

  const bonusMonths = Array.isArray(incomeBudgets.bonusMonths) ? incomeBudgets.bonusMonths : [];
  const bonusMultiplier = Number(incomeBudgets.bonusMultiplier) || 0;
  const bonusPerOccurrence = (incomeBudgets["給与"] || 0) * bonusMultiplier;

  if (viewMode === "year") {
    // 年間表示: 月額×経過月数 + 到来済みのボーナス月の分だけ上乗せする。
    // (未到来のボーナスまで目標に足すと、達成率が実態より低く見える)
    const elapsed = targetMultiplier;
    const arrivedBonusCount = bonusMonths.filter((m) => m <= elapsed).length;
    return baseMonthly * elapsed + bonusPerOccurrence * arrivedBonusCount;
  }
  // 月別表示: 月額 + (表示中の月がボーナス月ならその分を上乗せ)
  const isBonusMonth = bonusMonths.includes(currentMonth.getMonth() + 1);
  return baseMonthly + (isBonusMonth ? bonusPerOccurrence : 0);
}

function renderBonusNote() {
  // 予算外の注記も同じクラスを使うので、id で確実に賞与の注記だけを消す
  document.getElementById("bonus-note")?.remove();

  const bonusMonths = Array.isArray(incomeBudgets.bonusMonths) ? incomeBudgets.bonusMonths : [];
  const bonusMultiplier = Number(incomeBudgets.bonusMultiplier) || 0;
  if (bonusMonths.length === 0 || bonusMultiplier <= 0) return;
  // 給与の目標が未設定だと実額0なので、目標に何も足されていない。
  // それでも「◯月に給与◯か月分を計上」と出ると計上済みに見えてしまう。
  const bonusPerOccurrence = (incomeBudgets["給与"] || 0) * bonusMultiplier;
  if (bonusPerOccurrence <= 0) return;

  const note = document.createElement("p");
  note.className = "plan-actual-note";
  note.id = "bonus-note";
  const monthsLabel = [...bonusMonths].sort((a, b) => a - b).map((m) => `${m}月`).join("・");
  note.textContent =
    `賞与: ${monthsLabel}に給与${bonusMultiplier}か月分 (${formatYen(bonusPerOccurrence)}) を計上`;
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
const NWS_LABELS = { need: "Need", want: "Want", save: "Save" };
const NWS_ICONS = { need: "house", want: "shopping-bag", save: "piggy-bank" };
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

function renderNeedWantSave(monthEntries, targetMultiplier) {
  let actualIncome = 0;
  let needSpent = 0;
  let wantSpent = 0;
  for (const e of monthEntries) {
    if (e.type === "income") {
      // 返金は稼いだお金ではないので、50:30:20 の基準となる収入には数えない。
      // (5万円の立替精算で Need の目標が2.5万円水増しされるのを防ぐ。
      //  対になる支出も同じ期間にあれば Save 実績で自然に相殺される)
      if (!isRefundIncome(e)) actualIncome += e.amount;
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

  // 給与は月末にまとめて記録することが多く、それまで収入が0のままになる。
  // 実績だけを基準にすると、使いすぎに気づきたい月の前半こそ何も出ない。
  // そこで収入目標を下限として使い、実績が目標を超えたら実績に切り替える。
  const targetIncome = computeIncomeBudgetTotal(targetMultiplier);
  const basisIncome = Math.max(actualIncome, targetIncome);
  const usingTarget = basisIncome > actualIncome;

  if (basisIncome <= 0) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent =
      `${viewMode === "year" ? "今年" : "今月"}の収入を登録するか、` +
      `「収入目標を編集」から目標を設定すると表示されます`;
    el.nwsLegend.appendChild(p);
    return;
  }

  const totalIncome = basisIncome;
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
    // 予算バー (budgetBarClass) と同じく 100% ちょうども超過扱いにする。
    // 閾値が食い違うと、同じ画面で予算バーは赤・ドーナツは青と色が割れる。
    const isOver = bucket.key === "save" ? ratio < 0 : ratio >= 1;
    // 収入以上に使った月は Save がマイナスになる。0で塗ると弧が空になり
    // 「ちょうど0円貯金」と見分けがつかないので、警告として赤で埋める。
    const fillRatio = isOver && bucket.key === "save" ? 1 : Math.min(Math.max(ratio, 0), 1);
    const fillLength = segmentLength * fillRatio;
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
    label.append(
      createIcon(NWS_ICONS[bucket.key]),
      `${NWS_LABELS[bucket.key]} ${Math.round(NWS_TARGET_RATIO[bucket.key] * 100)}%`
    );

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

  // 何を基準に割合を出しているかを明示する。黙って目標を使うと、
  // 給与を登録した瞬間に数字が動いて理由が分からなくなる
  if (usingTarget) {
    const note = document.createElement("p");
    note.className = "nws-basis-note";
    note.id = "nws-basis-note";
    note.textContent =
      `収入目標 ${formatYen(basisIncome)} を基準にしています` +
      `(登録済みの収入は ${formatYen(actualIncome)})。` +
      `実績が目標を超えると、そちらに切り替わります。`;
    el.nwsLegend.appendChild(note);
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
    // 登録日が未設定の古い記録は、昇順・降順どちらでも末尾に寄せる。
    // 下の符号反転より前に決めないと、反転に巻き込まれて先頭に来てしまう。
    if (sortColumn === "createdAt") {
      const missingA = !a.createdAt;
      const missingB = !b.createdAt;
      if (missingA !== missingB) return missingA ? 1 : -1;
    }

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
      case "createdAt": {
        // 未設定どうし、または両方設定済みのケースだけがここに来る
        const av = a.createdAt || "";
        const bv = b.createdAt || "";
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
        break;
      }
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
    const active = th.dataset.sort === sortColumn;
    const ascending = active && sortDirection === "asc";

    th.classList.toggle("sort-active", active);
    // 矢印は目で見ないと分からないので、読み上げにも現在の並び順を伝える
    th.setAttribute(
      "aria-sort",
      active ? (ascending ? "ascending" : "descending") : "none"
    );

    // 並び替えできる列には常に矢印を置き、効いていない列は見えなくするだけに
    // する。出し入れすると見出しの幅が変わって、列がガタつくため。
    th.querySelector(".sort-icon")?.remove();
    th.querySelector(".sort-btn")?.appendChild(
      createIcon(ascending ? "arrow-up" : "arrow-down", {
        className: active ? "sort-icon" : "sort-icon inactive",
      })
    );
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
    if (filterDate && e.date !== filterDate) return false;
    return true;
  });
}

function hasActiveFilters() {
  return filterType !== "all" || filterCategory !== "all" || filterDate !== "";
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
  const isFiltered = hasActiveFilters();

  el.entryList.innerHTML = "";
  el.listEmptyMessage.classList.toggle("hidden", filtered.length > 0);

  const periodLabel = viewMode === "year" ? "今年" : "今月";
  el.listEmptyMessage.textContent =
    monthEntries.length === 0 && !isFiltered
      ? `${periodLabel}の記録はまだありません。上のフォームから追加してください。`
      : "条件に一致する記録がありません。";

  // 日付で絞り込んでいるときは、見出しにその日を出して現在の表示条件を分かりやすくする
  el.listSectionTitle.textContent = filterDate
    ? `${formatDateLabel(filterDate)}の記録`
    : `${periodLabel}の記録`;
  el.filterDateClear.classList.toggle("hidden", !filterDate);

  renderPendingNote(monthEntries);
  updateSortIndicators();

  const refundMap = refundsByAdvanceId();

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

    // メールから取り込んだ記録は「ご利用のお知らせ」= 速報なので、確定明細で
    // 金額や日付が動くことがある。確定済みと見分けが付くようにする。
    if (isPendingEntry(entry)) {
      const pendingBadge = document.createElement("span");
      pendingBadge.className = "pending-badge";
      pendingBadge.textContent = "仮";
      pendingBadge.title =
        "メールの利用通知から取り込んだ未確定の記録。" +
        "カード利用履歴CSVを取り込むと確定します";
      typeTd.appendChild(pendingBadge);
    }

    // 立替払いは種別セルに印を付ける (カテゴリセルに入れると並び替えの比較対象が変わるため)
    if (entry.advance === true) {
      const settled = refundMap.has(entry.id);
      const advanceBadge = document.createElement("span");
      advanceBadge.className = settled ? "advance-badge settled" : "advance-badge";
      advanceBadge.textContent = settled ? "立替(精算済)" : "立替(未回収)";
      typeTd.appendChild(advanceBadge);
    }

    const categoryTd = document.createElement("td");
    categoryTd.textContent = entry.category;

    const amountTd = document.createElement("td");
    amountTd.className = `amount-cell ${entry.type}`;
    amountTd.textContent =
      (entry.type === "income" ? "+" : "-") + formatYen(entry.amount);

    const memoTd = document.createElement("td");
    memoTd.className = "memo-cell";
    memoTd.textContent = entry.memo || "";

    // 記入・インポートした日 (取引日とは別)
    const createdAtTd = document.createElement("td");
    createdAtTd.className = "created-at-cell";
    createdAtTd.textContent = formatCreatedAt(entry.createdAt);
    if (entry.createdAt) createdAtTd.title = new Date(entry.createdAt).toLocaleString("ja-JP");

    const actionsTd = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";

    // ボタン名が全行「編集」「削除」だと、読み上げの要素一覧でどの行のものか
    // 判別できない。どの記録に対する操作かを添える。
    const rowLabel = `${entry.date} ${entry.category} ${formatYen(entry.amount)}`;

    if (entry.payslip) {
      const detailBtn = document.createElement("button");
      detailBtn.className = "icon-btn";
      detailBtn.textContent = "内訳";
      detailBtn.setAttribute("aria-label", `${rowLabel} の内訳を見る`);
      detailBtn.addEventListener("click", () => showPayslipDetailModal(entry));
      actions.appendChild(detailBtn);
    }

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "編集";
    editBtn.setAttribute("aria-label", `${rowLabel} を編集`);
    // 更新後にこの行のボタンへフォーカスを戻すための目印
    editBtn.dataset.editId = entry.id;
    editBtn.addEventListener("click", () => startEdit(entry.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn delete";
    deleteBtn.textContent = "削除";
    deleteBtn.setAttribute("aria-label", `${rowLabel} を削除`);
    deleteBtn.addEventListener("click", () => deleteEntry(entry.id));

    actions.append(editBtn, deleteBtn);
    actionsTd.appendChild(actions);

    tr.append(dateTd, typeTd, categoryTd, amountTd, memoTd, createdAtTd, actionsTd);
    el.entryList.appendChild(tr);
  }
}

// 未確定(メールから取り込んだ仮の記録)が期間内にいくつあるかを一覧の上に出す。
// 「今どこまで確定しているか」が分からないと、収支が動くかどうか判断できない。
// 絞り込みの結果ではなく期間全体を数える (絞り込みで見えていない仮の記録も
// 収支には効いているため)。
function renderPendingNote(monthEntries) {
  const pending = monthEntries.filter(isPendingEntry);
  el.listPendingNote.classList.toggle("hidden", pending.length === 0);
  if (pending.length === 0) return;

  const total = pending.reduce((sum, e) => sum + e.amount, 0);
  el.listPendingNote.textContent =
    `未確定「仮」が${pending.length}件 (${formatYen(total)})。` +
    "メールの利用通知から取り込んだ速報で、確定時に金額が変わることがあります。" +
    "カード利用履歴CSVを取り込むと確定版に置き換わります。";
}

// ---------------------------------------------------------------------------
// 帳簿 (簿記の見方)
//
// このアプリの入力は単式 (1件 = 日付・種別・カテゴリ・金額) だが、複式の
// 見方は既存のデータから導出できる。ここでは記録を仕訳に変換し、そこから
// 合計試算表と損益計算書を組み立てる。入力の手間は増やさない。
//
// 勘定科目は既存のカテゴリをそのまま使い、給与明細の控除だけ簿記の科目名
// (法定福利費・租税公課) に振り分ける。
// ---------------------------------------------------------------------------

const CASH_ACCOUNT = "現金";
const BANK_ACCOUNT = "銀行口座";
const PAYABLE_ACCOUNT = "未払金";
const SOCIAL_INSURANCE_ACCOUNT = "法定福利費";
const TAX_ACCOUNT = "租税公課";
// 給与明細の内訳が支給合計と噛み合わないとき、貸借を合わせるための受け皿。
// ここに金額が出たら入力のどこかが間違っている。
const IMBALANCE_ACCOUNT = "差額 (要確認)";

// カードで払ったか。カード払いは現金がまだ出ていかないので、貸方は未払金になる。
function isCardEntry(entry) {
  return entry.source === SOURCE_GMAIL || entry.source === SOURCE_CARD;
}

// 現金と銀行口座のどちらが動いたか。
// この区別を入れる前の記録には settlement が無いので、種別から推定する
// (支出は現金、収入と貯蓄は口座) — フォームの初期値と同じ考え方。
function settlementAccount(entry) {
  if (entry.settlement === "bank") return BANK_ACCOUNT;
  if (entry.settlement === "cash") return CASH_ACCOUNT;
  // 給与天引きの家賃は現金を通らない (この区別を入れる前に作られた記録の救済)
  if (entry.payslipHousingFor) return BANK_ACCOUNT;
  return entry.type === "expense" ? CASH_ACCOUNT : BANK_ACCOUNT;
}

// その記録でお金が動く側の科目。カードなら未払金 (負債の増加)。
function paymentAccount(entry) {
  return isCardEntry(entry) ? PAYABLE_ACCOUNT : settlementAccount(entry);
}

const ASSET_ACCOUNTS = [CASH_ACCOUNT, BANK_ACCOUNT];
const LIABILITY_ACCOUNTS = [PAYABLE_ACCOUNT];

// 勘定科目の5要素分類。貸借対照表(資産・負債・純資産)と
// 損益計算書(収益・費用)のどちらに載るかがこれで決まる。
function accountType(account) {
  if (ASSET_ACCOUNTS.includes(account)) return "asset";
  // 貯蓄・投資は費用ではなく、現金が別の資産に形を変えただけ
  if (CATEGORIES.save.includes(account)) return "asset";
  if (LIABILITY_ACCOUNTS.includes(account)) return "liability";
  if (CATEGORIES.income.includes(account)) return "revenue";
  if (account === IMBALANCE_ACCOUNT) return "other";
  return "expense";
}

const ACCOUNT_TYPE_LABELS = {
  asset: "資産",
  liability: "負債",
  revenue: "収益",
  expense: "費用",
  other: "その他",
};

// 簿記の教科書どおりの扱いと、このアプリの集計が違うところ。
// 仕訳帳の行に添えて、違いに気づけるようにする。
const JOURNAL_NOTES = {
  advance:
    "簿記では (借)立替金 / (貸)現金預金 として資産に計上します。" +
    "このアプリは支出として集計しているため、ここでも費用のまま表示しています。",
  [ADVANCE_REFUND_CATEGORY]:
    "簿記では立替金 (資産) の回収なので、収益にはなりません。",
  [CARD_REFUND_CATEGORY]:
    "簿記では費用の取り消し (戻し入れ) として、元の費用科目を減らします。",
};

function journalLine(side, account, amount) {
  return { side, account, amount };
}

/**
 * 記録1件を仕訳 (借方・貸方の組) に変換する。
 *
 * 給与明細のある収入は複合仕訳になる。このアプリは
 *   記録の金額 = 振込額 + 寮社宅費
 * で持っていて、寮社宅費は別に「住居」の支出として記録されている。そのため
 * ここでは寮社宅費を控除に立てず、記録の金額をそのまま受取額として扱う:
 *
 *   (借) 現金預金   振込額+寮社宅費   (貸) 給与  支給合計
 *   (借) 法定福利費 健康保険+介護+厚生年金+雇用
 *   (借) 租税公課   所得税+住民税
 *
 * 支給合計 = 記録の金額 + 法定福利費 + 租税公課 + その他控除 になるので、
 * これで貸借が一致する。
 */
function journalFor(entry) {
  const lines = [];
  const notes = [];

  if (entry.type === "expense") {
    lines.push(journalLine("debit", entry.category, entry.amount));
    lines.push(journalLine("credit", paymentAccount(entry), entry.amount));
    if (entry.advance === true) notes.push(JOURNAL_NOTES.advance);
  } else if (entry.type === "save") {
    // 貯蓄・投資は費用ではない。現金が投資資産に振り替わるだけ
    lines.push(journalLine("debit", entry.category, entry.amount));
    lines.push(journalLine("credit", paymentAccount(entry), entry.amount));
  } else {
    const p = entry.payslip;
    const received = paymentAccount(entry);
    if (!p) {
      lines.push(journalLine("debit", received, entry.amount));
      lines.push(journalLine("credit", entry.category, entry.amount));
    } else {
      const bonus = p.kind === "bonus";
      // 旧形式は「総支給額」と「社会保険料」をまとめて持っている。新形式の科目名で
      // 集計すると支給合計が0になり、全額が差額に落ちて偽の警告が出てしまう。
      const legacy = !bonus && p.baseSalary === undefined && p.gross !== undefined;
      const earningFields = bonus ? PAYSLIP_BONUS_EARNING_FIELDS : PAYSLIP_SALARY_EARNING_FIELDS;
      const gross = legacy
        ? p.gross || 0
        : earningFields.reduce((sum, f) => sum + (p[f] || 0), 0);
      const insurance = legacy
        ? p.socialInsurance || 0
        : (p.healthInsurance || 0) +
          (p.nursingInsurance || 0) +
          (p.pensionInsurance || 0) +
          (p.employmentInsurance || 0) +
          (p.childSupportLevy || 0);
      const tax = (p.incomeTax || 0) + (p.residentTax || 0);
      const other = legacy ? 0 : p.otherDeductions || 0;

      lines.push(journalLine("debit", received, entry.amount));
      if (insurance > 0) lines.push(journalLine("debit", SOCIAL_INSURANCE_ACCOUNT, insurance));
      if (tax > 0) lines.push(journalLine("debit", TAX_ACCOUNT, tax));
      if (other > 0) lines.push(journalLine("debit", "その他支出", other));
      lines.push(journalLine("credit", entry.category, gross));

      if ((p.housing || 0) > 0) {
        notes.push(
          "寮社宅費は「受け取って払った」形にしているため、控除に立てず、" +
            "別の「住居」の支出として記録されています。"
        );
      }
    }
  }

  if (JOURNAL_NOTES[entry.category]) notes.push(JOURNAL_NOTES[entry.category]);

  // 貸借がずれるのは給与明細の内訳が支給合計と噛み合っていないときだけ。
  // 黙って捨てず、差額の科目を立てて表に出す (入力の間違いに気づける)。
  const debit = lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
  const credit = lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
  if (debit !== credit) {
    const diff = Math.abs(debit - credit);
    lines.push(journalLine(debit < credit ? "debit" : "credit", IMBALANCE_ACCOUNT, diff));
    notes.push(
      `給与明細の内訳が支給合計と ${formatYen(diff)} 合いません。内訳を確認してください。`
    );
  }

  return { id: entry.id, date: entry.date, memo: entry.memo || "", entry, lines, notes };
}

// 期間の記録を日付順の仕訳帳にする
function buildJournal(periodEntries) {
  return [...periodEntries]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map(journalFor);
}

// 合計試算表: 科目ごとの借方合計・貸方合計。全体の借方合計と貸方合計は
// 必ず一致する (貸借平均の原理)。
function buildTrialBalance(journal) {
  const rows = new Map();
  for (const je of journal) {
    for (const line of je.lines) {
      if (!rows.has(line.account)) {
        rows.set(line.account, { account: line.account, debit: 0, credit: 0 });
      }
      rows.get(line.account)[line.side] += line.amount;
    }
  }

  const order = { asset: 0, liability: 1, revenue: 2, expense: 3, other: 4 };
  const list = [...rows.values()].map((r) => ({ ...r, type: accountType(r.account) }));
  list.sort((a, b) => order[a.type] - order[b.type] || b.debit + b.credit - (a.debit + a.credit));

  return {
    rows: list,
    debitTotal: list.reduce((s, r) => s + r.debit, 0),
    creditTotal: list.reduce((s, r) => s + r.credit, 0),
  };
}

// 損益計算書: 収益 − 費用 = 当期純利益。
// 収益は貸方、費用は借方に立つので、それぞれ純額を取る。
function buildProfitAndLoss(journal) {
  const totals = new Map();
  for (const je of journal) {
    for (const line of je.lines) {
      const type = accountType(line.account);
      if (type !== "revenue" && type !== "expense") continue;
      const sign =
        type === "revenue"
          ? line.side === "credit" ? 1 : -1
          : line.side === "debit" ? 1 : -1;
      totals.set(line.account, (totals.get(line.account) || 0) + sign * line.amount);
    }
  }

  const pick = (type) =>
    [...totals.entries()]
      .filter(([account]) => accountType(account) === type)
      .map(([account, amount]) => ({ account, amount }))
      .filter((r) => r.amount !== 0)
      .sort((a, b) => b.amount - a.amount);

  const revenues = pick("revenue");
  const expenses = pick("expense");
  const revenueTotal = revenues.reduce((s, r) => s + r.amount, 0);
  const expenseTotal = expenses.reduce((s, r) => s + r.amount, 0);

  return { revenues, expenses, revenueTotal, expenseTotal, netIncome: revenueTotal - expenseTotal };
}

// --- 口座と期首残高 ---------------------------------------------------------
//
// 貸借対照表には残高が要るが、このアプリが持っているのは増減 (フロー) だけ。
// そこで期首残高を1回だけ入力してもらい、
//   残高 = 期首残高 + 期首日から表示中の期間末までの増減
// で出す。以降の入力は今までどおりで増えない。

// 期首残高を入れる口座。貯蓄・投資のカテゴリはそのまま資産の科目になる。
function balanceAccounts() {
  return [CASH_ACCOUNT, BANK_ACCOUNT, ...CATEGORIES.save, PAYABLE_ACCOUNT];
}

const DEFAULT_CARD_TERMS = { closingDay: 31, paymentDay: 26, paymentMonths: 1 };

function cardTerms() {
  return {
    closingDay: accountSettings.closingDay || DEFAULT_CARD_TERMS.closingDay,
    paymentDay: accountSettings.paymentDay || DEFAULT_CARD_TERMS.paymentDay,
    paymentMonths: accountSettings.paymentMonths || DEFAULT_CARD_TERMS.paymentMonths,
  };
}

function accountsConfigured() {
  return Boolean(accountSettings.openingDate);
}

// その月の日数に収める (31日締めを2月に当てると28日になる、など)
function clampDayToMonth(year, monthIndex, day) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return Math.min(day, lastDay);
}

/**
 * カード利用日から引き落とし日を出す。
 * 締め日までの利用はその月の締め、締め日を過ぎた利用は翌月の締めになり、
 * 締め月の paymentMonths か月後の支払日に引き落とされる。
 */
function cardPaymentDateFor(usageDate) {
  const { closingDay, paymentDay, paymentMonths } = cardTerms();
  const [y, m, d] = usageDate.split("-").map(Number);
  // 締め日はその月の末日を超えない (31日締め = 末日締め)
  const closing = clampDayToMonth(y, m - 1, closingDay);
  // 締め日を過ぎていたら次の締めに回る
  const closingMonthIndex = d <= closing ? m - 1 : m;
  const payMonth = new Date(y, closingMonthIndex + paymentMonths, 1);
  const day = clampDayToMonth(payMonth.getFullYear(), payMonth.getMonth(), paymentDay);
  return toDateInputValue(new Date(payMonth.getFullYear(), payMonth.getMonth(), day));
}

// 指定日以降で最初に来る支払日。期首時点で残っていた請求は、期首より前の利用
// (もう記録が無い) に対するものなので、締め日から遡って計算はできない。
// 「次に来る支払日に落ちる」とみなす。
function firstPaymentDateOnOrAfter(date) {
  const { paymentDay } = cardTerms();
  const [y, m, d] = date.split("-").map(Number);
  let year = y;
  let monthIndex = m - 1;
  let day = clampDayToMonth(year, monthIndex, paymentDay);
  if (day < d) {
    const next = new Date(year, monthIndex + 1, 1);
    year = next.getFullYear();
    monthIndex = next.getMonth();
    day = clampDayToMonth(year, monthIndex, paymentDay);
  }
  return toDateInputValue(new Date(year, monthIndex, day));
}

/**
 * カードの引き落としを仕訳として組み立てる。実際の記録は無く、締め日と支払日から
 * 導出する。これがないと銀行口座の残高がいつまでも減らない。
 *
 *   (借) 未払金 / (貸) 銀行口座
 *
 * 返金(カード返金)は未払金を減らすので、同じ支払日の利用から差し引く。
 */
function cardPaymentJournal(from, to) {
  const byDate = new Map();
  const openingDate = accountSettings.openingDate;

  for (const e of entries) {
    if (!isCardEntry(e)) continue;
    // 期首より前の利用の請求は、期首残高の未払金に含まれている。ここで拾うと
    // 「請求が立った仕訳は期間外なのに引き落としだけ立つ」形になり、
    // 同じ借金を二重に払ってしまう。
    if (openingDate && e.date < openingDate) continue;
    const payDate = cardPaymentDateFor(e.date);
    if (payDate < from || payDate > to) continue;
    // journalFor と揃える: 支出・貯蓄は未払金を増やし (貸方)、収入(返金)は減らす
    const delta = e.type === "income" ? -e.amount : e.amount;
    byDate.set(payDate, (byDate.get(payDate) || 0) + delta);
  }

  // 期首時点で残っていたカードの請求。記録が無いので、期首日以降で最初に来る
  // 支払日にまとめて引き落とされたものとして扱う。
  const opening = openingBalanceOf(PAYABLE_ACCOUNT);
  if (opening > 0 && openingDate) {
    const payDate = firstPaymentDateOnOrAfter(openingDate);
    if (payDate >= from && payDate <= to) {
      byDate.set(payDate, (byDate.get(payDate) || 0) + opening);
    }
  }

  const journal = [];
  for (const [date, amount] of [...byDate.entries()].sort()) {
    if (amount === 0) continue;
    const positive = amount > 0;
    journal.push({
      id: `card-payment-${date}`,
      date,
      memo: "カードの引き落とし",
      derived: true,
      entry: { category: PAYABLE_ACCOUNT, type: "expense" },
      lines: [
        journalLine(positive ? "debit" : "credit", PAYABLE_ACCOUNT, Math.abs(amount)),
        journalLine(positive ? "credit" : "debit", BANK_ACCOUNT, Math.abs(amount)),
      ],
      notes: [
        "締め日・支払日の設定から自動で立てている仕訳です (記録一覧には出ません)。" +
          (positive ? "" : "返金が利用額を上回ったため、口座に戻る形になっています。"),
      ],
    });
  }
  return journal;
}

function openingBalanceOf(account) {
  return (accountSettings.balances || {})[account] || 0;
}

/**
 * 表示中の期間の末日時点の貸借対照表。
 * 期首日から期間末までの全仕訳を集計し、期首残高に足す。
 */
function buildBalanceSheet(periodEnd) {
  const from = accountSettings.openingDate;
  const periodEntries = entries.filter((e) => e.date >= from && e.date <= periodEnd);
  const journal = [
    ...buildJournal(periodEntries),
    ...cardPaymentJournal(from, periodEnd),
  ];

  const change = new Map();
  for (const je of journal) {
    for (const line of je.lines) {
      const sign = line.side === "debit" ? 1 : -1;
      change.set(line.account, (change.get(line.account) || 0) + sign * line.amount);
    }
  }

  const rowFor = (account) => {
    const type = accountType(account);
    // 資産は借方残高、負債は貸方残高が「増えている」向き
    const delta = (change.get(account) || 0) * (type === "liability" ? -1 : 1);
    return { account, type, opening: openingBalanceOf(account), amount: openingBalanceOf(account) + delta };
  };

  const assets = [CASH_ACCOUNT, BANK_ACCOUNT, ...CATEGORIES.save]
    .map(rowFor)
    .filter((r) => r.amount !== 0 || r.opening !== 0);
  const liabilities = [PAYABLE_ACCOUNT].map(rowFor).filter((r) => r.amount !== 0 || r.opening !== 0);

  const assetTotal = assets.reduce((s, r) => s + r.amount, 0);
  const liabilityTotal = liabilities.reduce((s, r) => s + r.amount, 0);

  return {
    assets,
    liabilities,
    assetTotal,
    liabilityTotal,
    netAssets: assetTotal - liabilityTotal,
    periodEnd,
  };
}

// --- 帳簿の描画 -------------------------------------------------------------

let bookView = "bs";

// 表示中の期間の初日
function periodStartDate() {
  const y = currentMonth.getFullYear();
  if (viewMode === "year") return `${y}-01-01`;
  return toDateInputValue(new Date(y, currentMonth.getMonth(), 1));
}

// 表示中の期間の末日 (貸借対照表はこの時点の残高を出す)
function periodEndDate() {
  const y = currentMonth.getFullYear();
  if (viewMode === "year") return `${y}-12-31`;
  const last = new Date(y, currentMonth.getMonth() + 1, 0);
  return toDateInputValue(last);
}

function bookRow(label, amount, { total = false, muted = false } = {}) {
  const row = document.createElement("div");
  row.className = "book-row" + (total ? " total" : "") + (muted ? " muted" : "");
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "book-value";
  valueEl.textContent = formatYen(amount);
  row.append(labelEl, valueEl);
  return row;
}

function bookGroupLabel(text) {
  const el2 = document.createElement("div");
  el2.className = "book-group-label";
  el2.textContent = text;
  return el2;
}

function renderProfitAndLoss(container, journal) {
  const pl = buildProfitAndLoss(journal);
  if (pl.revenues.length === 0 && pl.expenses.length === 0) {
    container.appendChild(emptyMessage("この期間の記録がありません。"));
    return;
  }

  container.appendChild(bookGroupLabel("収益"));
  for (const r of pl.revenues) container.appendChild(bookRow(r.account, r.amount));
  container.appendChild(bookRow("収益合計", pl.revenueTotal, { total: true }));

  container.appendChild(bookGroupLabel("費用"));
  for (const r of pl.expenses) container.appendChild(bookRow(r.account, r.amount));
  container.appendChild(bookRow("費用合計", pl.expenseTotal, { total: true }));

  const net = bookRow("当期純利益", pl.netIncome, { total: true });
  net.classList.add("book-net", pl.netIncome >= 0 ? "positive" : "negative");
  container.appendChild(net);
}

function renderTrialBalance(container, journal) {
  const tb = buildTrialBalance(journal);
  if (tb.rows.length === 0) {
    container.appendChild(emptyMessage("この期間の記録がありません。"));
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";
  const table = document.createElement("table");
  table.className = "entry-table book-table";
  table.innerHTML =
    "<thead><tr>" +
    '<th class="amount-col">借方</th><th>勘定科目</th><th>区分</th><th class="amount-col">貸方</th>' +
    "</tr></thead>";

  const tbody = document.createElement("tbody");
  for (const row of tb.rows) {
    const tr = document.createElement("tr");
    const debit = document.createElement("td");
    debit.className = "amount-col";
    debit.textContent = row.debit ? formatYen(row.debit) : "";
    const account = document.createElement("td");
    account.textContent = row.account;
    const type = document.createElement("td");
    type.textContent = ACCOUNT_TYPE_LABELS[row.type];
    const credit = document.createElement("td");
    credit.className = "amount-col";
    credit.textContent = row.credit ? formatYen(row.credit) : "";
    tr.append(debit, account, type, credit);
    tbody.appendChild(tr);
  }

  const totalRow = document.createElement("tr");
  totalRow.className = "book-total-row";
  const dTotal = document.createElement("td");
  dTotal.className = "amount-col";
  dTotal.textContent = formatYen(tb.debitTotal);
  const label = document.createElement("td");
  label.textContent = "合計";
  label.colSpan = 2;
  const cTotal = document.createElement("td");
  cTotal.className = "amount-col";
  cTotal.textContent = formatYen(tb.creditTotal);
  totalRow.append(dTotal, label, cTotal);
  tbody.appendChild(totalRow);

  table.appendChild(tbody);
  wrapper.appendChild(table);
  container.appendChild(wrapper);

  // 貸借平均の原理。ここがずれるのは仕訳の作り方が壊れているときだけなので、
  // 一致していることを明示して確かめられるようにする。
  const check = document.createElement("p");
  const balanced = tb.debitTotal === tb.creditTotal;
  check.className = balanced ? "book-check ok" : "book-check ng";
  check.append(
    createIcon(balanced ? "check" : "triangle-alert"),
    balanced
      ? `借方合計と貸方合計が一致しています (${formatYen(tb.debitTotal)})`
      : `借方合計 ${formatYen(tb.debitTotal)} と貸方合計 ${formatYen(tb.creditTotal)} が一致しません`
  );
  container.appendChild(check);
}

function renderJournal(container, journal) {
  if (journal.length === 0) {
    container.appendChild(emptyMessage("この期間の記録がありません。"));
    return;
  }

  for (const je of journal) {
    const block = document.createElement("div");
    block.className = "journal-entry";

    const head = document.createElement("div");
    head.className = "journal-head";
    const [, m, d] = je.date.split("-");
    const dateEl = document.createElement("span");
    dateEl.className = "journal-date";
    dateEl.textContent = `${Number(m)}/${Number(d)}`;
    const memoEl = document.createElement("span");
    memoEl.className = "journal-memo";
    memoEl.textContent = je.memo || je.entry.category;
    head.append(dateEl, memoEl);
    if (isCardEntry(je.entry)) {
      const tag = document.createElement("span");
      tag.className = "journal-tag";
      tag.textContent = "カード";
      head.appendChild(tag);
    }
    block.appendChild(head);

    // 借方と貸方を左右に並べる。行数が違うことがあるので、多い方に合わせる
    const debits = je.lines.filter((l) => l.side === "debit");
    const credits = je.lines.filter((l) => l.side === "credit");
    const rows = Math.max(debits.length, credits.length);
    const grid = document.createElement("div");
    grid.className = "journal-lines";

    // 借方と貸方の境目は縦線ではなく見出しで示す
    for (const [side, text] of [["debit", "借方"], ["credit", "貸方"]]) {
      const label = document.createElement("span");
      label.className = `journal-column-label ${side}`;
      label.textContent = text;
      grid.append(label, document.createElement("span"));
    }

    for (let i = 0; i < rows; i++) {
      for (const [side, list] of [["debit", debits], ["credit", credits]]) {
        const line = list[i];
        const accountEl = document.createElement("span");
        accountEl.className = `journal-account ${side}`;
        accountEl.textContent = line ? line.account : "";
        const amountEl = document.createElement("span");
        amountEl.className = `journal-amount ${side}`;
        amountEl.textContent = line ? formatYen(line.amount) : "";
        grid.append(accountEl, amountEl);
      }
    }
    block.appendChild(grid);

    for (const note of je.notes) {
      const noteEl = document.createElement("p");
      noteEl.className = "journal-note";
      noteEl.textContent = note;
      block.appendChild(noteEl);
    }

    container.appendChild(block);
  }
}

function emptyMessage(text) {
  const p = document.createElement("p");
  p.className = "empty-message";
  p.textContent = text;
  return p;
}

function renderBalanceSheet(container, periodEnd) {
  if (!accountsConfigured()) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent =
      "貸借対照表を出すには、期首日とその日の残高が必要です。" +
      "右上の「口座を設定」から1回だけ入力してください。";
    container.appendChild(p);
    return;
  }

  // 期首より前の期間を表示しているときは残高を出せない。期首残高をそのまま
  // 見せると「その時点の残高」に見えてしまうので、何も出さずに理由を伝える。
  if (periodEnd < accountSettings.openingDate) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent =
      `期首日 (${formatDateLabel(accountSettings.openingDate)}) より前の残高は分かりません。` +
      "これより前も見たい場合は、口座の設定で期首日を早めてください。";
    container.appendChild(p);
    return;
  }

  const bs = buildBalanceSheet(periodEnd);

  container.appendChild(bookGroupLabel("資産の部"));
  for (const row of bs.assets) container.appendChild(bookRow(row.account, row.amount));
  container.appendChild(bookRow("資産合計", bs.assetTotal, { total: true }));

  container.appendChild(bookGroupLabel("負債の部"));
  if (bs.liabilities.length === 0) {
    container.appendChild(bookRow("(負債なし)", 0, { muted: true }));
  } else {
    for (const row of bs.liabilities) container.appendChild(bookRow(row.account, row.amount));
  }
  container.appendChild(bookRow("負債合計", bs.liabilityTotal, { total: true }));

  container.appendChild(bookGroupLabel("純資産の部"));
  const net = bookRow("純資産 (資産 − 負債)", bs.netAssets, { total: true });
  net.classList.add("book-net", bs.netAssets >= 0 ? "positive" : "negative");
  container.appendChild(net);

  const asOf = document.createElement("p");
  asOf.className = "book-check";
  asOf.textContent =
    `${formatDateLabel(accountSettings.openingDate)}の残高に、` +
    `${formatDateLabel(bs.periodEnd)}までの増減を足したものです。`;
  container.appendChild(asOf);

  // 銀行アプリの残高と合わないときは記録漏れがある、と気づけるようにする
  const hint = document.createElement("p");
  hint.className = "book-check";
  hint.textContent =
    "実際の残高と合わない場合は、記録していない支出・収入があります。";
  container.appendChild(hint);
}

const BOOK_NOTES = {
  bs:
    "資産 − 負債 = 純資産。期首残高に、そのあとの記録による増減を足して出しています。" +
    "カード利用は支払日が来るまで「未払金」(負債) として残り、支払日に銀行口座から" +
    "引き落とされたものとして扱います。",
  pl:
    "収益 − 費用 = 当期純利益。貯蓄・投資は費用ではなく資産への振替なので入りません。" +
    "給与は総支給を収益に立て、社会保険料 (法定福利費) と税金 (租税公課) を費用にしています。" +
    "当期純利益は上の「収支」と同じ金額になります。",
  trial:
    "科目ごとの借方合計と貸方合計。全体の借方合計と貸方合計は必ず一致します (貸借平均の原理)。" +
    "残高ではなく、この期間に動いた金額の合計です。",
  journal:
    "1件ずつを借方 / 貸方の形にしたものです。カード払いは現金がまだ出ていかないので、" +
    "貸方が「未払金」(負債) になります。",
};

function renderBookkeeping(periodEntries) {
  // カードの引き落としは記録ではなく設定から導出するので、ここで足す。
  // これを入れないと銀行口座の残高が減らず、試算表にも出てこない。
  const journal = [...buildJournal(periodEntries)];
  if (accountsConfigured()) {
    journal.push(...cardPaymentJournal(periodStartDate(), periodEndDate()));
    journal.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  const body = el.bookkeepingBody;
  body.innerHTML = "";

  if (bookView === "bs") renderBalanceSheet(body, periodEndDate());
  else if (bookView === "pl") renderProfitAndLoss(body, journal);
  else if (bookView === "trial") renderTrialBalance(body, journal);
  else renderJournal(body, journal);

  el.bookkeepingNote.textContent = BOOK_NOTES[bookView];
}

// --- 口座設定フォーム -------------------------------------------------------

// 締め日・支払日の選択肢。31日は「末日」として扱う (その月の末日に丸める)
function fillDayOptions(select, { lastDayLabel } = {}) {
  select.innerHTML = "";
  for (let day = 1; day <= 31; day++) {
    const option = document.createElement("option");
    option.value = String(day);
    option.textContent = day === 31 && lastDayLabel ? "末日" : `${day}日`;
    select.appendChild(option);
  }
}

function renderAccountsForm() {
  el.accountsInputs.innerHTML = "";
  const balances = accountSettings.balances || {};

  for (const account of balanceAccounts()) {
    const group = document.createElement("div");
    group.className = "form-group";

    const label = document.createElement("label");
    label.htmlFor = `account-input-${account}`;
    label.textContent = account === PAYABLE_ACCOUNT ? `${account} (カードの未払い分)` : account;

    const input = document.createElement("input");
    input.type = "number";
    input.id = `account-input-${account}`;
    input.dataset.account = account;
    input.min = "0";
    input.step = "1";
    input.placeholder = "0";
    if (balances[account] > 0) input.value = balances[account];

    group.append(label, input);
    el.accountsInputs.appendChild(group);
  }

  el.accountsOpeningDate.value =
    accountSettings.openingDate || toDateInputValue(new Date(new Date().getFullYear(), 0, 1));

  const terms = cardTerms();
  fillDayOptions(el.cardClosingDay, { lastDayLabel: true });
  fillDayOptions(el.cardPaymentDay);
  el.cardClosingDay.value = String(terms.closingDay);
  el.cardPaymentDay.value = String(terms.paymentDay);
  el.cardPaymentMonths.value = String(terms.paymentMonths);
}

function openAccountsForm() {
  renderAccountsForm();
  el.accountsForm.classList.remove("hidden");
  el.editAccountsBtn.classList.add("hidden");
}

function closeAccountsForm() {
  el.accountsForm.classList.add("hidden");
  el.editAccountsBtn.classList.remove("hidden");
}

async function submitAccountsForm(event) {
  event.preventDefault();

  const openingDate = el.accountsOpeningDate.value;
  if (!openingDate) {
    alert("期首日を入れてください。");
    return;
  }

  const balances = {};
  for (const input of el.accountsInputs.querySelectorAll("input[data-account]")) {
    const value = Math.floor(Number(input.value)) || 0;
    if (value > 0) balances[input.dataset.account] = value;
  }

  try {
    await saveAccountSettingsToDb({
      openingDate,
      balances,
      closingDay: Number(el.cardClosingDay.value),
      paymentDay: Number(el.cardPaymentDay.value),
      paymentMonths: Number(el.cardPaymentMonths.value),
    });
  } catch (err) {
    alert("口座の設定の保存に失敗しました: " + err.message);
    return;
  }
  closeAccountsForm();
}

function setupBookTabs() {
  for (const tab of el.bookTabs) {
    tab.addEventListener("click", () => {
      bookView = tab.dataset.book;
      for (const t of el.bookTabs) {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
      }
      render();
    });
  }
}

function payslipModalRow(label, amount, { total = false } = {}) {
  const row = document.createElement("div");
  row.className = total ? "payslip-modal-row total" : "payslip-modal-row";

  const labelEl = document.createElement("span");
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "payslip-modal-value";
  valueEl.textContent = formatYen(amount);

  row.append(labelEl, valueEl);
  return row;
}

function payslipModalGroupLabel(text) {
  const label = document.createElement("p");
  label.className = "payslip-modal-group-label";
  label.textContent = text;
  return label;
}

// 給与明細の内訳をポップアップで表示する
function showPayslipDetailModal(entry) {
  const p = entry.payslip;
  el.payslipDetailContent.innerHTML = "";

  if (p.kind === "bonus") {
    const gross = PAYSLIP_BONUS_EARNING_FIELDS.reduce((sum, field) => sum + (p[field] || 0), 0);
    const deductions = PAYSLIP_BONUS_DEDUCTION_FIELDS.reduce((sum, field) => sum + (p[field] || 0), 0);

    el.payslipDetailContent.append(
      payslipModalGroupLabel("支給"),
      payslipModalRow("賞与額", p.bonusAmount || 0),
      payslipModalRow("支給合計", gross, { total: true }),
      payslipModalGroupLabel("控除"),
      payslipModalRow("寮社宅費", p.housing || 0),
      payslipModalRow("健康保険", p.healthInsurance || 0),
      payslipModalRow("介護保険", p.nursingInsurance || 0),
      payslipModalRow("子ども支援金", p.childSupportLevy || 0),
      payslipModalRow("厚生年金", p.pensionInsurance || 0),
      payslipModalRow("雇用保険料", p.employmentInsurance || 0),
      payslipModalRow("所得税", p.incomeTax || 0),
      payslipModalRow("控除合計", deductions, { total: true }),
      payslipModalRow("差引支給額(手取り)", entry.amount, { total: true })
    );
  } else if (p.baseSalary !== undefined) {
    const gross = PAYSLIP_SALARY_EARNING_FIELDS.reduce((sum, field) => sum + (p[field] || 0), 0);
    const deductions = PAYSLIP_SALARY_DEDUCTION_FIELDS.reduce((sum, field) => sum + (p[field] || 0), 0);

    el.payslipDetailContent.append(
      payslipModalGroupLabel("支給"),
      payslipModalRow("本給", p.baseSalary || 0),
      payslipModalRow("勤務地手当", p.locationAllowance || 0),
      payslipModalRow("通勤手当", p.commute || 0),
      payslipModalRow("時間外勤務手当", p.overtimePay || 0),
      payslipModalRow("給与調整", p.salaryAdjustment || 0),
      payslipModalRow("支給合計", gross, { total: true }),
      payslipModalGroupLabel("控除"),
      payslipModalRow("寮社宅費", p.housing || 0),
      payslipModalRow("健康保険", p.healthInsurance || 0),
      payslipModalRow("介護保険", p.nursingInsurance || 0),
      payslipModalRow("厚生年金", p.pensionInsurance || 0),
      payslipModalRow("雇用保険料", p.employmentInsurance || 0),
      payslipModalRow("所得税", p.incomeTax || 0),
      payslipModalRow("住民税", p.residentTax || 0),
      payslipModalRow("その他控除", p.otherDeductions || 0),
      payslipModalRow("控除合計", deductions, { total: true }),
      payslipModalRow("差引支給額(振込額)", gross - deductions, { total: true })
    );

    // 家賃は「受け取って払った」形にしているため、記録の金額は振込額と違う。
    // どういう内訳でそうなっているのかを添える
    const housing = p.housing || 0;
    if (housing > 0) {
      el.payslipDetailContent.append(
        payslipModalRow("寮社宅費 (支出・住居として別に記録)", housing),
        payslipModalRow("この記録の金額", entry.amount, { total: true })
      );
    }
  } else {
    // 旧形式(総支給額・社会保険料まとめ)で保存された記録との互換表示
    el.payslipDetailContent.append(
      payslipModalRow("総支給額", p.gross || 0),
      ...(p.commute ? [payslipModalRow("うち交通費", p.commute)] : []),
      payslipModalRow("所得税", p.incomeTax || 0),
      payslipModalRow("住民税", p.residentTax || 0),
      payslipModalRow("社会保険料", p.socialInsurance || 0),
      payslipModalRow("手取り", entry.amount, { total: true })
    );
  }

  openModal(el.payslipDetailModal, el.payslipDetailClose);
}

function hidePayslipDetailModal() {
  closeModal(el.payslipDetailModal);
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

const PAYSLIP_SALARY_INPUT_MAP = {
  baseSalary: () => el.payslipBaseSalary,
  locationAllowance: () => el.payslipLocationAllowance,
  salaryAdjustment: () => el.payslipSalaryAdjustment,
  commute: () => el.payslipCommute,
  overtimePay: () => el.payslipOvertimePay,
  housing: () => el.payslipHousing,
  healthInsurance: () => el.payslipHealthInsurance,
  nursingInsurance: () => el.payslipNursingInsurance,
  pensionInsurance: () => el.payslipPensionInsurance,
  employmentInsurance: () => el.payslipEmploymentInsurance,
  incomeTax: () => el.payslipIncomeTax,
  residentTax: () => el.payslipResidentTax,
  otherDeductions: () => el.payslipOtherDeductions,
};

const PAYSLIP_BONUS_INPUT_MAP = {
  bonusAmount: () => el.payslipBonusAmount,
  healthInsurance: () => el.payslipBonusHealthInsurance,
  nursingInsurance: () => el.payslipBonusNursingInsurance,
  childSupportLevy: () => el.payslipBonusChildSupport,
  pensionInsurance: () => el.payslipBonusPensionInsurance,
  employmentInsurance: () => el.payslipBonusEmploymentInsurance,
  incomeTax: () => el.payslipBonusIncomeTax,
};

// 種別が「収入」・カテゴリが「賞与」のときは賞与明細用の内訳、それ以外(給与)は通常の給与明細用の内訳
function payslipMode() {
  return el.entryCategory.value === BONUS_CATEGORY ? "bonus" : "salary";
}

function payslipEarningFields(mode) {
  return mode === "bonus" ? PAYSLIP_BONUS_EARNING_FIELDS : PAYSLIP_SALARY_EARNING_FIELDS;
}

function payslipDeductionFields(mode) {
  return mode === "bonus" ? PAYSLIP_BONUS_DEDUCTION_FIELDS : PAYSLIP_SALARY_DEDUCTION_FIELDS;
}

function payslipInputEl(field, mode) {
  return (mode === "bonus" ? PAYSLIP_BONUS_INPUT_MAP : PAYSLIP_SALARY_INPUT_MAP)[field]();
}

function payslipFieldValue(field, mode) {
  return Math.floor(Number(payslipInputEl(field, mode).value)) || 0;
}

function computePayslipTotals() {
  const mode = payslipMode();
  const gross = payslipEarningFields(mode).reduce(
    (sum, field) => sum + payslipFieldValue(field, mode),
    0
  );
  const deductions = payslipDeductionFields(mode).reduce(
    (sum, field) => sum + payslipFieldValue(field, mode),
    0
  );
  const net = Math.max(0, gross - deductions);

  // 家賃 (寮社宅費) は税金や社会保険料と違い、「生活に使ったお金」。
  // 控除に含めたまま手取りだけを収入にすると、住居の予算にも
  // Need/Want/Save にも家賃が出てこなくなり、天引きになる前の月と
  // 数字が地続きでなくなる。
  // そこで「受け取って、家賃として払った」形にする:
  //   収入 = 振込額 + 家賃 / 支出 = 家賃  (収支は振込額のまま正しい)
  const housing = mode === "salary" ? payslipFieldValue("housing", mode) : 0;
  return { gross, deductions, net, housing, incomeAmount: net + housing };
}

function updatePayslipPreview() {
  const { gross, deductions, net, housing, incomeAmount } = computePayslipTotals();
  el.payslipGrossValue.textContent = formatYen(gross);
  el.payslipDeductionValue.textContent = formatYen(deductions);
  el.payslipNetValue.textContent = formatYen(net);
  el.entryAmount.value = incomeAmount;

  // 家賃があるときは、金額欄が振込額と違う理由をその場で示す
  el.payslipHousingNote.classList.toggle("hidden", housing <= 0);
  if (housing > 0) {
    el.payslipHousingNote.textContent =
      `寮社宅費 ${formatYen(housing)} は「支出・住居」として自動で記録します。` +
      `そのため上の「金額」には ${formatYen(incomeAmount)} (振込額 + 寮社宅費) が入ります。`;
  }
}

function openPayslipBreakdown() {
  el.payslipBreakdown.classList.remove("hidden");
  el.payslipToggleBtn.classList.add("hidden");
  el.entryAmount.readOnly = true;
  updatePayslipPreview();
}

function allPayslipInputEls() {
  return [
    ...Object.values(PAYSLIP_SALARY_INPUT_MAP).map((getEl) => getEl()),
    ...Object.values(PAYSLIP_BONUS_INPUT_MAP).map((getEl) => getEl()),
  ];
}

function closePayslipBreakdown({ clearValues = true } = {}) {
  el.payslipBreakdown.classList.add("hidden");
  el.payslipToggleBtn.classList.remove("hidden");
  el.entryAmount.readOnly = false;
  if (clearValues) {
    for (const input of allPayslipInputEls()) input.value = "";
  }
}

// 種別が「収入」・カテゴリが「給与」または「賞与」のときだけ内訳入力欄を出す
function updatePayslipVisibility() {
  const isPayslipCategory =
    selectedType() === "income" &&
    (el.entryCategory.value === PAYSLIP_CATEGORY || el.entryCategory.value === BONUS_CATEGORY);
  el.payslipSection.classList.toggle("hidden", !isPayslipCategory);
  closePayslipBreakdown();
  if (!isPayslipCategory) return;

  const mode = payslipMode();
  el.payslipSalaryFields.classList.toggle("hidden", mode !== "salary");
  el.payslipBonusFields.classList.toggle("hidden", mode !== "bonus");
  el.payslipToggleBtn.textContent =
    mode === "bonus"
      ? "賞与明細の内訳を入力する(支給・控除の内訳から手取りを自動計算)"
      : "給与明細の内訳を入力する(支給・控除の内訳から手取りを自動計算)";
}

// 立替払いのチェックボックスは「支出」のときだけ出す
function updateAdvanceVisibility() {
  const isExpense = selectedType() === "expense";
  el.advanceToggle.classList.toggle("hidden", !isExpense);
  if (!isExpense) el.entryAdvance.checked = false;
}

// 内訳が入力されていれば payslip オブジェクトを、入力されていなければ null を返す
function buildPayslipData() {
  if (el.payslipBreakdown.classList.contains("hidden")) return null;
  const mode = payslipMode();
  const payslip = { kind: mode };
  for (const field of [...payslipEarningFields(mode), ...payslipDeductionFields(mode)]) {
    payslip[field] = payslipFieldValue(field, mode);
  }
  const gross = payslipEarningFields(mode).reduce((sum, field) => sum + payslip[field], 0);
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

// 保存は開いた時点の値で全置換するため、開いている間に別の端末で変更されると
// その変更を消してしまう。フォームを開いた時点の内容を控えておき、
// 保存直前に変わっていないか確かめる。
let budgetSnapshotOnOpen = null;
let incomeBudgetSnapshotOnOpen = null;

function settingsChangedSinceOpen(snapshot, current) {
  if (!snapshot) return false;
  return JSON.stringify(snapshot) !== JSON.stringify(current);
}

function confirmOverwriteIfChanged(snapshot, current, label) {
  if (!settingsChangedSinceOpen(snapshot, current)) return true;
  return confirm(
    `このフォームを開いてから、別の端末で${label}が変更されました。\n` +
      "このまま保存すると、その変更は上書きされます。よろしいですか?"
  );
}

function openBudgetForm() {
  renderBudgetInputs();
  budgetSnapshotOnOpen = { ...budgets };
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

  if (!confirmOverwriteIfChanged(budgetSnapshotOnOpen, budgets, "予算")) return;

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
  // 賞与は下のボーナス設定で、立替金返金は精算時に自動作成されるため、どちらも除外
  for (const category of incomeBudgetCategories()) {
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
  incomeBudgetSnapshotOnOpen = { ...incomeBudgets };
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

  if (!confirmOverwriteIfChanged(incomeBudgetSnapshotOnOpen, incomeBudgets, "収入目標")) return;

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

// 支出はふだん現金、収入と貯蓄は口座を通ることが多いので、種別に合わせて
// 初期値を変える。カード払いは取り込みで自動判別されるのでここには出さない。
function defaultSettlementFor(type) {
  return type === "expense" ? "cash" : "bank";
}

function resetForm() {
  // 編集ポップアップを開いたままだと、追加用のフォームが行方不明になる
  closeEntryEditModal();
  el.entryId.value = "";
  el.form.reset();
  el.entryDate.value = toDateInputValue(new Date());
  el.entrySettlement.value = defaultSettlementFor("expense");
  renderCategoryOptions("expense");
  updatePayslipVisibility();
  updateAdvanceVisibility();
  el.submitBtn.textContent = "追加";
  el.cancelEditBtn.classList.add("hidden");
}

function startEdit(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  // 中身を書き換えると高さが変わるので、まず今の高さを確保し、
  // 閉じたときに戻る位置の目印としてこの行を覚えておく
  reserveEntryFormHeight();
  rememberEditAnchor(id);

  el.entryId.value = entry.id;
  el.entryDate.value = entry.date;
  document.querySelector(
    `input[name="entry-type"][value="${entry.type}"]`
  ).checked = true;
  renderCategoryOptions(entry.type, entry.category);
  el.entryAmount.value = entry.amount;
  el.entryMemo.value = entry.memo || "";
  el.entrySettlement.value = entry.settlement || defaultSettlementFor(entry.type);

  updatePayslipVisibility();
  updateAdvanceVisibility();
  el.entryAdvance.checked = entry.advance === true;
  if (entry.payslip) {
    // 旧形式(kindなし)は給与用の内訳として復元する
    const mode = entry.payslip.kind === "bonus" ? "bonus" : "salary";
    for (const field of [...payslipEarningFields(mode), ...payslipDeductionFields(mode)]) {
      payslipInputEl(field, mode).value = entry.payslip[field] || "";
    }
    openPayslipBreakdown();
    el.entryAmount.value = entry.amount;
  }

  el.submitBtn.textContent = "更新";
  el.cancelEditBtn.classList.remove("hidden");
  // 一覧まで戻らずに直せるよう、その場でポップアップとして開く。
  // 見出し (#form-title) は追加用のフォームのものなので触らない
  openEntryEditModal();
}

async function deleteEntry(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  const label = `${entry.date} ${entry.category} ${formatYen(entry.amount)}`;

  // 精算済みの立替を消すと、対になる返金の収入だけが残って累計貯金額が
  // 永久にずれるため、返金もまとめて消す。給与と、そこから天引きされた
  // 家賃の支出も同じ関係にある。
  const refund = entry.advance === true ? refundsByAdvanceId().get(entry.id) : null;
  const housing = housingEntryFor(entry.id);
  const linked = [refund, housing].filter(Boolean);
  const message = linked.length
    ? `この記録を削除しますか?\n${label}\n\n` +
      `対になる記録も一緒に削除されます。\n` +
      linked.map((e) => `${e.date} ${e.category} ${formatYen(e.amount)}`).join("\n")
    : `この記録を削除しますか?\n${label}`;
  if (!confirm(message)) return;

  // 2件消す場合、片方だけ成功して終わることがある。何が残っているかを
  // 伝えないと、ユーザーは「何も起きなかった」と思って先に進んでしまう。
  let linkedDeleted = 0;
  try {
    for (const e of linked) {
      await deleteEntryFromDb(e.id);
      linkedDeleted++;
    }
    await deleteEntryFromDb(id);
  } catch (err) {
    alert(
      "削除に失敗しました: " +
        err.message +
        (linkedDeleted > 0
          ? `\n\n対になる記録 ${linkedDeleted}件 は削除済みで、この記録が残っています。` +
            "もう一度削除してください。"
          : "")
    );
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

  const type = selectedType();
  const data = {
    date: el.entryDate.value,
    type,
    category: el.entryCategory.value,
    amount,
    memo: el.entryMemo.value.trim(),
    payslip: buildPayslipData(),
    // 立替払いは支出のときだけ。編集でチェックを外した場合に確実に消えるよう
    // false も明示的に書き込む (updateDoc は指定したキーしか更新しないため)
    advance: type === "expense" && el.entryAdvance.checked,
    // 現金と銀行口座のどちらが動いたか (貸借対照表の残高に効く)。
    // カード払いはメール・カードCSVからの取り込みで自動判別するので、
    // 手入力のこの欄はカード以外を選ぶためのもの。
    settlement: el.entrySettlement.value,
  };

  const editingId = el.entryId.value;

  // 立替のチェックを外す / 種別を支出以外に変えると未回収リストから消えるが、
  // 対になる返金の収入が残ると累計貯金額がずれるため、一緒に消すか確認する。
  let refundToDelete = null;
  if (editingId && !data.advance) {
    const refund = refundsByAdvanceId().get(editingId);
    if (refund) {
      const ok = confirm(
        "この記録は精算済みの立替金です。立替でなくすと、対になる返金の記録も削除されます。\n\n" +
          `${refund.date} ${refund.category} ${formatYen(refund.amount)}\n\nよろしいですか?`
      );
      if (!ok) return;
      refundToDelete = refund;
    }
  }

  el.submitBtn.disabled = true;
  // 更新が通ったあとに返金の削除だけ失敗すると、記録自体は保存済みなのに
  // 「保存に失敗しました」と出て、ユーザーは更新されていないと誤解する。
  // どこまで完了したかを分けて扱う。
  let entrySaved = false;
  try {
    if (editingId) {
      // 登録日 (createdAt) は最初に記録したときのものを保つため、更新時は触らない
      await updateEntryInDb(editingId, data);
      entrySaved = true;
      if (refundToDelete) await deleteEntryFromDb(refundToDelete.id);
      await syncPayslipHousingEntry(editingId, data);
    } else {
      const newId = await addEntryToDb({
        ...data,
        source: SOURCE_MANUAL,
        createdAt: nowTimestamp(),
      });
      entrySaved = true;
      if (newId) await syncPayslipHousingEntry(newId, data);
    }
  } catch (err) {
    if (entrySaved) {
      // 記録自体は保存済み。残っている問題だけを伝えてフォームは通常どおり閉じる
      alert(
        "記録は保存できましたが、対になる記録の作成・削除に失敗しました: " +
          err.message +
          "\n\n記録一覧を確認し、必要なら手動で直してください。" +
          "(返金の収入や、給与から天引きされた家賃の支出が対象です)"
      );
    } else {
      alert("保存に失敗しました: " + err.message);
      el.submitBtn.disabled = false;
      return;
    }
  } finally {
    el.submitBtn.disabled = false;
  }

  // ポップアップから編集していたか (resetForm でフォームが元に戻る前に見る)
  const wasModalEdit = Boolean(editingId) && entryFormIsInModal();

  resetForm();

  // 追加・更新した記録の月を表示する
  currentMonth = startOfMonth(new Date(data.date + "T00:00:00"));
  render();

  // render() で一覧が作り直され、フォーカスを戻した「編集」ボタンごと
  // 消えてしまうため、作り直された同じ行のボタンへ改めて戻す。
  // preventScroll: ポップアップだったので画面は動いていない
  if (wasModalEdit) {
    const selector = `#entry-list [data-edit-id="${CSS.escape(editingId)}"]`;
    document.querySelector(selector)?.focus({ preventScroll: true });
  }
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

/**
 * Claude などに読ませて分析してもらうためのエクスポート。
 *
 * CSVは5列しかないため、予算・収入目標・立替・給与明細の内訳が落ちてしまう。
 * それらを含めて1ファイルにまとめる。
 *
 * 合わせて「読み方」も書き出す。このアプリは貯蓄を中立に扱う・返金を収入に
 * 数えないなど独自の集計ルールがあり、それを知らずに素の記録から集計すると
 * アプリの画面と違う数字が出てしまうため。
 */
function exportForAnalysis() {
  if (entries.length === 0) {
    alert("エクスポートする記録がありません。");
    return;
  }

  const data = {
    generatedAt: nowTimestamp(),
    app: "My-Expense-app (家計簿)",
    currency: "JPY",

    howToRead: {
      種別: "expense=支出 / income=収入 / save=貯蓄・投資",
      貯蓄の扱い:
        "save は現金が資産に形を変えただけなので支出に数えない。" +
        "収支も累計貯金額も動かさない (中立)",
      収支: "その月の income の合計 − expense の合計",
      累計貯金額: "全期間の収支の合計",
      返金の扱い:
        "カテゴリ「立替金返金」「カード返金」は、払ったお金が戻ってきただけで" +
        "稼いだお金ではない。収入目標の達成率と Need/Want/Save の収入には数えない。" +
        "ただし収支の相殺のため、月の収入合計には含める",
      立替金:
        "advance:true の支出は「自分が先に払って後で返金されるお金」。" +
        "通常の支出として計上し、返金時に advanceRefundFor で紐づく収入で相殺する。" +
        "対応する返金が無いものが未回収",
      給与の金額:
        "payslip がある収入の amount は手取り。ただし payslip.housing (寮社宅費) が" +
        "ある場合は「手取り + 寮社宅費」で、同額が payslipHousingFor で紐づく" +
        "「住居」の支出として別に記録されている (家賃を両側に立てている)",
      予算の按分:
        "budgets は月額。年間で見るときは、今年なら経過した月数を掛ける。" +
        "過去の年・未来の年は12を掛ける",
      予算バー:
        "分子は予算を設定したカテゴリの支出だけ。予算を設定していない" +
        "カテゴリの支出は「予算外」として別に見せている",
      賞与の目標:
        "incomeBudgets.bonusMonths の月に、給与の bonusMultiplier か月分を上乗せする。" +
        "年間で見るときは到来済みのボーナス月の分だけ加算する",
      登録日: "createdAt は取引日ではなく、記入・インポートした日時",
      決済手段:
        "settlement は現金(cash)か銀行口座(bank)か。source が gmail/card の記録は" +
        "カード払いなので settlement によらず未払金(負債)として扱う。" +
        "settlement が無いのは、この区別を入れる前に登録した古い記録",
      残高:
        "accounts.balances は期首(accounts.openingDate)時点の残高。" +
        "そこに記録による増減を足したものが貸借対照表の残高になる",
      取り込み元:
        "source は記録の出どころ。gmail はカードの利用通知メールから取り込んだ" +
        "未確定(仮)で、確定時に金額や日付が変わることがある。card はカード" +
        "利用履歴CSVから取り込んだ確定版。manual は手入力(現金・その他)。" +
        "source が無いのは、この区別を入れる前に登録した古い記録",

    },

    categories: CATEGORIES,
    needWantSave: {
      need: NEED_CATEGORIES,
      want: WANT_CATEGORIES,
      targetRatio: NWS_TARGET_RATIO,
      説明:
        "収入を基準に Need 50% / Want 30% / Save 20% を目安にする。" +
        "Save の実績は 収入 − Need − Want (実際に残った金額)",
    },

    budgets,
    incomeBudgets,
    accounts: accountSettings,

    entries: [...entries]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((e) => ({
        date: e.date,
        type: e.type,
        category: e.category,
        amount: e.amount,
        memo: e.memo || "",
        ...(e.advance === true ? { advance: true } : {}),
        ...(e.advanceRefundFor ? { advanceRefundFor: e.advanceRefundFor } : {}),
        ...(e.payslipHousingFor ? { payslipHousingFor: e.payslipHousingFor } : {}),
        ...(e.payslip ? { payslip: e.payslip } : {}),
        ...(e.createdAt ? { createdAt: e.createdAt } : {}),
        ...(e.source ? { source: e.source } : {}),
        ...(e.settlement ? { settlement: e.settlement } : {}),
        id: e.id,
      })),
  };

  downloadFile(
    JSON.stringify(data, null, 2),
    `kakeibo_analysis_${toDateInputValue(new Date())}.json`,
    "application/json;charset=utf-8"
  );
}

function downloadFile(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  downloadFile(
    "\uFEFF" + lines.join("\r\n"),
    `kakeibo_${toDateInputValue(new Date())}.csv`,
    "text/csv;charset=utf-8"
  );
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

// 種別ごとの「分類できなかったとき」の受け皿
const FALLBACK_CATEGORY = {
  expense: "その他支出",
  income: "その他収入",
  save: "その他貯蓄",
};

function resolveCategory(rawCategory, type) {
  const trimmed = String(rawCategory ?? "").trim();
  if (CATEGORIES[type].includes(trimmed)) return trimmed;
  // 貯蓄には読み替え表がないため、存在しないキーで落ちないようにする
  const alias = CATEGORY_ALIASES[type]?.[trimmed];
  if (alias) return alias;
  return FALLBACK_CATEGORY[type] || "その他支出";
}

/**
 * 「日付,種別,カテゴリ,金額,メモ」の縦持ち形式 (エクスポート形式と同じ) を解析する。
 */
function parseSimpleFormat(rows) {
  let start = 0;
  if (normalizeDate(rows[0][0]) === null) start = 1; // 先頭行がヘッダーならスキップ

  const imported = [];
  const errors = [];
  // 読み替えられたカテゴリ (元の名前 -> 変換後)。大量に潰れたときに気づけるよう、
  // 確認ダイアログで知らせる
  const convertedCategories = new Map();

  for (let i = start; i < rows.length; i++) {
    const cols = rows[i];
    const lineNo = i + 1;
    const date = normalizeDate(cols[0] ?? "");
    const type = parseType(cols[1] ?? "");
    const rawCategory = String(cols[2] ?? "").trim();
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
    if (!rawCategory) {
      errors.push(`${lineNo}行目: カテゴリが空です`);
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`${lineNo}行目: 金額を認識できません (${cols[3] ?? ""})`);
      continue;
    }

    // 他の形式と同じくアプリのカテゴリに解決する。既知のカテゴリはそのまま通るので、
    // 自分でエクスポートしたCSVの往復は壊れない。
    // (生の文字列のまま保存すると、予算と紐づかない・絞り込みに出ない・
    //  編集画面の<select>が先頭にフォールバックして無言で「食費」に化ける)
    const category = resolveCategory(rawCategory, type);
    if (category !== rawCategory) convertedCategories.set(rawCategory, category);
    imported.push({ date, type, category, amount, memo });
  }

  return { imported, errors, convertedCategories };
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
  // 日付のない行(合計行・小計行)に書かれた金額。どれが全体の合計かは
  // ファイル次第なので、最後に現れたものを全体の合計とみなす。
  let expectedTotal = null;
  // 取り込む金額(利用金額)の符号つき合計。CSVの合計行と同じ土俵で比べる。
  let parsedTotal = 0;
  // 分割払い・リボ払いの行があるか。ある場合、CSVの合計行は「今回支払金額」の
  // 合計なので、取り込む「利用金額」の合計とは原理的に一致しない。
  let hasInstallment = false;

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const lineNo = i + 1;
    const dateRaw = String(cols[0] ?? "").trim();
    if (!dateRaw) {
      const totalCandidate = parseCsvAmount(cols[5]);
      if (Number.isFinite(totalCandidate) && totalCandidate !== 0) {
        expectedTotal = totalCandidate;
      }
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
    if (!Number.isFinite(amount) || amount === 0) {
      errors.push(`${lineNo}行目: 金額を認識できません (${cols[2] ?? ""})`);
      continue;
    }

    // 支払回数が2回以上なら分割払い。CSVの合計行と噛み合わなくなる印
    const installments = parseCsvAmount(toHalfWidthAscii(String(cols[3] ?? "")));
    if (Number.isFinite(installments) && installments > 1) hasInstallment = true;

    parsedTotal += amount;

    if (amount < 0) {
      // 返金・キャンセル行。支出のマイナスではなく収入として相殺する
      // (これまでは「金額を認識できません」として捨てられていた)
      imported.push({
        date,
        type: "income",
        category: CARD_REFUND_CATEGORY,
        amount: -amount,
        memo: `返金: ${merchant}`,
        source: SOURCE_CARD,
      });
    } else {
      imported.push({
        date,
        type: "expense",
        category: guessCategoryFromMerchant(merchant),
        amount,
        memo: merchant,
        source: SOURCE_CARD,
      });
    }
  }

  // isCardStatement を立てて、呼び出し側が「確定明細」だと分かるようにする。
  // 確定明細のときだけ、メールから取り込んだ仮の記録との突き合わせを行う。
  return { imported, errors, expectedTotal, parsedTotal, hasInstallment, isCardStatement: true };
}

// 店名の表記ゆれを吸収する。同じ「ファミリーマート」でも、
//   メール(ご利用のお知らせ) : ファミリーマート
//   カード利用履歴CSV        : ﾌｧﾐﾘｰﾏｰﾄ / ＢＯＯＴＨ
// のように別の表記で出てくる。生の文字列のまま比べると、同じ取引が別物に見えて
// 二重に登録されてしまうため、比較の前に半角カナ・全角英数・空白を揃える。
function normalizeMemo(memo) {
  return toHalfWidthAscii(String(memo || ""))
    .replace(/\s+/g, "")
    .toUpperCase();
}

// 取り込み対象のうち、既存の記録と (日付・種別・カテゴリ・金額・店名) が
// 一致するものを重複とみなしてスキップする。同じCSVを誤って2回読み込んだ
// 場合などに二重登録されるのを防ぐ。件数ベースで比較するため、同じ内容の取引が
// 本当に複数回あった場合(同日同額の別々の買い物など)は正しく残す。
// 区切り文字は使わず JSON 化する。スペース区切りだと
// {カテゴリ:"食費", 金額:500, メモ:"1000 コンビニ"} と
// {カテゴリ:"食費 500", 金額:1000, メモ:"コンビニ"} が同じキーになり、
// 別物が重複としてスキップされてしまう。
function dedupeKey(e) {
  return JSON.stringify([e.date, e.type, e.category, e.amount, normalizeMemo(e.memo)]);
}

function dedupeAgainstExisting(imported) {
  const existingCounts = new Map();
  for (const e of entries) {
    const key = dedupeKey(e);
    existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
  }

  const deduped = [];
  let skippedCount = 0;
  for (const item of imported) {
    const key = dedupeKey(item);
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

// 2つの日付が何日離れているか。日付は YYYY-MM-DD なので UTC の同じ時刻として
// 解釈され、時差の影響を受けずに差が出る。
function daysApart(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 86400000;
}

// 確定明細の1行と、既にあるカードの記録が同じ取引かどうかを判定するルール。
// 上から順に、確実なものから試す。1周目で全行を判定してから2周目に進むので、
// 弱いルールが横取りして正しい組み合わせを壊すことがない。
//
// pendingOnly のルールは、未確定(メール由来)の記録にしか使わない。
// 「日付や金額がずれていても同じ取引とみなす」という緩い判定なので、
// 確定済みの記録に当てると、同じ店の別の買い物を同一視してしまう。
const CARD_MATCH_RULES = [
  {
    label: "店名・日付・金額が一致",
    test: (row, e) =>
      e.date === row.date &&
      e.amount === row.amount &&
      normalizeMemo(e.memo) === normalizeMemo(row.memo),
  },
  {
    // メールとCSVで店名の書き方が大きく違う場合 (支店名の有無など)
    label: "日付と金額が一致",
    test: (row, e) => e.date === row.date && e.amount === row.amount,
  },
  {
    // 確定時に計上日がずれる場合
    label: "店名と金額が一致し、日付が3日以内",
    pendingOnly: true,
    test: (row, e) =>
      e.amount === row.amount &&
      normalizeMemo(e.memo) === normalizeMemo(row.memo) &&
      daysApart(e.date, row.date) <= 3,
  },
  {
    // 海外利用の為替確定・ガソリンスタンドなど、確定で金額が変わる場合
    label: "店名と日付が一致し、金額だけ違う",
    pendingOnly: true,
    test: (row, e) =>
      e.date === row.date && normalizeMemo(e.memo) === normalizeMemo(row.memo),
  },
];

/**
 * 確定したカード利用履歴CSVと、メールから取り込んだ未確定(仮)の記録を突き合わせる。
 *
 * メールの「ご利用のお知らせ」は速報なので、確定時に金額や計上日がずれることが
 * ある。確定CSVはその期間のカード利用の正解リストなので、対応する仮の記録を
 * 確定版の日付・金額で上書きし、CSVにしか無いものだけを新しく足す。
 *
 * カテゴリとメモは上書きしない。ユーザーが手で直しているかもしれないうえ、
 * 店名はメール側の方が読みやすい(CSVは半角カナのことが多い)ため。
 * 手動入力(現金・その他)は source が違うので、そもそも突き合わせの対象にしない。
 */
function reconcileCardStatement(imported) {
  const dates = imported.map((e) => e.date).sort();
  const from = dates[0];
  const to = dates[dates.length - 1];

  // 突き合わせの相手は「CSVが対象にしている期間の、カード由来の記録」だけ。
  // 期間外まで手を出すと次回請求分の仮の記録を巻き込むし、手入力(現金・その他)
  // は source が違うのでそもそも入ってこない。
  // 確定済み(card)も相手に含めるのは、同じCSVをもう一度読み込んだときのため。
  // 一度確定させた記録はメール側の店名を残すので、店名だけで比べる重複チェックは
  // すり抜けてしまう。ここで拾って「登録済み」として弾く。
  const candidates = entries.filter(
    (e) =>
      (isPendingEntry(e) || e.source === SOURCE_CARD) &&
      e.date >= from &&
      e.date <= to
  );

  const used = new Set();
  const updates = [];
  const alreadyImported = [];
  let unmatchedRows = [...imported];

  for (const rule of CARD_MATCH_RULES) {
    const stillUnmatched = [];
    for (const row of unmatchedRows) {
      const found = candidates.find(
        (e) =>
          !used.has(e.id) &&
          e.type === row.type &&
          (!rule.pendingOnly || isPendingEntry(e)) &&
          rule.test(row, e)
      );
      if (!found) {
        stillUnmatched.push(row);
        continue;
      }
      used.add(found.id);
      // 仮の記録なら確定版に更新する。既に確定済みなら、同じCSVの読み直し
      // なので何もしない。
      if (isPendingEntry(found)) updates.push({ entry: found, row });
      else alreadyImported.push(row);
    }
    unmatchedRows = stillUnmatched;
    if (unmatchedRows.length === 0) break;
  }

  // 期間内なのに確定明細に出てこなかった仮の記録。キャンセルされたか、
  // 次回の請求に回った可能性がある。勝手に消すと戻せない(メールは取り込み済み
  // として記録されるので、二度と拾い直せない)ので、残して知らせるだけにする。
  const unmatchedPending = candidates.filter((e) => isPendingEntry(e) && !used.has(e.id));

  return { updates, alreadyImported, additions: unmatchedRows, unmatchedPending, from, to };
}

/**
 * メールから取り込む明細のうち、既に確定済みとして登録されているものを落とす。
 *
 * メールの検索範囲は60日あるため、先にカード利用履歴CSV(確定明細)を取り込んで
 * から「メールから読み込み」を実行すると、確定済みの取引の速報が後追いで
 * 入ってきてしまう。日付・種別・金額が一致する確定済みの記録があれば、
 * 同じ取引とみなして取り込まない。
 *
 * 判定は「日付と金額が一致」までに留める。ここで緩い判定をすると、本物の
 * 取引を黙って捨てることになるため (取り込みすぎは後で消せるが、捨てた分は
 * メールが取り込み済みになるので戻せない)。
 */
function dropAlreadyConfirmed(imported) {
  const confirmed = entries.filter((e) => e.source === SOURCE_CARD);
  const used = new Set();
  const kept = [];
  let confirmedCount = 0;

  for (const row of imported) {
    const found = confirmed.find(
      (e) =>
        !used.has(e.id) &&
        e.type === row.type &&
        e.date === row.date &&
        e.amount === row.amount
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

    const {
      imported,
      errors,
      expectedTotal,
      parsedTotal,
      hasInstallment,
      convertedCategories,
      isCardStatement,
    } = parseWideFormat(rows) || parseCardUsageFormat(rows) || parseSimpleFormat(rows);

    if (imported.length === 0) {
      alert("インポートできる行がありませんでした。\n\n" + errors.slice(0, 10).join("\n"));
      return;
    }

    // CSVに記載された合計金額(カード利用履歴CSVの末尾行など)と、実際に読み取れた
    // 金額の合計を突き合わせ、正しく取り込めているかを確認する
    let verificationNote = "";
    if (expectedTotal != null) {
      const total = parsedTotal ?? imported.reduce((sum, e) => sum + e.amount, 0);
      if (hasInstallment) {
        // 分割払いがあると、CSVの合計行(今回支払金額の合計)と
        // 取り込む金額(利用金額)は原理的に一致しない。
        // ここで一致・不一致の判定を出すと、どちらも実態と食い違う案内になる。
        verificationNote =
          `\n\n※ 分割払いが含まれるため、CSV記載の合計金額(${formatYen(expectedTotal)}=今回の支払額)と` +
          `取り込む金額の合計(${formatYen(total)}=買い物の総額)は一致しません。`;
      } else {
        verificationNote =
          total === expectedTotal
            ? `\n\n[OK] CSV記載の合計金額(${formatYen(expectedTotal)})と一致しました。`
            : `\n\n[注意] CSV記載の合計金額(${formatYen(expectedTotal)})と読み取れた金額の合計(${formatYen(
                total
              )})が一致しません。一部の行が正しく取り込めていない可能性があります。`;
      }
    }

    // 確定明細なら、先にメールから取り込んだ仮の記録と突き合わせる。
    // 残った行(仮の記録に対応が無かったもの)だけを新規追加の候補にする。
    const reconciliation = isCardStatement ? reconcileCardStatement(imported) : null;
    const toAdd = reconciliation ? reconciliation.additions : imported;

    // 突き合わせのあとにもう一度、既存の記録との重複を見る。
    // 同じCSVを2回読み込んだ場合と、source を持たない古いメール由来の記録
    // (この仕組みを入れる前に取り込んだもの) はここで弾かれる。
    const dedupeResult = dedupeAgainstExisting(toAdd);
    const deduped = dedupeResult.deduped;
    // 確定済みの記録と一致した行も「既に登録済み」として数える
    const skippedCount =
      dedupeResult.skippedCount + (reconciliation ? reconciliation.alreadyImported.length : 0);
    const updateCount = reconciliation ? reconciliation.updates.length : 0;

    if (deduped.length === 0 && updateCount === 0) {
      alert(
        `すべて(${skippedCount}件)既に登録済みのため、新しく追加する記録はありませんでした。` +
          verificationNote
      );
      return;
    }

    let message =
      updateCount > 0
        ? `カード利用履歴(確定明細)を取り込みます。よろしいですか?`
        : `${deduped.length}件の記録をインポートします。よろしいですか?`;
    if (updateCount > 0) {
      message +=
        `\n\n・メールから取り込んだ仮の記録 ${updateCount}件を確定版に更新します` +
        `\n・${deduped.length}件を新しく追加します`;
    }
    if (skippedCount > 0) {
      message += `\n\n(${skippedCount}件は既に登録済みのためスキップされます)`;
    }
    // 確定明細に出てこなかった仮の記録。キャンセル済みか次回請求分の可能性が
    // あるが、こちらでは判断できないので消さずに知らせる。
    if (reconciliation && reconciliation.unmatchedPending.length > 0) {
      const list = reconciliation.unmatchedPending
        .slice(0, 5)
        .map((e) => `${e.date} ${e.memo || e.category} ${formatYen(e.amount)}`);
      message +=
        `\n\n[注意] ${reconciliation.unmatchedPending.length}件の仮の記録が確定明細に見つかりませんでした。` +
        "キャンセル済みか、次回の請求に回った可能性があります。" +
        "そのまま残すので、内容を確認して必要なら削除してください。\n" +
        list.join("\n") +
        (reconciliation.unmatchedPending.length > 5
          ? `\n...ほか${reconciliation.unmatchedPending.length - 5}件`
          : "");
    }
    if (errors.length > 0) {
      message += `\n\n(${errors.length}件の行はスキップされます)\n` + errors.slice(0, 5).join("\n");
    }
    // カテゴリが無言で書き換わっていたことに気づけるようにする
    if (convertedCategories && convertedCategories.size > 0) {
      const pairs = [...convertedCategories.entries()].map(([from, to]) => `${from} → ${to}`);
      message +=
        `\n\n(${convertedCategories.size}種類のカテゴリを読み替えます)\n` +
        pairs.slice(0, 5).join("\n") +
        (pairs.length > 5 ? `\n...ほか${pairs.length - 5}種類` : "");
    }
    message += verificationNote;
    if (!confirm(message)) return;

    try {
      if (updateCount > 0) {
        // 確定で動くのは日付と金額だけ。カテゴリとメモは手で直している
        // 可能性があるので触らない。
        await updateEntriesInDb(
          reconciliation.updates.map(({ entry, row }) => ({
            id: entry.id,
            data: { date: row.date, amount: row.amount, source: SOURCE_CARD },
          }))
        );
      }
      if (deduped.length > 0) await importEntriesToDb(deduped);
    } catch (err) {
      alert("インポートに失敗しました: " + err.message);
      return;
    }
    alert(
      updateCount > 0
        ? `${updateCount}件を確定版に更新し、${deduped.length}件を追加しました。`
        : `${deduped.length}件をインポートしました。`
    );
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
    const amountMatch = block.match(/◇利用金額[:：]\s*([\d,]+)円/);
    if (!dateMatch || !merchantMatch || !amountMatch) continue;

    const [, y, mo, d] = dateMatch;
    const amount = Number(amountMatch[1].replace(/,/g, ""));
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
      source: SOURCE_GMAIL,
    });
  }
  return results;
}

// アクセストークンは約1時間で切れる。期限切れ(401/403)なら黙って取り直して
// 一度だけやり直すことで、時間を空けた2回目の読み込みが必ず失敗するのを防ぐ。
async function gmailApiFetch(path, params, isRetry = false) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${gmailAccessToken}` },
  });
  if (res.status === 401 && !isRetry) {
    gmailAccessToken = null;
    await requestGmailAccessToken();
    return gmailApiFetch(path, params, true);
  }
  if (!res.ok) {
    if (res.status === 401) {
      // 取り直しても401なら、Google側でアクセスを取り消された可能性が高い。
      // 同意済みフラグも落として、次回は同意画面から始められるようにする。
      gmailAccessToken = null;
      googleTokenGranted = false;
      throw new Error("Googleの認証が切れました。もう一度お試しください。");
    }
    if (res.status === 403) {
      // 403 の大半はレート超過やAPI無効。「もう一度」と促すと連打で悪化する
      throw new Error(
        "Gmailへのアクセスが拒否されました (403)。短時間に多く読み込むと" +
          "一時的に制限されることがあります。しばらく待ってからお試しください。"
      );
    }
    throw new Error(`Gmail APIエラー (${res.status})`);
  }
  return res.json();
}

// 該当メールが maxResults を超えても古い分を取りこぼさないよう、
// nextPageToken を辿って集める(暴走を避けるため上限あり)。
async function gmailListAllMessages(query, limit = 300) {
  const collected = [];
  let pageToken = null;
  do {
    const params = { q: query, maxResults: "100" };
    if (pageToken) params.pageToken = pageToken;
    const page = await gmailApiFetch("messages", params);
    collected.push(...(page.messages || []));
    pageToken = page.nextPageToken || null;
  } while (pageToken && collected.length < limit);
  return collected;
}

function gmailImportDocRef() {
  return firestoreApi.doc(db, `users/${currentUid}/settings/gmailImport`);
}

async function getImportedGmailIds() {
  const snap = await firestoreApi.getDoc(gmailImportDocRef());
  return snap.exists() ? snap.data().importedIds || [] : [];
}

// setDoc(merge:true) + arrayUnion なら、ドキュメントが無ければ作成、あれば追記になる。
// 以前は updateDoc の失敗を「初回で未作成」と決めつけて merge なしの setDoc に
// フォールバックしていたため、一時的なエラー1回で取り込み済み履歴が全消えし、
// 過去のメールが全部「新規」に戻って大量に二重登録される危険があった。
// 取り込み済みIDは無制限には増やさない。ドキュメントが1MiB上限に達すると
// 以降の記録が全て失敗し、毎回同じメールを取り込もうとするループになるため、
// 古いものから捨てる (検索対象は直近60日なので、この件数あれば十分)
const IMPORTED_GMAIL_ID_LIMIT = 2000;

async function markGmailIdsImported(ids) {
  if (ids.length === 0) return;

  // 件数を減らす書き込みは、現在の内容を確実に読めたときだけ行う。
  // 読めていないのに全置換すると履歴を失う。
  let existing = null;
  try {
    existing = await getImportedGmailIds();
  } catch {
    existing = null;
  }

  if (existing && existing.length + ids.length > IMPORTED_GMAIL_ID_LIMIT) {
    const trimmed = [...new Set([...existing, ...ids])].slice(-IMPORTED_GMAIL_ID_LIMIT);
    await firestoreApi.setDoc(gmailImportDocRef(), { importedIds: trimmed }, { merge: true });
    return;
  }

  await firestoreApi.setDoc(
    gmailImportDocRef(),
    { importedIds: firestoreApi.arrayUnion(...ids) },
    { merge: true }
  );
}

// トークンクライアントは1つだけ作り、コールバックが掴む resolve/reject は
// 呼び出しごとに差し替える。作成時のクロージャを使い回すと、1回目に失敗した
// あと2回目の Promise が永久に解決せずボタンが固まったままになる。
let pendingGmailTokenRequest = null;

function settleGmailTokenRequest(fn, value) {
  const pending = pendingGmailTokenRequest;
  pendingGmailTokenRequest = null;
  if (pending) pending[fn](value);
}

function requestGmailAccessToken() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error("Googleの認証ライブラリを読み込めませんでした。"));
      return;
    }
    // 前の要求が未解決のまま残っていたら打ち切ってから差し替える
    settleGmailTokenRequest("reject", new Error("認証がやり直されました。"));
    pendingGmailTokenRequest = { resolve, reject };

    if (!googleTokenClient) {
      googleTokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: googleClientId,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        callback: (response) => {
          if (response.error) {
            settleGmailTokenRequest("reject", new Error(response.error));
            return;
          }
          gmailAccessToken = response.access_token;
          googleTokenGranted = true;
          settleGmailTokenRequest("resolve", gmailAccessToken);
        },
        error_callback: (err) => {
          settleGmailTokenRequest("reject", new Error(err.type || "認証に失敗しました"));
        },
      });
    }
    // 一度許可済みなら再同意を求めない(期限切れの取り直しを静かに行うため)
    googleTokenClient.requestAccessToken({ prompt: googleTokenGranted ? "" : "consent" });
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

    const messages = await gmailListAllMessages(GMAIL_QUERY);
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
      imported.push(...parseVpassEmails(text));
    }

    if (imported.length === 0) {
      await markGmailIdsImported(newIds);
      alert("新しい利用通知メールは見つかりましたが、内容を解析できませんでした。");
      return;
    }

    // 確定明細を先に取り込んでいた場合、その取引の速報が後追いで入ってくる。
    const { kept, confirmedCount } = dropAlreadyConfirmed(imported);

    // メールIDによる重複防止が破れたとき(履歴の記録に失敗した直後など)の安全網。
    // CSV側と同じ判定を通し、同じ内容の記録が二重に入らないようにする。
    const { deduped, skippedCount } = dedupeAgainstExisting(kept);
    const totalSkipped = skippedCount + confirmedCount;

    if (deduped.length === 0) {
      await markGmailIdsImported(newIds);
      alert(`すべて(${totalSkipped}件)既に登録済みのため、新しく追加する記録はありませんでした。`);
      return;
    }

    const total = deduped.reduce((sum, e) => sum + e.amount, 0);
    const preview = deduped
      .slice(0, 5)
      .map((e) => `${e.date} ${e.memo} ${formatYen(e.amount)} (${e.category})`)
      .join("\n");
    let message =
      `${deduped.length}件の利用明細が見つかりました (合計 ${formatYen(total)})。取り込みますか?\n\n` +
      preview +
      (deduped.length > 5 ? `\n...ほか${deduped.length - 5}件` : "");
    if (totalSkipped > 0) {
      message += `\n\n(${totalSkipped}件は既に登録済みのためスキップされます`;
      message +=
        confirmedCount > 0
          ? `。うち${confirmedCount}件はカード利用履歴CSVで確定済みです)`
          : ")";
    }
    message +=
      "\n\nカテゴリは自動推測です。あとで必要に応じて編集してください。" +
      "\n取り込んだ記録は「仮」として入ります。カード利用履歴CSVを取り込むと確定します。";
    if (!confirm(message)) return;

    await importEntriesToDb(deduped);

    // 記録は入ったので、履歴の記録に失敗しても取り込み自体は成功として扱う。
    // (次回また同じメールを拾っても、上の重複チェックで弾かれる)
    try {
      await markGmailIdsImported(newIds);
      alert(`${deduped.length}件をインポートしました。`);
    } catch {
      alert(
        `${deduped.length}件をインポートしました。\n\n` +
          "ただし取り込み済みメールの記録に失敗しました。次回同じメールが再度見つかりますが、" +
          "重複チェックで自動的にスキップされます。"
      );
    }
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
      for (const t of el.authTabs) {
        const isActive = t === tab;
        t.classList.toggle("active", isActive);
        // 選択中かどうかを色だけでなく読み上げにも伝える
        t.setAttribute("aria-pressed", String(isActive));
      }
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

  el.logoutBtn.addEventListener("click", () => {
    // 共有端末で別の人がログインしたときに、前の人のGmailを読めてしまわないよう
    // アクセストークンを捨てる
    gmailAccessToken = null;
    googleTokenGranted = false;
    authApi.signOut(auth);
  });
}

// ---------------------------------------------------------------------------
// イベント登録・初期化
// ---------------------------------------------------------------------------

function setupAppEventListeners() {
  setupBookTabs();
  el.editAccountsBtn.addEventListener("click", openAccountsForm);
  el.cancelAccountsBtn.addEventListener("click", closeAccountsForm);
  el.accountsForm.addEventListener("submit", submitAccountsForm);

  // 日付での絞り込みは特定の1日を見るためのものなので、表示する期間を動かしたら解除する。
  // 残したままだと「2026年7月」の見出しに「2026年8月5日の記録・0件」が出て、
  // 理由の分からない行き止まりになる。
  const clearDateFilter = () => {
    if (!filterDate) return;
    filterDate = "";
    el.filterDate.value = "";
  };

  el.prevMonth.addEventListener("click", () => {
    clearDateFilter();
    currentMonth =
      viewMode === "year"
        ? new Date(currentMonth.getFullYear() - 1, currentMonth.getMonth(), 1)
        : new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    render();
  });

  el.nextMonth.addEventListener("click", () => {
    clearDateFilter();
    currentMonth =
      viewMode === "year"
        ? new Date(currentMonth.getFullYear() + 1, currentMonth.getMonth(), 1)
        : new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    render();
  });

  el.todayBtn.addEventListener("click", () => {
    clearDateFilter();
    currentMonth = startOfMonth(new Date());
    render();
  });

  for (const tab of el.viewTabs) {
    tab.addEventListener("click", () => {
      clearDateFilter();
      viewMode = tab.dataset.view;
      for (const t of el.viewTabs) {
        const isActive = t === tab;
        t.classList.toggle("active", isActive);
        t.setAttribute("aria-pressed", String(isActive));
      }
      el.todayBtn.textContent = viewMode === "year" ? "今年" : "今月";
      render();
    });
  }

  for (const radio of document.querySelectorAll('input[name="entry-type"]')) {
    radio.addEventListener("change", () => {
      const type = selectedType();
      renderCategoryOptions(type);
      updatePayslipVisibility();
      updateAdvanceVisibility();
      // 編集中は入力済みの値を尊重する。新規追加のときだけ初期値を切り替える
      if (!el.entryId.value) el.entrySettlement.value = defaultSettlementFor(type);
    });
  }

  el.entryCategory.addEventListener("change", updatePayslipVisibility);
  el.payslipToggleBtn.addEventListener("click", openPayslipBreakdown);
  el.payslipClearBtn.addEventListener("click", () => closePayslipBreakdown());
  for (const input of allPayslipInputEls()) {
    input.addEventListener("input", updatePayslipPreview);
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

  el.exportAnalysisBtn.addEventListener("click", exportForAnalysis);

  el.importCsvBtn.addEventListener("click", () => el.importCsvInput.click());

  el.importCsvInput.addEventListener("change", () => {
    const file = el.importCsvInput.files[0];
    if (file) importCsv(file);
    el.importCsvInput.value = "";
  });

  el.gmailImportBtn.addEventListener("click", importFromGmail);

  // 見出しの中は <button> なので、Enter/Space はブラウザが click に変換してくれる
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

  el.filterDate.addEventListener("change", () => {
    filterDate = el.filterDate.value;
    // 選んだ日が今表示している期間の外だと1件も出ずに戸惑うので、
    // その日を含む月へ自動で移動する
    if (filterDate) {
      const picked = new Date(filterDate + "T00:00:00");
      const sameYear = picked.getFullYear() === currentMonth.getFullYear();
      const inPeriod =
        viewMode === "year" ? sameYear : sameYear && picked.getMonth() === currentMonth.getMonth();
      if (!inPeriod) currentMonth = startOfMonth(picked);
    }
    render();
  });

  el.filterDateClear.addEventListener("click", () => {
    filterDate = "";
    el.filterDate.value = "";
    render();
  });

  // 編集ポップアップの×は「編集をやめる」なので、キャンセルと同じ扱いにする
  el.entryEditClose.addEventListener("click", resetForm);

  el.payslipDetailClose.addEventListener("click", hidePayslipDetailModal);
  el.advanceSettleClose.addEventListener("click", closeAdvanceSettleModal);
  el.advanceSettleCancel.addEventListener("click", closeAdvanceSettleModal);
  el.advanceSettleConfirm.addEventListener("click", confirmAdvanceSettle);

  // モーダルは複数あるので、背景クリックとEscapeは全ての .modal-overlay に対して共通で処理する。
  // ただし単に隠すだけだと選択中の立替金などの状態が残るため、専用の閉じる処理を経由する。
  const closeOverlay = (overlay) => {
    if (overlay === el.advanceSettleModal) closeAdvanceSettleModal();
    // 編集ポップアップは、閉じるときにフォームを元の場所へ戻す必要がある
    else if (overlay === el.entryEditModal) resetForm();
    else closeModal(overlay);
  };
  for (const overlay of document.querySelectorAll(".modal-overlay")) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeOverlay(overlay);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      trapFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    for (const overlay of document.querySelectorAll(".modal-overlay:not(.hidden)")) {
      closeOverlay(overlay);
    }
  });

  renderFilterCategoryOptions();
  setupSidebarScrollSpy();
}

// サイドバーのリンクを、現在スクロールして表示中のセクションに応じてハイライトする
// (ヘッダー直下のライン(referenceY)を最後に通過したセクションをアクティブにする。
//  最後のセクションはページ末尾でスクロールが頭打ちになり画面中央まで届かない
//  ことがあるため、IntersectionObserverの領域判定ではなく通過判定を使う)
let sidebarScrollSpyBound = false;

// ヘッダーは flex-wrap するため、幅によって高さが変わる。アンカー移動したときに
// 見出しがヘッダーの裏に隠れないよう、実寸を CSS 変数として渡す。
function trackHeaderHeight() {
  const header = document.querySelector(".app-header");
  if (!header) return;
  const update = () => {
    document.documentElement.style.setProperty(
      "--header-height",
      `${Math.round(header.getBoundingClientRect().height)}px`
    );
  };
  update();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(update).observe(header);
  } else {
    window.addEventListener("resize", update);
  }
}

function setupSidebarScrollSpy() {
  if (sidebarScrollSpyBound) return;
  sidebarScrollSpyBound = true;

  trackHeaderHeight();

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
  // アイコンの差し替えは一番先にやる。SDKや設定の読み込みに失敗したときの
  // 案内画面にもアイコンがあるので、後回しにすると空欄のまま出てしまう。
  hydrateIcons();

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
  } catch (err) {
    // ファイルが無い場合と、あるが構文エラーの場合を区別する。
    // 一緒くたにすると「作成してください」と案内された既存ファイルを
    // もう一度作ろうとして詰まる。
    console.error("firebase-config.js を読み込めませんでした:", err);
    showOnly("setup");
    return;
  }
  if (!firebaseConfig) {
    console.error("firebase-config.js から firebaseConfig が export されていません");
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

// 想定外の例外で「読み込み中...」のまま固まらないよう、最後に必ず受け止めて
// 原因を示す画面に切り替える (設定値の誤りなどで initializeApp が落ちる場合など)
main().catch((err) => {
  console.error("起動に失敗しました:", err);
  showOnly("sdk-error");
});

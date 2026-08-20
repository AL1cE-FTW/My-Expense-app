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

// 収入目標を設定できるカテゴリ (賞与・返金系は別扱いのため除外)
function incomeBudgetCategories() {
  return CATEGORIES.income.filter(
    (c) => c !== BONUS_CATEGORY && !REFUND_CATEGORIES.includes(c)
  );
}

// 給与明細の内訳入力を出すカテゴリ (給与=通常の給与明細、賞与=賞与明細で項目が異なる)
const PAYSLIP_CATEGORY = "給与";
const PAYSLIP_SALARY_EARNING_FIELDS = ["baseSalary", "commute", "overtimePay"];
const PAYSLIP_SALARY_DEDUCTION_FIELDS = [
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

  const targetMultiplier = viewMode === "year" ? elapsedMonthsInYear() : 1;
  const entriesInPeriod = periodEntries();
  renderSummary(entriesInPeriod);
  renderMonthlyBarChart();
  const budgetTotals = renderBudget(entriesInPeriod, targetMultiplier);
  renderPlanActual(entriesInPeriod, targetMultiplier, budgetTotals);
  renderAdvances();
  renderNeedWantSave(entriesInPeriod);
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
      // 返金は稼いだお金ではないので、50:30:20 の基準となる収入には数えない。
      // (5万円の立替精算で Need の目標が2.5万円水増しされるのを防ぐ。
      //  対になる支出も同じ期間にあれば Save 実績で自然に相殺される)
      if (!isRefundIncome(e)) totalIncome += e.amount;
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
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortColumn) {
      th.classList.add(sortDirection === "asc" ? "sort-asc" : "sort-desc");
      // 矢印は目で見ないと分からないので、読み上げにも現在の並び順を伝える
      th.setAttribute("aria-sort", sortDirection === "asc" ? "ascending" : "descending");
    } else {
      th.setAttribute("aria-sort", "none");
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
      payslipModalRow("通勤手当", p.commute || 0),
      payslipModalRow("時間外勤務手当", p.overtimePay || 0),
      payslipModalRow("支給合計", gross, { total: true }),
      payslipModalGroupLabel("控除"),
      payslipModalRow("健康保険", p.healthInsurance || 0),
      payslipModalRow("介護保険", p.nursingInsurance || 0),
      payslipModalRow("厚生年金", p.pensionInsurance || 0),
      payslipModalRow("雇用保険料", p.employmentInsurance || 0),
      payslipModalRow("所得税", p.incomeTax || 0),
      payslipModalRow("住民税", p.residentTax || 0),
      payslipModalRow("その他控除", p.otherDeductions || 0),
      payslipModalRow("控除合計", deductions, { total: true }),
      payslipModalRow("差引支給額(手取り)", entry.amount, { total: true })
    );
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
  commute: () => el.payslipCommute,
  overtimePay: () => el.payslipOvertimePay,
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

function resetForm() {
  // 編集ポップアップを開いたままだと、追加用のフォームが行方不明になる
  closeEntryEditModal();
  el.entryId.value = "";
  el.form.reset();
  el.entryDate.value = toDateInputValue(new Date());
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
  // 永久にずれるため、返金もまとめて消す。
  const refund = entry.advance === true ? refundsByAdvanceId().get(entry.id) : null;
  const message = refund
    ? `この記録を削除しますか?\n${label}\n\n` +
      `対になる返金の記録も一緒に削除されます。\n` +
      `${refund.date} ${refund.category} ${formatYen(refund.amount)}`
    : `この記録を削除しますか?\n${label}`;
  if (!confirm(message)) return;

  // 2件消す場合、片方だけ成功して終わることがある。何が残っているかを
  // 伝えないと、ユーザーは「何も起きなかった」と思って先に進んでしまう。
  let refundDeleted = false;
  try {
    if (refund) {
      await deleteEntryFromDb(refund.id);
      refundDeleted = true;
    }
    await deleteEntryFromDb(id);
  } catch (err) {
    alert(
      "削除に失敗しました: " +
        err.message +
        (refundDeleted
          ? "\n\n返金の記録は削除済みで、立替金の記録が残っています。" +
            "そのため未回収の立替金として再び表示されます。もう一度削除してください。"
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
    } else {
      await addEntryToDb({ ...data, createdAt: nowTimestamp() });
      entrySaved = true;
    }
  } catch (err) {
    if (entrySaved) {
      // 記録自体は保存済み。残っている問題だけを伝えてフォームは通常どおり閉じる
      alert(
        "記録は保存できましたが、対になる返金の記録を削除できませんでした: " +
          err.message +
          "\n\n返金の収入だけが残っているため、累計貯金額がその分ずれています。" +
          "記録一覧から手動で削除してください。"
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
      });
    } else {
      imported.push({
        date,
        type: "expense",
        category: guessCategoryFromMerchant(merchant),
        amount,
        memo: merchant,
      });
    }
  }

  return { imported, errors, expectedTotal, parsedTotal, hasInstallment };
}

// 取り込み対象のうち、既存の記録と (日付・種別・カテゴリ・金額・メモ) が
// 完全一致するものを重複とみなしてスキップする。同じCSVを誤って2回読み込んだ
// 場合などに二重登録されるのを防ぐ。件数ベースで比較するため、同じ内容の取引が
// 本当に複数回あった場合(同日同額の別々の買い物など)は正しく残す。
// 区切り文字は使わず JSON 化する。スペース区切りだと
// {カテゴリ:"食費", 金額:500, メモ:"1000 コンビニ"} と
// {カテゴリ:"食費 500", 金額:1000, メモ:"コンビニ"} が同じキーになり、
// 別物が重複としてスキップされてしまう。
function dedupeKey(e) {
  return JSON.stringify([e.date, e.type, e.category, e.amount, e.memo || ""]);
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

    const { imported, errors, expectedTotal, parsedTotal, hasInstallment, convertedCategories } =
      parseWideFormat(rows) || parseCardUsageFormat(rows) || parseSimpleFormat(rows);

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
        // ここで✓や⚠を出すと、どちらも実態と食い違う案内になる。
        verificationNote =
          `\n\n※ 分割払いが含まれるため、CSV記載の合計金額(${formatYen(expectedTotal)}=今回の支払額)と` +
          `取り込む金額の合計(${formatYen(total)}=買い物の総額)は一致しません。`;
      } else {
        verificationNote =
          total === expectedTotal
            ? `\n\n✓ CSV記載の合計金額(${formatYen(expectedTotal)})と一致しました。`
            : `\n\n⚠️ CSV記載の合計金額(${formatYen(expectedTotal)})と読み取れた金額の合計(${formatYen(
                total
              )})が一致しません。一部の行が正しく取り込めていない可能性があります。`;
      }
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

    // メールIDによる重複防止が破れたとき(履歴の記録に失敗した直後など)の安全網。
    // CSV側と同じ判定を通し、同じ内容の記録が二重に入らないようにする。
    const { deduped, skippedCount } = dedupeAgainstExisting(imported);

    if (deduped.length === 0) {
      await markGmailIdsImported(newIds);
      alert(`すべて(${skippedCount}件)既に登録済みのため、新しく追加する記録はありませんでした。`);
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
    if (skippedCount > 0) {
      message += `\n\n(${skippedCount}件は既に登録済みのためスキップされます)`;
    }
    message += "\n\nカテゴリは自動推測です。あとで必要に応じて編集してください。";
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
      renderCategoryOptions(selectedType());
      updatePayslipVisibility();
      updateAdvanceVisibility();
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

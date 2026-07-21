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
};

const TYPE_LABELS = { expense: "支出", income: "収入" };

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

// 表示中の月 (毎月1日の Date)
let currentMonth = startOfMonth(new Date());

let db = null;
let auth = null;
let currentUid = null;
let unsubscribeEntries = null;
let unsubscribeBudget = null;
let authMode = "login";

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

  currentMonth: document.getElementById("current-month"),
  prevMonth: document.getElementById("prev-month"),
  nextMonth: document.getElementById("next-month"),
  todayBtn: document.getElementById("today-btn"),
  cumulativeSavings: document.getElementById("cumulative-savings"),
  totalIncome: document.getElementById("total-income"),
  totalExpense: document.getElementById("total-expense"),
  balance: document.getElementById("balance"),
  form: document.getElementById("entry-form"),
  formTitle: document.getElementById("form-title"),
  entryId: document.getElementById("entry-id"),
  entryDate: document.getElementById("entry-date"),
  entryCategory: document.getElementById("entry-category"),
  entryAmount: document.getElementById("entry-amount"),
  entryMemo: document.getElementById("entry-memo"),
  submitBtn: document.getElementById("submit-btn"),
  cancelEditBtn: document.getElementById("cancel-edit-btn"),
  categoryBreakdown: document.getElementById("category-breakdown"),
  budgetOverall: document.getElementById("budget-overall"),
  budgetBreakdown: document.getElementById("budget-breakdown"),
  editBudgetBtn: document.getElementById("edit-budget-btn"),
  budgetForm: document.getElementById("budget-form"),
  budgetInputs: document.getElementById("budget-inputs"),
  cancelBudgetBtn: document.getElementById("cancel-budget-btn"),
  entryList: document.getElementById("entry-list"),
  listEmptyMessage: document.getElementById("list-empty-message"),
  exportCsvBtn: document.getElementById("export-csv-btn"),
  importCsvInput: document.getElementById("import-csv-input"),
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
  entries = [];
  budgets = {};
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
  resetForm();
  closeBudgetForm();
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

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function render() {
  el.currentMonth.textContent = formatMonth(currentMonth);

  renderCumulativeSavings();

  const monthEntries = entriesForMonth(currentMonth);
  renderSummary(monthEntries);
  renderBudget(monthEntries);
  renderBreakdown(monthEntries);
  renderList(monthEntries);
}

function renderCumulativeSavings() {
  let total = 0;
  for (const e of entries) {
    total += e.type === "income" ? e.amount : -e.amount;
  }
  el.cumulativeSavings.textContent = (total < 0 ? "-" : "") + formatYen(Math.abs(total));
  el.cumulativeSavings.classList.toggle("positive", total > 0);
  el.cumulativeSavings.classList.toggle("negative", total < 0);
}

function renderSummary(monthEntries) {
  let income = 0;
  let expense = 0;
  for (const e of monthEntries) {
    if (e.type === "income") income += e.amount;
    else expense += e.amount;
  }
  const balance = income - expense;

  el.totalIncome.textContent = formatYen(income);
  el.totalExpense.textContent = formatYen(expense);
  el.balance.textContent = (balance < 0 ? "-" : "") + formatYen(Math.abs(balance));
  el.balance.classList.toggle("positive", balance > 0);
  el.balance.classList.toggle("negative", balance < 0);
}

function budgetBarClass(ratio) {
  if (ratio >= 1) return "budget-bar over";
  if (ratio >= 0.8) return "budget-bar warning";
  return "budget-bar";
}

function renderBudget(monthEntries) {
  const actuals = new Map();
  for (const e of monthEntries) {
    if (e.type !== "expense") continue;
    actuals.set(e.category, (actuals.get(e.category) || 0) + e.amount);
  }

  const budgetedCategories = Object.keys(budgets).filter((c) => budgets[c] > 0);
  const totalBudget = budgetedCategories.reduce((sum, c) => sum + budgets[c], 0);
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
        budget: budgets[category],
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
    return;
  }

  for (const { category, budget, actual } of rows) {
    const row = document.createElement("div");
    row.className = "budget-row";

    const name = document.createElement("span");
    name.textContent = category;

    const track = document.createElement("div");
    track.className = "budget-bar-track";
    if (budget > 0) {
      const ratio = actual / budget;
      const bar = document.createElement("div");
      bar.className = budgetBarClass(ratio);
      bar.style.width = `${Math.min(ratio, 1) * 100}%`;
      track.appendChild(bar);
    }

    const amountText = document.createElement("span");
    amountText.className = "budget-amount-text";
    if (budget > 0) {
      amountText.textContent = `${formatYen(actual)} / ${formatYen(budget)}`;
      amountText.classList.toggle("over", actual > budget);
    } else {
      amountText.textContent = `${formatYen(actual)} (予算未設定)`;
    }

    row.append(name, track, amountText);
    el.budgetBreakdown.appendChild(row);
  }
}

function renderBreakdown(monthEntries) {
  const totals = new Map();
  for (const e of monthEntries) {
    if (e.type !== "expense") continue;
    totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
  }

  el.categoryBreakdown.innerHTML = "";

  if (totals.size === 0) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = "今月の支出はまだありません";
    el.categoryBreakdown.appendChild(p);
    return;
  }

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];

  for (const [category, amount] of sorted) {
    const row = document.createElement("div");
    row.className = "breakdown-row";

    const name = document.createElement("span");
    name.textContent = category;

    const track = document.createElement("div");
    track.className = "breakdown-bar-track";
    const bar = document.createElement("div");
    bar.className = "breakdown-bar";
    bar.style.width = `${(amount / max) * 100}%`;
    track.appendChild(bar);

    const value = document.createElement("span");
    value.className = "breakdown-amount";
    value.textContent = formatYen(amount);

    row.append(name, track, value);
    el.categoryBreakdown.appendChild(row);
  }
}

function renderList(monthEntries) {
  el.entryList.innerHTML = "";
  el.listEmptyMessage.classList.toggle("hidden", monthEntries.length > 0);

  for (const entry of monthEntries) {
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
  }
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
// 予算編集フォーム
// ---------------------------------------------------------------------------

function renderBudgetInputs() {
  el.budgetInputs.innerHTML = "";
  for (const category of CATEGORIES.expense) {
    const group = document.createElement("div");
    group.className = "form-group";

    const label = document.createElement("label");
    label.textContent = category;
    label.htmlFor = `budget-input-${category}`;

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

// ---------------------------------------------------------------------------
// フォーム操作
// ---------------------------------------------------------------------------

function resetForm() {
  el.entryId.value = "";
  el.form.reset();
  el.entryDate.value = toDateInputValue(new Date());
  renderCategoryOptions("expense");
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

function importCsv(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const text = String(reader.result).replace(/^\uFEFF/, "");
    const rows = parseCsv(text).filter(
      (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== "")
    );

    if (rows.length === 0) {
      alert("CSVにデータがありません。");
      return;
    }

    const { imported, errors } = parseWideFormat(rows) || parseSimpleFormat(rows);

    if (imported.length === 0) {
      alert("インポートできる行がありませんでした。\n\n" + errors.slice(0, 10).join("\n"));
      return;
    }

    let message = `${imported.length}件の記録をインポートします。よろしいですか?`;
    if (errors.length > 0) {
      message += `\n\n(${errors.length}件の行はスキップされます)\n` + errors.slice(0, 5).join("\n");
    }
    if (!confirm(message)) return;

    try {
      await importEntriesToDb(imported);
    } catch (err) {
      alert("インポートに失敗しました: " + err.message);
      return;
    }
    alert(`${imported.length}件をインポートしました。`);
  };
  reader.onerror = () => alert("ファイルの読み込みに失敗しました。");
  reader.readAsText(file, "UTF-8");
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
    currentMonth = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth() - 1,
      1
    );
    render();
  });

  el.nextMonth.addEventListener("click", () => {
    currentMonth = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth() + 1,
      1
    );
    render();
  });

  el.todayBtn.addEventListener("click", () => {
    currentMonth = startOfMonth(new Date());
    render();
  });

  for (const radio of document.querySelectorAll('input[name="entry-type"]')) {
    radio.addEventListener("change", () => renderCategoryOptions(selectedType()));
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

  el.importCsvInput.addEventListener("change", () => {
    const file = el.importCsvInput.files[0];
    if (file) importCsv(file);
    el.importCsvInput.value = "";
  });
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

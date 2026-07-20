"use strict";

// ---------------------------------------------------------------------------
// 定数・状態
// ---------------------------------------------------------------------------

const STORAGE_KEY = "kakeibo-entries";

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

/** @type {{id: string, date: string, type: "income"|"expense", category: string, amount: number, memo: string}[]} */
let entries = loadEntries();

// 表示中の月 (毎月1日の Date)
let currentMonth = startOfMonth(new Date());

// ---------------------------------------------------------------------------
// 永続化
// ---------------------------------------------------------------------------

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (e) =>
        e &&
        typeof e.id === "string" &&
        typeof e.date === "string" &&
        (e.type === "income" || e.type === "expense") &&
        typeof e.category === "string" &&
        Number.isFinite(e.amount)
    );
  } catch {
    return [];
  }
}

function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

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

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
  currentMonth: document.getElementById("current-month"),
  prevMonth: document.getElementById("prev-month"),
  nextMonth: document.getElementById("next-month"),
  todayBtn: document.getElementById("today-btn"),
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
  entryList: document.getElementById("entry-list"),
  listEmptyMessage: document.getElementById("list-empty-message"),
  exportCsvBtn: document.getElementById("export-csv-btn"),
  importCsvInput: document.getElementById("import-csv-input"),
};

function selectedType() {
  return document.querySelector('input[name="entry-type"]:checked').value;
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function render() {
  el.currentMonth.textContent = formatMonth(currentMonth);

  const monthEntries = entriesForMonth(currentMonth);
  renderSummary(monthEntries);
  renderBreakdown(monthEntries);
  renderList(monthEntries);
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

function deleteEntry(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  const label = `${entry.date} ${entry.category} ${formatYen(entry.amount)}`;
  if (!confirm(`この記録を削除しますか?\n${label}`)) return;

  entries = entries.filter((e) => e.id !== id);
  saveEntries();
  if (el.entryId.value === id) resetForm();
  render();
}

function handleSubmit(event) {
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
  if (editingId) {
    const index = entries.findIndex((e) => e.id === editingId);
    if (index !== -1) entries[index] = { id: editingId, ...data };
  } else {
    entries.push({ id: generateId(), ...data });
  }

  saveEntries();
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
 * 対応形式: 2026-07-20 / 2026/7/20 / 2026.7.20 / 2026年7月20日
 */
function normalizeDate(value) {
  const m = String(value)
    .trim()
    .match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
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

function importCsv(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result).replace(/^\uFEFF/, "");
    const rows = parseCsv(text).filter(
      (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== "")
    );

    if (rows.length === 0) {
      alert("CSVにデータがありません。");
      return;
    }

    // 先頭行がヘッダーならスキップ
    let start = 0;
    if (normalizeDate(rows[0][0]) === null) start = 1;

    const imported = [];
    const errors = [];

    for (let i = start; i < rows.length; i++) {
      const cols = rows[i];
      const lineNo = i + 1;
      const date = normalizeDate(cols[0] ?? "");
      const type = parseType(cols[1] ?? "");
      const category = String(cols[2] ?? "").trim();
      const amount = Math.floor(
        Number(String(cols[3] ?? "").replace(/[,¥\s]/g, ""))
      );
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

      imported.push({ id: generateId(), date, type, category, amount, memo });
    }

    if (imported.length === 0) {
      alert("インポートできる行がありませんでした。\n\n" + errors.slice(0, 10).join("\n"));
      return;
    }

    let message = `${imported.length}件の記録をインポートします。よろしいですか?`;
    if (errors.length > 0) {
      message += `\n\n(${errors.length}件の行はスキップされます)\n` + errors.slice(0, 5).join("\n");
    }
    if (!confirm(message)) return;

    entries.push(...imported);
    saveEntries();
    render();
    alert(`${imported.length}件をインポートしました。`);
  };
  reader.onerror = () => alert("ファイルの読み込みに失敗しました。");
  reader.readAsText(file, "UTF-8");
}

// ---------------------------------------------------------------------------
// イベント登録・初期化
// ---------------------------------------------------------------------------

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

el.importCsvInput.addEventListener("change", () => {
  const file = el.importCsvInput.files[0];
  if (file) importCsv(file);
  el.importCsvInput.value = "";
});

resetForm();
render();

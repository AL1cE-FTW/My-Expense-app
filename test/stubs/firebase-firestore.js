// 極小のインメモリ Firestore もどき。app.js のロジック検証専用。
const store = new Map(); // fullPath -> data
const listenersByCollection = new Map(); // collectionPath -> Set<fn>
let autoIdCounter = 0;

function notify(collectionPath) {
  const set = listenersByCollection.get(collectionPath);
  if (!set) return;
  for (const fn of set) fn();
}

// テストから直接データを仕込むための入口。
// (createdAt を持たない「昔の記録」など、UI経由では作れない状態を再現する用)
if (typeof window !== "undefined") {
  window.__seedDoc = (fullPath, data) => {
    const parts = fullPath.split("/");
    store.set(fullPath, data);
    notify(parts.slice(0, -1).join("/"));
  };
}

export function initializeFirestore(app) {
  return { app };
}

export function persistentLocalCache() {
  return {};
}

export function persistentMultipleTabManager() {
  return {};
}

export function collection(db, path) {
  return { type: "collection", path };
}

export function doc(refOrDb, path) {
  if (path === undefined) {
    // doc(collectionRef) -> 自動ID
    const id = "auto" + ++autoIdCounter;
    return { type: "doc", path: `${refOrDb.path}/${id}`, id, collectionPath: refOrDb.path };
  }
  const parts = path.split("/");
  const id = parts[parts.length - 1];
  return { type: "doc", path, id, collectionPath: parts.slice(0, -1).join("/") };
}

export function query(collRef, ...constraints) {
  return { collRef, constraints };
}

export function orderBy(field, direction = "asc") {
  return { type: "orderBy", field, direction };
}

// arrayUnion などの FieldValue を既存データに適用する (本物の Firestore と同じく
// setDoc(merge:true) でも使えるようにするため共通化)
function applyFieldValues(existing, data) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(data)) {
    if (value && value.__arrayUnion) {
      const current = Array.isArray(merged[key]) ? merged[key] : [];
      const set = new Set(current);
      for (const el of value.__arrayUnion) set.add(el);
      merged[key] = [...set];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function arrayUnion(...elements) {
  return { __arrayUnion: elements };
}

export async function addDoc(collRef, data) {
  const id = "auto" + ++autoIdCounter;
  store.set(`${collRef.path}/${id}`, { ...data });
  notify(collRef.path);
  return { id, path: `${collRef.path}/${id}` };
}

export async function updateDoc(docRef, data) {
  if (!store.has(docRef.path)) {
    throw new Error("No document to update: " + docRef.path);
  }
  store.set(docRef.path, applyFieldValues(store.get(docRef.path) || {}, data));
  notify(docRef.collectionPath);
  notify(docRef.path);
}

export async function setDoc(docRef, data, options) {
  // merge:true なら既存と統合 (無ければ新規作成)、無指定なら全置換
  const base = options?.merge ? store.get(docRef.path) || {} : {};
  store.set(docRef.path, applyFieldValues(base, data));
  notify(docRef.collectionPath);
  notify(docRef.path);
}

export async function deleteDoc(docRef) {
  store.delete(docRef.path);
  notify(docRef.collectionPath);
  notify(docRef.path);
}

export async function getDoc(docRef) {
  return {
    exists: () => store.has(docRef.path),
    data: () => store.get(docRef.path),
  };
}

export function writeBatch() {
  const ops = [];
  return {
    set(docRef, data) {
      ops.push({ docRef, data });
    },
    async commit() {
      const touched = new Set();
      for (const op of ops) {
        store.set(op.docRef.path, { ...op.data });
        touched.add(op.docRef.collectionPath);
      }
      for (const path of touched) notify(path);
    },
  };
}

// onSnapshot(queryOrDocRef, onNext, onError)
export function onSnapshot(target, onNext) {
  const isQuery = Boolean(target.collRef);
  const collectionPath = isQuery ? target.collRef.path : target.collectionPath;

  const emit = () => {
    if (isQuery) {
      const orderByField = target.constraints.find((c) => c.type === "orderBy");
      const docs = [...store.entries()]
        .filter(([path]) => path.startsWith(collectionPath + "/"))
        .filter(([path]) => path.slice(collectionPath.length + 1).indexOf("/") === -1)
        .map(([path, data]) => ({ id: path.split("/").pop(), data: () => data }));
      if (orderByField) {
        const { field, direction } = orderByField;
        docs.sort((a, b) => {
          const av = a.data()[field] ?? "";
          const bv = b.data()[field] ?? "";
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return direction === "desc" ? -cmp : cmp;
        });
      }
      onNext({ docs, forEach: (fn) => docs.forEach(fn) });
    } else {
      onNext({
        exists: () => store.has(target.path),
        data: () => store.get(target.path),
      });
    }
  };

  const key = isQuery ? collectionPath : target.path;
  if (!listenersByCollection.has(key)) listenersByCollection.set(key, new Set());
  listenersByCollection.get(key).add(emit);
  emit();
  return () => listenersByCollection.get(key)?.delete(emit);
}

// 極小の Firebase Auth もどき。app.js のロジック検証専用。
let currentUser = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(currentUser);
}

export function getAuth(app) {
  return { app };
}

export function onAuthStateChanged(auth, fn) {
  listeners.add(fn);
  fn(currentUser);
  return () => listeners.delete(fn);
}

export async function createUserWithEmailAndPassword(auth, email) {
  currentUser = { uid: "uid-" + email, email };
  notify();
  return { user: currentUser };
}

export async function signInWithEmailAndPassword(auth, email) {
  currentUser = { uid: "uid-" + email, email };
  notify();
  return { user: currentUser };
}

export async function signOut() {
  currentUser = null;
  notify();
}

export async function sendPasswordResetEmail() {
  return undefined;
}

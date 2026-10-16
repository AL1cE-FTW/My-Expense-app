// Firebase Cloud Messaging の偽物。宛先 (トークン) を決まった値で返す
export async function isSupported() {
  return true;
}

export function getMessaging(app) {
  return { app };
}

export async function getToken(messaging, options) {
  window.__getTokenOptions = { vapidKey: options.vapidKey, hasRegistration: !!options.serviceWorkerRegistration };
  return "device-token-1";
}

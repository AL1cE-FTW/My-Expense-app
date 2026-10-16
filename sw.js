// 予算の使用率通知を受け取って出すためだけの Service Worker。オフライン用のキャッシュはしない。
// 通知は Apps Script が Firebase Cloud Messaging (FCM) 経由で送る (apps-script/vpass-import.gs)。
// アプリを閉じていても、ブラウザがここを起こして通知を出す。
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { /* 中身が読めなくても通知は出す */ }
  // FCM はデータを data に入れて届ける
  const { title = "家計簿", body = "", tag } = payload.data || payload.notification || {};
  event.waitUntil(self.registration.showNotification(title, { body, tag }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow("./")))
  );
});

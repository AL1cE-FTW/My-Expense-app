// 予算の使用率通知を出すためだけの Service Worker (Android の Chrome は Service Worker 経由でないと通知を出せない)。
// オフライン用のキャッシュはしない。
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow("./")))
  );
});

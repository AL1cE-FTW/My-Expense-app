// このファイルをコピーして js/firebase-config.js を作成し、
// あなた自身の Firebase プロジェクトの設定値を入力してください。
//
//   cp js/firebase-config.example.js js/firebase-config.js
//
// 値の取得方法は README.md の「Firebaseのセットアップ」を参照してください。

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// 予算の使用率通知 (プッシュ通知) を使うときだけ設定する。
// Firebase コンソール →「プロジェクトの設定」→「Cloud Messaging」→
// 「ウェブプッシュ証明書」で作った鍵ペアの公開鍵 (README の「予算の使用率通知」参照)。
// export const fcmVapidKey = "YOUR_VAPID_KEY";

// Lucide (https://lucide.dev) のアイコン。ISCライセンス。
//
// ビルドツールを使わない構成なので、ライブラリをCDNから読むのではなく、
// 使うアイコンの中身 (パス) だけをここに書き出している。
// - 追加のネットワーク依存が増えない (このアプリはオフラインでも動く)
// - CDNが落ちてもアイコンだけ消えるということが起きない
//
// 元データは lucide-static v1.42.0。24x24・線幅2・端は丸め、で描かれている。
// 新しいアイコンを足すときは lucide-static の icons/<名前>.svg の中身をそのまま貼る。

const ICON_PATHS = {
  "chevron-left":
    '<path d="m15 18-6-6 6-6" />',
  "chevron-right":
    '<path d="m9 18 6-6-6-6" />',
  "chevron-up":
    '<path d="m18 15-6-6-6 6" />',
  "chevron-down":
    '<path d="m6 9 6 6 6-6" />',
  // 並び替えの向き。chevron は絵の高さが枠の 1/4 しかなく、見出しに置く
  // 小ささだと線一本に見えてしまうため、枠いっぱいに描かれる arrow を使う
  "arrow-up":
    '<path d="m5 12 7-7 7 7" /> <path d="M12 19V5" />',
  "arrow-down":
    '<path d="M12 5v14" /> <path d="m19 12-7 7-7-7" />',
  "check":
    '<path d="M20 6 9 17l-5-5" />',
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /> <path d="M12 9v4" /> <path d="M12 17h.01" />',
  "house":
    '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /> <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
  "shopping-bag":
    '<path d="M16 10a4 4 0 0 1-8 0" /> <path d="M3.103 6.034h17.794" /> <path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z" />',
  "piggy-bank":
    '<path d="M11 17h3v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a3.16 3.16 0 0 0 2-2h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-1a5 5 0 0 0-2-4V3a4 4 0 0 0-3.2 1.6l-.3.4H11a6 6 0 0 0-6 6v1a5 5 0 0 0 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z" /> <path d="M16 10h.01" /> <path d="M2 8v1a2 2 0 0 0 2 2h1" />',
  "wifi-off":
    '<path d="M12 20h.01" /> <path d="M8.5 16.429a5 5 0 0 1 7 0" /> <path d="M5 12.859a10 10 0 0 1 5.17-2.69" /> <path d="M19 12.859a10 10 0 0 0-2.007-1.523" /> <path d="M2 8.82a15 15 0 0 1 4.177-2.643" /> <path d="M22 8.82a15 15 0 0 0-11.288-3.764" /> <path d="m2 2 20 20" />',
  "settings":
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /> <circle cx="12" cy="12" r="3" />',
  "notebook-pen":
    '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" /> <path d="M2 6h4" /> <path d="M2 10h4" /> <path d="M2 14h4" /> <path d="M2 18h4" /> <path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" />',
};

function iconPath(name) {
  // プロトタイプ由来の値 ("constructor" など) を拾うと、関数の中身が
  // そのまま innerHTML に入ってしまう。自分で持っている名前だけを見る。
  if (Object.hasOwn(ICON_PATHS, name)) return ICON_PATHS[name];
  // 名前を間違えても黙って空になるだけだと気づけないので知らせる
  console.warn(`不明なアイコン名です: ${name}`);
  return "";
}

/**
 * アイコンのSVG要素を作る。
 * 大きさは font-size に追従し (1em)、色は currentColor になるので、
 * 置いた場所の文字と同じ大きさ・同じ色で並ぶ。
 */
export function createIcon(name, { className = "", label = "" } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", className ? `icon ${className}` : "icon");

  // 意味を持つアイコンには読み上げ用の名前を付け、飾りなら読み上げから外す
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }

  // 中身は自前の定数なので、外部入力が混ざることはない
  svg.innerHTML = iconPath(name);
  return svg;
}

/**
 * HTML側に置いた <span data-icon="名前"> をアイコンに差し替える。
 * 起動時に1回呼ぶ。data-icon-label があれば読み上げ用の名前として使う。
 */
export function hydrateIcons(root = document) {
  for (const holder of root.querySelectorAll("[data-icon]")) {
    const svg = createIcon(holder.dataset.icon, {
      className: holder.dataset.iconClass || "",
      label: holder.dataset.iconLabel || "",
    });
    holder.replaceWith(svg);
  }
}

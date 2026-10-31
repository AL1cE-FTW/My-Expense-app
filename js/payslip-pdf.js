// 給与明細の PDF を読み込む。給与サイトの明細が PDF で開く (PDF の画面では
// ブックマークが動かない) とき用。PDF の文字を位置ごとに取り出し、ブックマークと
// 同じ「項目名と値の組」にして interpretPayslipImport() に渡す。
// 読み込みは端末のブラウザの中だけで行い、PDF をどこかへ送ることはない。

const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
const SECTION = /^(勤怠|支給|控除|記事|勤怠項目|支給項目|控除項目|その他)$/;

// ブックマークレットと同じ判定: 金額か日付なら「値」
function isValue(text) {
  const s = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return (
    /^[▲△－−-]?[¥￥]?[\d,，]{1,13}円?$/.test(s.replace(/\s/g, "")) ||
    /\d{4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}/.test(s)
  );
}

/**
 * PDF の文字 ([{ str, x, y, w }]、y は上ほど小さい) から、ブックマークと同じ形の
 * 受け渡し内容を作る。明細は「項目名の行の下に、同じ列の金額の行」が並ぶ表で、
 * 項目名は列の中央、金額は列の右に寄っている。金額の右端が入る列の項目名と組にする。
 */
export function payloadFromPdfItems(items) {
  const cells = items
    .map((it) => ({ ...it, str: String(it.str || "") }))
    .filter((it) => it.str !== "")
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // 高さの近い文字を1行にまとめる
  const rows = [];
  for (const it of cells) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - it.y) <= 3) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  // PDF の文字は「2026」「年」「10」…のように細切れなので、隙間なく続くものを1語につなぐ。
  // 空白だけの文字は語の区切り
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    const words = [];
    let gap = true;
    for (const it of row.items) {
      if (!it.str.trim()) {
        gap = true;
        continue;
      }
      const last = words[words.length - 1];
      if (last && !gap && it.x - (last.x + last.w) < 1.5) {
        last.str += it.str;
        last.w = it.x + it.w - last.x;
      } else {
        words.push({ ...it, str: it.str.trim() });
      }
      gap = false;
    }
    row.items = words;
  }

  const isLabel = (it) =>
    !isValue(it.str) && it.str.length <= 20 && !SECTION.test(it.str.replace(/\s/g, ""));
  const center = (it) => it.x + it.w / 2;

  // すぐ下の行 (1つ空いていてもよい) のうち、値のある行
  const valueRowBelow = (i) =>
    rows.slice(i + 1, i + 3).find((r) => r.items.some((it) => isValue(it.str)));

  // 列の幅: 下に値の行がある項目名の行で、中心どうしのいちばん狭い間隔
  // (氏名の行のような、表の外の文字の間隔は使わない)
  let columnWidth = Infinity;
  for (const [i, row] of rows.entries()) {
    if (!valueRowBelow(i)) continue;
    const centers = row.items.filter(isLabel).map(center);
    for (let i = 1; i < centers.length; i++) {
      const gap = centers[i] - centers[i - 1];
      if (gap > 20) columnWidth = Math.min(columnWidth, gap);
    }
  }
  if (!Number.isFinite(columnWidth)) columnWidth = 90;
  const half = columnWidth / 2;

  const pairs = [];
  let section = "";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const only = row.items.length === 1 ? row.items[0].str.replace(/\s/g, "") : "";
    if (SECTION.test(only)) {
      section = only;
      continue;
    }
    const labels = row.items.filter(isLabel);
    if (labels.length === 0) continue;
    const below = valueRowBelow(i);
    if (!below) continue;
    for (const label of labels) {
      const c = center(label);
      const value = below.items.find((it) => {
        const right = it.x + it.w;
        return isValue(it.str) && right > c - half && right <= c + half + 1;
      });
      if (value) pairs.push([label.str, value.str, section]);
    }
  }

  const text = rows.map((r) => r.items.map((it) => it.str).join(" ")).join(" ");
  const period = text.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*度?/);
  const payDate = text.match(/支給日\s*[:：]?\s*(\d{4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2})/);
  return {
    v: 1,
    pairs,
    period: period ? period[0] : "",
    payDate: payDate ? payDate[1] : "",
    bonus: /賞与/.test(text) && !/本給|基本給/.test(text),
  };
}

// PDF ファイル (1ページ目) から受け渡し内容を作る
export async function readPayslipPdf(file) {
  const pdfjs = await import(PDFJS_BASE + "pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await doc.getPage(1);
  const { height } = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  return payloadFromPdfItems(
    items.map((it) => ({ str: it.str, x: it.transform[4], y: height - it.transform[5], w: it.width }))
  );
}

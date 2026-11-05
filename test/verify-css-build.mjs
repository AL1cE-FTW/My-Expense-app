// css/app.css (GitHub Pages で配る CSS) が、css/input.css・css/layout.css と
// index.html・js から作り直したものと同じかを確かめる。
// CSS やクラス名を変えたのに `npm run build:css` を忘れると、公開した画面だけ
// 崩れる (テストは通ってしまう) ので、ここで止める。
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "css-")), "app.css");
execFileSync(
  path.join(root, "node_modules", ".bin", "tailwindcss"),
  ["-i", "css/input.css", "-o", out, "--minify"],
  { cwd: root, stdio: "pipe" }
);
const built = fs.readFileSync(out, "utf-8");
const committed = fs.readFileSync(path.join(root, "css", "app.css"), "utf-8");
if (built !== committed) {
  throw new Error("css/app.css が古いままです。`npm run build:css` を実行してからコミットしてください");
}
console.log("CSS BUILD IS UP TO DATE");

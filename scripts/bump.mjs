// 发版辅助：同步 manifest.json / version.json / 下载 URL / 发布日期
// 用法（在仓库根目录执行）：
//   node scripts/bump.mjs 3.3.0 "修复时段矩阵在窄屏下的换行"
// 之后 git commit + git push 到 main，GitHub Actions 会自动打 zip 并创建 Release。
import { readFileSync, writeFileSync } from "node:fs";

const OWNER = "hubiqi";
const REPO = "fengshen-ext";
const [version, ...rest] = process.argv.slice(2);
const notes = rest.join(" ").trim() || "功能更新与问题修复";

if (!/^\d+(\.\d+){0,3}$/.test(version || "")) {
  console.error("用法：node scripts/bump.mjs <版本号> \"<更新说明>\"，例如 3.3.0");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const previous = manifest.version;
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// 用本机当地日期，别用 UTC：GMT+8 的凌晨发版会被写成前一天
const now = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const localDate = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;

const versionFile = {
  version,
  notes,
  download: `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/fengshen-ext-v${version}.zip`,
  published_at: localDate
};
writeFileSync("version.json", JSON.stringify(versionFile, null, 2) + "\n");

console.log(`v${previous} -> v${version}`);
console.log(`下载地址：${versionFile.download}`);
console.log("下一步：git add -A && git commit -m \"release: v" + version + "\" && git push origin main");
console.log("推送后 GitHub Actions 会自动生成同名 Release 与 zip，插件随后即可检查到新版本。");

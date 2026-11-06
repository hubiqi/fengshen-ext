# 风神考核看板（Chrome 扩展 · 通用版）

风神页面常驻小图标，点击直接展开考核看板：**规划单量完成率、标 2 骑手占比、考核得分、时段 × 商圈片达成矩阵**。全部数据在本机浏览器内获取，跟随当前浏览器登录态，换账号自动换商，无需本地服务、无需 Python。

从 **v3.2.0** 起支持从本 GitHub 仓库自动检查与更新新版本。

---

## 安装

1. 到 [Releases](https://github.com/hubiqi/fengshen-ext/releases/latest) 下载最新的 `fengshen-ext-vX.Y.Z.zip`，解压到一个**固定、不会移动**的目录（例如 `~/Extensions/fengshen-ext`）。
2. 打开 `chrome://extensions`，右上角开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择刚才解压的目录。

> 环境要求：Chrome / Edge **111 及以上**（service worker 使用 ES module 与 Promise 风格扩展 API）。
> 已在风神页面登录的前提下，点击页面右上角悬浮球或浏览器工具栏图标即可打开看板。

---

## 自动更新怎么工作

版本源是仓库根目录的 [`version.json`](./version.json)：

```json
{
  "version": "3.2.0",
  "notes": "本次更新说明",
  "download": "https://github.com/hubiqi/fengshen-ext/releases/download/v3.2.0/fengshen-ext-v3.2.0.zip",
  "published_at": "2026-11-06"
}
```

插件里的 `updater.js`（service worker）会：

| 时机 | 行为 |
| --- | --- |
| 安装 / 每次浏览器启动 / 每 6 小时 | 匿名读取 `raw.githubusercontent.com/hubiqi/fengshen-ext/main/version.json`，与当前版本比较 |
| 发现新版本 | 工具栏图标出现红色 `NEW` 角标、风神页面悬浮球出现红标、看板顶部出现蓝色更新条（含版本说明） |
| 点「下载新版 zip」 | 直接下载 Release 里的安装包，并开始 30 分钟的快速磁盘轮询 |
| 新版文件覆盖到插件目录后 | 读到磁盘上的 `version.json` 比运行时新，自动 `chrome.runtime.reload()`，**无需手动去 `chrome://extensions` 点重新加载** |
| 看板「检查更新」按钮 | 随时手动触发一次检查；「忽略此版本」可关掉当前版本的提示 |

**一个绕不开的限制**：Chrome 扩展运行在沙箱里，不能改写自己的安装目录。所以「检查 / 提示 / 下载 / 重载」全部自动，但**把新版文件放进插件目录**这一步需要你做一次：

1. 在看板更新条点「下载新版 zip」（或手动到 Releases 下载）。
2. 解压，把里面的文件**覆盖**到当初加载的那个插件目录（注意包含 `version.json`，不要套一层子目录）。
3. 完成。插件会在 1 分钟内自动检测并重载；也可以点更新条上的「已覆盖 · 立即生效」马上生效，或到 `chrome://extensions` 点「重新加载」。

> 如果你是通过 Chrome 应用商店安装的扩展，浏览器本身会自动更新，不需要本机制。本仓库面向「加载已解压的扩展程序」的使用方式。
> 仓库是公开的，检查更新**不需要任何令牌**；插件只读取版本号文件，业务数据只在你本机与风神站点之间流转，不会上传 GitHub。

---

## 发新版本（维护者）

```bash
# 1. 同步版本号、更新说明、下载 URL
node scripts/bump.mjs 3.3.0 "修复时段矩阵在窄屏下的换行"

# 2. 提交并推送
git add -A
git commit -m "release: v3.3.0"
git push origin main
```

推送后 [`.github/workflows/release.yml`](./.github/workflows/release.yml) 会自动：

- 读取 `version.json` 的版本号；若该版本尚无 Release，则把运行时文件打成 `fengshen-ext-vX.Y.Z.zip`；
- 创建 `vX.Y.Z` Release 并附上 zip（版本未变化时重复推送不会重复发版，安全幂等）。

Release 出现后，所有已安装的插件最迟 6 小时内自动发现新版本；点「检查更新」可立即发现。

> 首次在某台机器上用 git 维护本地插件目录时，若本地目录原本不是 git 仓库，可执行：
> `git init && git remote add origin https://github.com/hubiqi/fengshen-ext.git && git fetch origin && git reset --hard origin/main`
> （该命令会用远端内容对齐本地，请先确认本地没有未提交的重要改动。）

---

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3 清单（权限、host 权限、ES module service worker） |
| `sw.js` | 请求头规则、看板标签页、静默桥接通道、消息路由 |
| `updater.js` | **自动更新**：版本检查、状态存储、下载、磁盘自检与自动重载 |
| `update-ui.js` | **自动更新**：看板顶部提示条与「检查更新」按钮 |
| `launcher.js` | 风神页面常驻悬浮球、看板浮层、新版本红标 |
| `dashboard.html` / `.css` / `.js` | 看板页面（1:1 复刻钉钉考核看板） |
| `assess.js` / `xlsx.js` | 考核口径计算、xlsx 解析 |
| `rules.json` | declarativeNetRequest 静态规则 |
| `version.json` | 版本清单（插件检查更新的唯一数据源） |

---

## 常见问题

- **提示「检查更新失败」**：确认网络能访问 `raw.githubusercontent.com`；公司网络可能拦截该域名，重试或手动到 Releases 页面查看即可，不影响看板取数。
- **下载 404**：Release 由 GitHub Actions 在推送后自动生成，稍等 1–2 分钟再试；也可在 Releases 页面手动下载。
- **覆盖了文件但没自动重载**：确认 `version.json` 也一起覆盖、且目录就是 `chrome://extensions` 里显示的那个目录；点「已覆盖 · 立即生效」可强制检测。
- **权限说明**：`alarms`（定时检查）、`downloads`（下载 zip）、`https://raw.githubusercontent.com/*`（读取版本文件）均为自动更新所需；`tabs` / `storage` / `scripting` / `declarativeNetRequestWithHostAccess` 为原有看板取数能力。

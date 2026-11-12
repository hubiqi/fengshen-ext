#!/usr/bin/env node
"use strict";
/*
 * 风神看板 · 热更新本地助手（Native Messaging Host）
 *
 * 为什么需要它：Chrome MV3 扩展不能改写自身安装目录。这个常驻在用户机器上的小助手
 * 拥有正常文件写权限，负责把扩展下载好的新版 zip 静默解压覆盖到扩展目录，从而让
 * 「热更新」按钮做到真正的「点一下全自动」。
 *
 * 通信：Chrome 原生消息协议 —— 每条消息前加 4 字节小端长度头，JSON 文本。
 * 命令：
 *   { type: "ping" }                       -> { ok: true, version }
 *   { type: "apply", name | zip }          -> { ok: true } 解压覆盖后返回；失败返回 { ok: false, error }
 *
 * 安全护栏：extDir 必须含 manifest.json；zip 必须落在 ~/Downloads 或 /tmp（或 ~/Library/Caches）；
 * 不在白名单目录的 zip 一律拒绝。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "host.config.json");
const LOG_PATH = path.join(__dirname, "host.log");

function log() {
  const parts = Array.from(arguments).map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  try { fs.appendFileSync(LOG_PATH, "[" + new Date().toISOString() + "] " + parts.join(" ") + "\n"); } catch (e) { /* ignore */ }
}

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch (e) { log("config read error:", String(e)); }

const HOME = process.env.HOME || ("/Users/" + (process.env.USER || ""));
const VERSION = (cfg && cfg.version) || "1.0.0";

// ----------------------------------------------------------------- stdio 帧
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = buf.slice(4, 4 + len);
    buf = buf.slice(4 + len);
    let obj = null;
    try { obj = JSON.parse(msg.toString("utf8")); } catch (e) { log("bad json"); continue; }
    try { handle(obj); } catch (e) { log("handle error:", String(e)); send({ ok: false, error: String(e) }); }
  }
});
process.stdin.on("end", () => process.exit(0));

function send(obj) {
  const s = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(s.length, 0);
  try { process.stdout.write(Buffer.concat([head, s])); } catch (e) { log("write error:", String(e)); }
}

function fail(error) { send({ ok: false, error: String(error) }); }

function resolveZip(msg) {
  let rp;
  if (msg && msg.zip && typeof msg.zip === "string") {
    rp = path.resolve(msg.zip);
  } else if (msg && msg.name && typeof msg.name === "string") {
    rp = path.join(HOME, "Downloads", path.basename(msg.name));
  } else {
    return null;
  }
  const allowed = [
    path.join(HOME, "Downloads"),
    "/tmp",
    path.join(HOME, "Library", "Caches")
  ];
  const okDir = allowed.some((d) => rp === d || rp.startsWith(d + path.sep));
  if (!okDir) return null;
  return rp;
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return fail("无效消息");
  if (msg.type === "ping") return send({ ok: true, version: VERSION });

  if (msg.type === "apply") {
    const extDir = (cfg && cfg.extDir) || "";
    if (!extDir || !fs.existsSync(path.join(extDir, "manifest.json"))) {
      return fail("未配置或找不到扩展目录，请重新运行安装助手（install-native.command）");
    }
    const rp = resolveZip(msg);
    if (!rp) return fail("zip 路径不在允许的目录（下载 / 临时）");
    if (!fs.existsSync(rp) || !fs.statSync(rp).isFile()) return fail("找不到 zip 文件：" + rp);
    try {
      log("apply:", rp, "->", extDir);
      execFileSync("unzip", ["-o", "-q", rp, "-d", extDir], { timeout: 120000, stdio: "ignore" });
      try { fs.unlinkSync(rp); } catch (e) { /* ignore */ }
      log("apply done");
      return send({ ok: true });
    } catch (e) {
      log("unzip failed:", String(e));
      return fail("解压失败：" + String(e));
    }
  }
  return fail("未知指令：" + (msg.type || "?"));
}

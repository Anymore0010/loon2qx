#!/usr/bin/env bun
/**
 * Loon 插件（.lpx）-> Quantumult X 重写/分流资源 转换器。
 *
 * 输入： vendor/loon-plugins/*.lpx（tools/fetch-plugins.mjs 抓的源配置原样副本）
 * 输出： QuantumultX/rules/kelee/<plugin>.conf   —— 纯重写资源（rewrite_remote）
 *        QuantumultX/rules/kelee/<plugin>.list   —— 纯分流资源（filter_remote）
 *        QuantumultX/rules/kelee/_hostnames.conf —— 汇总的 hostname 行（供 [mitm] 参考）
 *        QuantumultX/rules/kelee/_conversion-report.json —— 统计与跳过明细
 *
 * 为什么必须转换而不能直接引用 .lpx：
 *   QX 的 rewrite_remote 只解析 QX 重写语法（`<正则> url <动作> [参数]`），而 Loon 的
 *   [Rewrite] 段用 `<正则> <动作>`（**没有 url 关键字**），[Script]/[Rule] 是独立段落、
 *   QX 完全不认。直接引用 → 整份资源静默失效（不报错、没效果）。
 *
 * 转换映射（动作名以 QX 官方 sample.conf 为准）：
 *   [Rewrite] `<regex> reject-dict`                  -> `<regex> url reject-dict`
 *   [Rewrite] `<regex> response-body-json-del A B`   -> `<regex> url jsonjq-response-body 'del(.A, .B)'`
 *   [Rewrite] `<regex> response-body-json-jq <expr>` -> `<regex> url jsonjq-response-body <expr>`
 *   [Rewrite] `<regex> response-body-json-replace a <v>` -> `<regex> url jsonjq-response-body '.a = <v>'`
 *   [Rewrite] `<regex> <302|307> <url>`              -> `<regex> url <302|307> <url>`
 *   [Script]  `http-response <regex> script-path=U`  -> `<regex> url script-response-body U`
 *   [Script]  `http-request  <regex> script-path=U`  -> `<regex> url script-request-body U`
 *   [Rule]    `DOMAIN,x,REJECT[,no-resolve]`         -> `host, x, reject`（no-resolve 直接丢弃）
 *   [MitM]    `hostname=a, b`                        -> 汇总进 _hostnames.conf
 *
 * 无法转换、显式跳过的（QX 无对应语法；写了会被静默丢弃或让整份资源失效）：
 *   - AND/OR/NOT 组合规则（QX 分流不支持逻辑组合）
 *   - QX 分流词表里没有的类型：URL-REGEX / USER-AGENT / DEST-PORT / PROTOCOL
 *   - `request/response if ${url} ~= ...` 这类 Loon 脚本化写法
 *   - `mock-response-body` / `response-header-add` / `header` 等 QX 不存在的动作名
 *   - `jq-path="..."`（Loon 外链 jq 文件）：QX 不会去取这个文件；而这些 .jq 是多行且含
 *     `#` 注释，内联进单行 rewrite 会把行拆断，风险大于收益，故跳过。
 *
 * 用法： bun tools/convert-plugins.mjs [--check]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ruleSig, sameTarget } from "./lib/rule-target.mjs";
import { resolveRepoBase } from "./repo-url.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "loon-plugins");
const OUT = join(ROOT, "QuantumultX", "rules", "kelee");
const CHECK = process.argv.includes("--check");
const repoBase = resolveRepoBase(ROOT).rawBase;

/**
 * kelee.one 只对 Loon 的 User-Agent 放行（其余 UA 返回 Cloudflare 403）。
 * Quantumult X 抓脚本用的是它自己的 UA —— 所以**绝不能**把 kelee.one 的脚本地址
 * 直接写进配置：设备端会 403，脚本静默不执行，功能看起来"没生效"。
 * 因此所有脚本都必须镜像进本仓库，URL 改写成本仓库地址。
 */
const LOON_UA = "Loon/998 CFNetwork/3896.200.41 Darwin/27.2.0";

/** URL -> 仓库内镜像路径（与 fetch-snapshot.mjs 的 localPathFor 保持一致）。 */
function mirrorPathFor(url) {
  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
  if (m) return `snapshot/github.com/${m[1]}`;
  const u = new URL(url);
  return `snapshot/host/${u.hostname}${u.pathname}`;
}

const scriptMisses = [];
/** 把脚本抓进仓库；返回仓库内相对路径，失败返回 null。 */
async function mirrorScript(url) {
  const rel = mirrorPathFor(url);
  const abs = join(ROOT, rel);
  if (existsSync(abs) && statSync(abs).size > 100) return rel;
  // 优先用 vendor/loon-plugins/_assets 里的离线副本（网络不稳时也能重建）
  const base = url.split("/").pop().split("?")[0];
  const offline = join(VENDOR, "_assets", base);
  let body = null;
  if (existsSync(offline)) {
    const b = readFileSync(offline);
    if (b.length > 100) body = b;
  }
  if (!body) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": LOON_UA, accept: "*/*", "accept-language": "zh-CN,zh-Hans;q=0.9" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error(`响应过小 (${buf.length}B)`);
      body = buf;
    } catch (e) {
      scriptMisses.push({ url, error: String(e.message) });
      return null;
    }
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return rel;
}

/** 递归列出目录下匹配扩展名的文件（fetch-snapshot 的扫描是非递归的，这里不依赖它）。 */
function walk(dir, re, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, re, out);
    else if (re.test(n)) out.push(p);
  }
  return out;
}

const skipReport = [];
const pluginReport = [];

/** 取某个 [Section] 的正文行（不含段头）。 */
function sectionLines(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `[${name.toLowerCase()}]`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** 去掉注释（QX 的 # / Loon 的 # 与 ;）与首尾空白；返回 null 表示不是有效规则。 */
function cleanRule(line) {
  if (/^\s*[#;]/.test(line)) return null;
  const s = line.replace(/\s*#.*$/, "").trim();
  return s.length ? s : null;
}

const LOON_POLICY = {
  REJECT: "reject",
  "REJECT-DICT": "reject-dict",
  "REJECT-200": "reject-200",
  "REJECT-ARRAY": "reject-array",
  "REJECT-IMG": "reject-img",
  "REJECT-DROP": "reject-drop",
  "REJECT-NO-DROP": "reject",
  DIRECT: "direct",
  PROXY: "proxy",
};

/** Loon 分流类型 -> QX。QX 只认官方 sample.conf 里那几种。 */
const RULE_MAP = {
  DOMAIN: "host",
  "DOMAIN-SUFFIX": "host-suffix",
  "DOMAIN-KEYWORD": "host-keyword",
  "DOMAIN-WILDCARD": "host-wildcard",
  "IP-CIDR": "ip-cidr",
  "IP-CIDR6": "ip6-cidr",
  GEOIP: "geoip",
};

/** `a.b c.d` -> `del(.a.b, .c.d)` */
function jsonDelToJq(paths) {
  return `'del(${paths.map((p) => `.${p}`).join(", ")})'`;
}

/** 转换 [Rewrite] 的一行。Loon 是 `<regex> <action> [args]`，QX 是 `<regex> url <action> [args]`。 */
function convertRewrite(line, plugin) {
  const m = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
  if (!m) return null;
  const [, pattern, action, rest] = m;
  const a = action.toLowerCase();

  if (["reject", "reject-dict", "reject-200", "reject-array", "reject-img"].includes(a)) {
    return `${pattern} url ${a}`;
  }
  if (a === "reject-drop" || a === "reject-no-drop") return `${pattern} url reject-drop`;

  // jq-path="..."（外链 .jq 文件）：QX 不会取这个文件。这些 .jq 是多行且含 # 注释，
  // 内联进单行 rewrite 会把行拆断 —— 跳过并记账，绝不静默失效。
  if (/jq[-_]path\s*=|jq_file\s*=/i.test(rest)) {
    skipReport.push({
      plugin, section: "Rewrite", line,
      reason: 'jq-path=/jq_file=（Loon 外链 jq 文件）QX 无法加载；内联多行 jq 会拆断单行 rewrite',
    });
    return null;
  }

  if (a === "response-body-json-del") {
    const paths = rest.trim().split(/\s+/).filter(Boolean);
    if (!paths.length) {
      skipReport.push({ plugin, section: "Rewrite", line, reason: "response-body-json-del 无路径参数" });
      return null;
    }
    return `${pattern} url jsonjq-response-body ${jsonDelToJq(paths)}`;
  }
  if (a === "response-body-json-replace") {
    const toks = rest.trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2 || toks.length % 2 !== 0) {
      skipReport.push({ plugin, section: "Rewrite", line, reason: "response-body-json-replace 参数不成对" });
      return null;
    }
    const sets = [];
    for (let i = 0; i < toks.length; i += 2) sets.push(`.${toks[i]} = ${toks[i + 1]}`);
    return `${pattern} url jsonjq-response-body '${sets.join(" | ")}'`;
  }
  if (a === "response-body-json-jq" || a === "request-body-json-jq") {
    const expr = rest.trim();
    if (!expr) {
      skipReport.push({ plugin, section: "Rewrite", line, reason: "json-jq 无表达式" });
      return null;
    }
    const act = a.startsWith("response") ? "jsonjq-response-body" : "jsonjq-request-body";
    return `${pattern} url ${act} ${expr}`;
  }
  if (a === "response-body" || a === "request-body") {
    if (!/\sresponse-body\s+/.test(rest)) {
      skipReport.push({ plugin, section: "Rewrite", line, reason: `${a} 需要成对的 search/replace` });
      return null;
    }
    return `${pattern} url ${a} ${rest}`;
  }
  if (a === "302" || a === "307") return `${pattern} url ${a} ${rest.trim()}`;

  if (["mock-response-body", "header", "response-header", "request-header", "response-header-add",
       "response-header-del", "request-header-add", "response-body-json",
       "response-body-replace-regex", "response-body-replace"].includes(a)) {
    skipReport.push({ plugin, section: "Rewrite", line, reason: `QX 无此动作名（${action}）` });
    return null;
  }
  skipReport.push({ plugin, section: "Rewrite", line, reason: `未识别的 Loon 重写动作 "${action}"` });
  return null;
}

/** 转换 [Script] 的一行。只处理 http-request / http-response 这种直白形式。 */
function convertScript(line, plugin) {
  const m = line.match(/^(http-request|http-response)\s+(\S+)\s+(.*)$/);
  if (!m) {
    skipReport.push({
      plugin, section: "Script", line,
      reason: "Loon 脚本化写法（`request/response if ${url} ~= ...`），QX 无等价语法",
    });
    return null;
  }
  const [, trigger, pattern, optsRaw] = m;
  const sp = optsRaw.match(/script-path=(\S+?)(?:,|$)/);
  if (!sp) {
    skipReport.push({ plugin, section: "Script", line, reason: "没有 script-path=" });
    return null;
  }
  const scriptUrl = sp[1].replace(/["',]+$/, "");
  const action = trigger === "http-request" ? "script-request-body" : "script-response-body";
  return `${pattern} url ${action} ${scriptUrl}`;
}

/** 转换 [Rule] 的一行。 */
function convertRule(line, plugin) {
  if (/^(AND|OR|NOT)\s*[,((]/i.test(line)) {
    skipReport.push({ plugin, section: "Rule", line, reason: "QX 分流不支持 AND/OR/NOT 组合规则" });
    return null;
  }
  const parts = line.split(",").map((x) => x.trim());
  const type = parts[0].toUpperCase();
  const qxType = RULE_MAP[type];
  if (!qxType) {
    skipReport.push({ plugin, section: "Rule", line, reason: `QX 分流词表无此类型（${type}）` });
    return null;
  }
  if (parts.length < 3) {
    skipReport.push({ plugin, section: "Rule", line, reason: "字段不足（缺策略）" });
    return null;
  }
  const value = parts[1];
  // Loon 允许「策略之后」再跟一个 no-resolve 修饰符：`IP-CIDR, x/32, REJECT, no-resolve`。
  // 早先误把它当策略位冲突而丢掉了 75 条有效规则；正确做法是丢掉该修饰符、保留策略。
  const fields = parts.slice(2).filter((x) => !/^no-resolve$/i.test(x));
  const policy = (fields[fields.length - 1] ?? "").replace(/\s*\/\/.*$/, "").trim();
  if (!policy) {
    skipReport.push({ plugin, section: "Rule", line, reason: "剥离 no-resolve 后没有策略了" });
    return null;
  }
  return `${qxType}, ${value}, ${LOON_POLICY[policy.toUpperCase()] ?? policy}`;
}

/** 从 [MitM] 段提取 hostname。 */
function extractHostnames(text) {
  const out = [];
  for (const raw of sectionLines(text, "MitM") ?? []) {
    const line = cleanRule(raw);
    if (!line || !/^hostname\s*=/i.test(line)) continue;
    for (const h of line.split("=", 2)[1].split(",")) {
      const v = h.trim();
      // 排除 Loon 的 `-host` 取反写法；QX 的 hostname 只列要解密的主机名
      if (v && /^[A-Za-z0-9*?._-]+$/.test(v) && !v.startsWith("-")) out.push(v);
    }
  }
  return out;
}

function meta(text) {
  const name = text.match(/^#!name\s*=\s*(.+)$/m);
  return { name: name ? name[1].trim() : "" };
}

// ---------------------------------------------------------------- main

const index = JSON.parse(readFileSync(join(VENDOR, "index.json"), "utf8"));
mkdirSync(OUT, { recursive: true });

/**
 * 跨源「同一响应体被重复处理」检测。
 *
 * 真实形态是**同一接口、不同正则写法**（例如 fmz 聚合用
 * `^https?:\/\/app-api\.smzdm\.com\/util\/update$`，kelee 用别的写法），
 * 所以只比字符串不够，必须用语义判据（同域 + ≥2 个有区分度的共同路径词元）。
 * 判据实现复用 tools/lib/rule-target.mjs —— 与 validate.mjs 同一套，避免两边结论不一致。
 */
const claimedSigs = []; // {sig, line, from}
/**
 * 整行完全相同的登记表。**必须与语义判据并用**：
 * sameTarget 要求「同域 + ≥2 个有区分度的共同路径词元」，像
 * `^https:\/\/app\.bilibili\.com\/x\/v2\/feed\/index\?` 这种路径只有 feed 一个词元，
 * 语义判据判不出来，但两边**逐字相同**、同样会把同一个响应体处理两次。
 * （实测漏掉 2 条，靠 validate.mjs 的精确比对才发现。）
 */
const claimedExact = new Map(); // line -> from

/** 只有会「改写请求/响应体」的动作重复才危险；reject 类重复无害。 */
function isBodyRewriteLine(line) {
  return /\surl\s+(script-|jsonjq-)/.test(line);
}

/**
 * 把其他 rewrite_remote 资源已声明的 (正则, 动作) 与语义签名登记进来，
 * 使 kelee 侧不再重复产出。
 */
function seedFromOtherSources() {
  const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));
  for (const r of src.rewrites ?? []) {
    if (r.kelee_plugin) continue; // 本转换器的产物，跳过
    const rel = r.local_file ?? snapshotPathFor(r.url);
    if (!rel) continue;
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    let n = 0;
    for (const raw of readFileSync(abs, "utf8").split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || /^[#;]/.test(t) || !/\surl\s/.test(t)) continue;
      n++;
      if (!isBodyRewriteLine(t)) continue;
      const pat = t.split(/\s+url\s+/)[0];
      const fromRel = rel.replace(/\\/g, "/");
      claimedSigs.push({ sig: ruleSig(pat), line: t, from: fromRel });
      if (!claimedExact.has(t)) claimedExact.set(t, fromRel);
    }
    if (n) seeded.push({ from: rel, n });
  }
}
function snapshotPathFor(url) {
  const m = (url ?? "").match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
  if (m) return `snapshot/github.com/${m[1]}`;
  const m2 = (url ?? "").match(/^https:\/\/([^/]+)\/(.+)$/);
  return m2 ? `snapshot/host/${m2[1]}/${m2[2]}` : null;
}

const seeded = [];
seedFromOtherSources();

const allHostnames = new Set();
let wrote = 0;
let deduped = 0;

for (const p of index.plugins) {
  if (!p.file) continue;
  // 源配置里 enabled=false 的插件（BoxJs / Sub-Store）：不产出文件。
  // 它们对应的功能在 sources.json 里由社区版条目承担、同样处于禁用状态；
  // 若为禁用的插件也生成文件，磁盘上就会出现「已生成但无人引用」的孤儿文件
  // （validate 的 checkOrphanedRuleFiles 会直接报错，提醒功能被静默删除）。
  if (!p.enabled) {
    pluginReport.push({
      plugin: p.name, name: meta(readFileSync(join(ROOT, p.file), "utf8")).name || p.name,
      enabled: false, rules: 0, rewrites: 0, hostnames: 0,
    });
    continue;
  }
  const text = readFileSync(join(ROOT, p.file), "utf8");
  const nm = meta(text).name || p.name.replace(/\.lpx$/, "");
  const enabled = p.enabled;
  const selfRel = `QuantumultX/rules/kelee/${p.name.replace(/\.lpx$/, "")}.conf`;

  const rules = [];
  for (const raw of sectionLines(text, "Rule") ?? []) {
    const line = cleanRule(raw);
    if (!line) continue;
    const r = convertRule(line, p.name);
    if (r) rules.push(r);
  }

  const rewrites = [];
  for (const raw of sectionLines(text, "Rewrite") ?? []) {
    const line = cleanRule(raw);
    if (!line) continue;
    const r = convertRewrite(line, p.name);
    if (r) rewrites.push(r);
  }
  for (const raw of sectionLines(text, "Script") ?? []) {
    const line = cleanRule(raw);
    if (!line) continue;
    const r = convertScript(line, p.name);
    if (r) rewrites.push(r);
  }

  // 语义去重：与「其他源」以及「已产出的兄弟插件」比对同一响应体
  const kept = [];
  for (const r of rewrites) {
    if (!isBodyRewriteLine(r)) {
      kept.push(r);
      continue;
    }
    const pat = r.split(/\s+url\s+/)[0];
    const sig = ruleSig(pat);
    const exactFrom = claimedExact.get(r);
    const clash = claimedSigs.find((e) => e.from !== selfRel && sameTarget(sig, e.sig));
    if (exactFrom && exactFrom !== selfRel) {
      deduped++;
      skipReport.push({
        plugin: p.name, section: "Rewrite", line: r,
        reason: `与 ${exactFrom} 逐字相同的重写（同一响应体会被处理两次）`,
      });
      continue;
    }
    if (clash) {
      deduped++;
      skipReport.push({
        plugin: p.name, section: "Rewrite", line: r,
        reason: `与 ${clash.from} 命中同一接口、被其先处理（避免同一响应体处理两次）`,
      });
      continue;
    }
    claimedSigs.push({ sig, line: r, from: selfRel });
    if (!claimedExact.has(r)) claimedExact.set(r, selfRel);
    kept.push(r);
  }

  // 脚本 URL 必须改写成本仓库镜像地址：kelee.one 对 QX 的 UA 返回 403，
  // 直接写上游地址 → 设备端脚本静默不执行（本次故障的主因之一）。
  const localized = [];
  for (const r of kept) {
    const m = r.match(/^(.*\surl\s+script-\S+\s+)(https?:\/\/\S+)$/);
    if (!m) {
      localized.push(r);
      continue;
    }
    const rel = await mirrorScript(m[2]);
    localized.push(rel ? `${m[1]}${repoBase}/${rel}` : r);
  }

  const hosts = extractHostnames(text);
  if (enabled) for (const h of hosts) allHostnames.add(h);

  const header = [
    `# ${nm}  —— 由 vendor/loon-plugins/${p.name} 自动转换（tools/convert-plugins.mjs）`,
    `# 源插件: ${p.url}`,
    `# 源配置里 enabled=${enabled}`,
    "# 请勿手工编辑：改源插件后重新运行 bun tools/fetch-plugins.mjs && bun tools/convert-plugins.mjs",
  ];

  if (rules.length) {
    writeIfChanged(join(OUT, `${p.name.replace(/\.lpx$/, "")}.list`), [...header, "", ...rules, ""].join("\n"));
    wrote++;
  }
  if (localized.length) {
    writeIfChanged(
      join(OUT, `${p.name.replace(/\.lpx$/, "")}.conf`),
      [
        ...header,
        "",
        ...localized,
        "",
        // hostname 随重写资源一起给出。QX 是否把资源里的 hostname 并入 [mitm] 由 QX 决定；
        // [mitm] 那边由 _hostnames.conf 提供同名的显式清单，两条路都覆盖到。
        `hostname = ${hosts.join(", ")}`,
        "",
      ].join("\n"),
    );
    wrote++;
  }

  pluginReport.push({
    plugin: p.name, name: nm, enabled,
    rules: rules.length, rewrites: localized.length, hostnames: hosts.length,
  });
}

writeIfChanged(
  join(OUT, "_hostnames.conf"),
  [
    "# 由 tools/convert-plugins.mjs 从 vendor/loon-plugins 的 [MitM] 段汇总（仅启用的插件）。",
    `# 共 ${allHostnames.size} 个主机名。`,
    "",
    `hostname = ${[...allHostnames].sort().join(", ")}`,
    "",
  ].join("\n"),
);
wrote++;

const totRules = pluginReport.reduce((a, b) => a + b.rules, 0);
const totRew = pluginReport.reduce((a, b) => a + b.rewrites, 0);
console.log(`转换完成: ${pluginReport.length} 个插件 -> ${wrote} 个文件`);
console.log(`  分流 ${totRules} 条 / 重写 ${totRew} 条 / MITM 主机名 ${allHostnames.size} 个`);
console.log(`  跨源语义去重跳过 ${deduped} 条；比对的既有源 ${seeded.length} 个`);

const reasons = new Map();
for (const s of skipReport) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
if (reasons.size) {
  console.log(`\n跳过/无法转换共 ${skipReport.length} 条（每条都已记账，不静默丢弃）:`);
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);
}

writeIfChanged(
  join(OUT, "_conversion-report.json"),
  JSON.stringify(
    { generated_note: "由 tools/convert-plugins.mjs 生成，勿手工编辑。", plugins: pluginReport, skipped: skipReport },
    null,
    2,
  ) + "\n",
);

/** 只在内容变化时写盘；--check 下只报告，不写。生成物必须可重复。 */
function writeIfChanged(dest, body) {
  const rel = dest.replace(ROOT + "/", "").replace(/\\/g, "/");
  const prev = existsSync(dest) ? readFileSync(dest, "utf8") : null;
  if (prev === body) return;
  if (CHECK) {
    console.log(`  ! 需要更新: ${rel}（${(prev ?? "").split("\n").length} -> ${body.split("\n").length} 行）`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(dest, body, "utf8");
  console.log(`  + ${rel}`);
}

#!/usr/bin/env bun
/**
 * 从 Loon 插件（.plugin / .lpx，含合并包）中提取规则并转换为 Quantumult X 格式。
 *
 * 为什么需要它：
 *   Loon 的插件里有两类东西是「域名黑名单」覆盖不到的——
 *     1. [Rewrite]/[Script] 段是 **URL 路径级**规则（如 `^https://api\.x\.com/v1/feed/`），
 *        按域名拦截的规则库（bm7 Advertising 等）在原理上就抓不到；
 *     2. 插件针对具体 App 的接口做的 body 改写、重定向、解锁。
 *   实测：某个合并插件包的 1980 条 URL 规则里，有 1914 条（96.7%）是纯域名规则库没覆盖的。
 *
 *   注意：插件的 [Rule] 段（纯域名）价值有限——实测只有 4.7% 是现有黑名单没覆盖的，
 *   所以本工具默认**只提取 rewrite/script**，不导出域名规则（避免 12MB 级的重复）。
 *
 * 输入可以是：
 *   - 单个 Loon 插件文件，或
 *   - 合并了多个插件的 .plugin（如 wxs0625/loon-plugins 的整合版）
 *
 *   bun tools/extract-plugin.mjs <plugin-file> [--out=QuantumultX/rules/plugin-rewrites.snippet]
 *                                 [--keep-unconverted]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 取出某个 [Section] 的有效行（去注释/空行）。 */
function section(text, name) {
  // 注意：JS 正则不支持 \Z，必须用 (?!...) 或直接匹配到结尾。这里按行扫描更稳。
  const lines = text.split(/\r?\n/);
  const header = `[${name}]`;
  let capturing = false;
  const out = [];
  for (const line of lines) {
    if (/^\[[A-Za-z ]+\]\s*$/.test(line.trim())) {
      capturing = line.trim().toLowerCase() === header.toLowerCase();
      continue;
    }
    if (capturing) out.push(line.trim());
  }
  return out;
}

/**
 * Loon/Surge 的 script-path 写法 -> Quantumult X 的 `url script-*` 写法。
 * 这些是 Quantumult X **不支持**直接表达的部分，需要显式识别并转换或剔除。
 */
function convertScriptLine(line) {
  // http-request ^pattern script-path=URL, requires-body=1, ... , tag=xxx
  let phase = null;
  let pattern = null;
  let rest = null;
  const m = line.match(/^(http-request|http-response|http-request-jq|http-response-jq|http-response-body|http-request-body)\s+(\S+)\s+(.*)$/i);
  if (m) {
    [, phase, pattern, rest] = m;
  } else {
    // "^pattern script-path=URL, ..." 形式：无 http- 前缀，按 requires-body 推断
    const m2 = line.match(/^(\S+)\s+(.*script-path\s*=.*)$/i);
    if (!m2) return null;
    pattern = m2[1];
    rest = m2[2];
    phase = /requires-body\s*=\s*(1|true)/i.test(rest) ? "http-response" : "http-response";
  }
  const sp = rest.match(/script-path=(\S+?)(?:,|$)/);
  if (!sp) return null;
  const script = sp[1];
  const needsBody = /requires-body\s*=\s*(1|true)/i.test(rest);
  const isRequest = /^http-request/i.test(phase);
  let qxType;
  if (isRequest) qxType = needsBody ? "script-request-body" : "script-request-header";
  else qxType = needsBody ? "script-response-body" : "script-response-header";
  return `${pattern} url ${qxType} ${script}`;
}

/** Loon 的 rewrite 行大多已是 QX 语法，只需把动作名映射过去。 */
function convertRewriteLine(line) {
  // 已经是 QX 语法（含 " url "）
  if (/\surl\s/.test(line)) {
    return line.replace(/\s+url\s+reject-drop\b.*$/i, " url reject");
  }

  // Loon 的 "pattern action [args]" 两点式写法
  const m = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
  if (!m) return null;
  const [, pattern, action, rest] = m;
  const a = action.toLowerCase();

  // 1) 纯状态返回类：动作名基本一致，reject-drop 在 QX 里没有，退化为 reject
  if (/^(reject|reject-200|reject-img|reject-dict|reject-array|reject-drop|302|307)$/.test(a)) {
    const act = a === "reject-drop" ? "reject" : action;
    return `${pattern} url ${act}${rest ? " " + rest : ""}`;
  }

  // 2) Loon 的 json 改写 -> Quantumult X 的 jsonjq（注意动作名！）
  //
  // QX 原生动作是 `jsonjq-response-body` / `jsonjq-request-body`；
  // `response-body-json-jq` 只是 Loon/Surge 的写法，QX 不认识，用了会静默失效。
  // jq 表达式需用单引号包裹，且要剥掉外层已有的引号（与 KOP 解析器一致）。
  const stripQuotes = (v) => {
    v = (v ?? "").trim();
    if (v.length > 1 && ((v[0] === "'" && v.at(-1) === "'") || (v[0] === '"' && v.at(-1) === '"'))) {
      return v.slice(1, -1);
    }
    return v;
  };
  const quoteJQ = (v) => "'" + v.replace(/'/g, "\\'") + "'";
  const phaseOf = (a) => (a.startsWith("request") || a.startsWith("http-request") ? "jsonjq-request-body" : "jsonjq-response-body");

  if (a === "response-body-json-jq" || a === "request-body-json-jq" || a === "http-response-jq" || a === "http-request-jq") {
    const jq = stripQuotes(rest);
    if (!jq) return null;
    return `${pattern} url ${phaseOf(a)} ${quoteJQ(jq)}`;
  }

  if (a === "response-body-json-del" || a === "request-body-json-del") {
    const body = stripQuotes(rest);
    if (!body) return null;
    // 若已是 del(...)/delpaths(...) 则原样用；否则按路径列表生成 del(...)
    let jq;
    if (/^(del|delpaths)\s*\(/.test(body)) {
      jq = body;
    } else {
      // Loon 的 del 载荷可能用逗号/分号/空格分隔多个路径（KOP 解析器也处理空格分隔），
      // 统一拆开后用逗号重组成合法的 jq：del(.a, .b)。
      let parts = body.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      if (parts.length === 1 && /\s/.test(parts[0])) {
        parts = parts[0].split(/\s+/).map((x) => x.trim()).filter(Boolean);
      }
      const paths = parts.map((x) => (x.startsWith(".") ? x : "." + x.replace(/^\$\.?/, "")));
      if (!paths.length) return null;
      jq = `del(${paths.join(", ")})`;
    }
    return `${pattern} url ${phaseOf(a)} ${quoteJQ(jq)}`;
  }

  return null; // mock-response-body / map-local 等 QX 无对应，交由调用方统计
}

const args = process.argv.slice(2);

/**
 * 自动模式（`--all`）：从 tools/sources.json 的 vendor_plugins 取插件包，
 * 并与「所有已启用的重写源」（含快照里的上游文件）自动去重。
 * 这样 CI 里可以一条命令重现，不依赖手工传参或本地临时目录。
 */
async function autoBaseline() {
  const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));
  const files = [];
  for (const r of src.rewrites) {
    if (r.id === "rewrite-plugin-extracted" || !r.enabled) continue;
    if (r.local_file) {
      files.push(join(ROOT, r.local_file));
      continue;
    }
    const m = (r.url ?? "").match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
    if (m) {
      const p = join(ROOT, "snapshot", "github.com", m[1]);
      if (existsSync(p)) files.push(p);
    }
  }
  return files;
}

let input = args.find((a) => !a.startsWith("--"));
const auto = args.includes("--all");
if (auto && !input) {
  const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));
  const v = src.vendor_plugins?.[0];
  if (!v) {
    console.error("sources.json 里没有 vendor_plugins");
    process.exit(2);
  }
  // 与 fetch-snapshot 一致的落盘位置，避免每次重新下载
  const cache = join(ROOT, "_plugin_cache", "plugins.plugin");
  mkdirSync(dirname(cache), { recursive: true });
  const res = await fetch(v.url);
  if (!res.ok) {
    console.error(`下载插件失败: HTTP ${res.status} ${v.url}`);
    process.exit(1);
  }
  writeFileSync(cache, await res.text());
  input = cache;
  console.log(`已下载插件包 -> ${relative(ROOT, cache)}`);
}
if (!input) {
  console.error("usage: bun tools/extract-plugin.mjs <plugin-file> [--out=path]");
  console.error("       bun tools/extract-plugin.mjs --all          # 从 sources.json 自动取源并全量去重");
  process.exit(2);
}
const outArg = args.find((a) => a.startsWith("--out="));
const outPath = outArg ? outArg.split("=")[1] : "QuantumultX/rules/plugin-rewrites.snippet";

const text = readFileSync(input, "utf8").replace(/^\uFEFF/, "");

const raw = [...section(text, "Rewrite"), ...section(text, "Script")]
  .filter((l) => l && !l.startsWith("#"));
const converted = [];
const skipped = [];

for (const line of raw) {
  // 合并包里 script-path 可能出现在行中任意位置，统一先尝试脚本转换
  const isScript = /script-path\s*=/.test(line) || /^http-(request|response)/.test(line);
  const out = isScript ? (convertScriptLine(line) ?? convertRewriteLine(line)) : convertRewriteLine(line);
  if (out) converted.push(out);
  else skipped.push(line);
}

// 去重（合并包里常有重复条目）
const seen = new Set();
let unique = converted.filter((l) => {
  const key = l.split(/\s+url\s+/)[0];
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

/**
 * 与「已在配置里生效」的重写源去重。
 *
 * 为什么必须做：来源（wxs0625/loon-plugins）本身是 fmz 725 个插件 + kelee 33 个插件的
 * 合并包，所以提取结果与 fmz 聚合资源大量重叠。实测脚本类条目重合 69.7%，
 * 若两条都启用，同一个响应体会被两个 script-response-body 依次处理 —— 结果不可预期。
 *
 * 去重键按 Quantumult X 的真实语义：同 URL 正则 + 同动作 + 同脚本，才算同一条规则。
 */
function ruleKey(line) {
  const [pat, tail] = line.split(/\s+url\s+/);
  const [action, ...rest] = tail.split(/\s+/);
  return `${pat}|${action}|${rest.join(" ").trim()}`;
}

// 支持 --dedupe-against=a,b,c 或 --dedupe-against-file=list.txt（后者便于脚本传长列表）
const baselineFiles = [
  ...(auto ? await autoBaseline() : []),
  ...args.filter((a) => a.startsWith("--dedupe-against=")).flatMap((a) => a.split("=")[1].split(",")),
  ...args
    .filter((a) => a.startsWith("--dedupe-against-file="))
    .flatMap((a) => readFileSync(a.split("=")[1], "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)),
];

const existing = new Set();
for (const f of baselineFiles) {
  try {
    for (const l of readFileSync(f, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const t = l.trim();
      if (!t || t.startsWith("#") || !/\surl\s/.test(t)) continue;
      existing.add(ruleKey(t));
    }
  } catch (e) {
    console.warn(`  跳过 ${f}: ${e.message}`);
  }
}
const beforeDedupe = unique.length;
if (existing.size) {
  unique = unique.filter((l) => !existing.has(ruleKey(l)));
}
const removedAsDuplicate = beforeDedupe - unique.length;

const header = [
  "# 由 tools/extract-plugin.mjs 自动生成 —— 请勿手工编辑",
  `# 来源: ${input}`,
  `# 说明: 从 Loon 插件提取的 URL 级 rewrite（域名黑名单无法覆盖的部分）`,
  `# 提取: ${raw.length} 条 -> 转换 ${converted.length} 条 -> 自身去重 ${beforeDedupe} 条`,
  `# 与现有重写源重复已剔除: ${removedAsDuplicate} 条`,
  `# 最终: ${unique.length} 条`,
  `# 未能转换: ${skipped.length} 条（QX 无对应动作，如 mock-response-body / map-local）`,
  "# 重新生成: bun tools/extract-plugin.mjs <plugin-file>",
  "",
];

const dest = join(ROOT, outPath);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, header.concat(unique).join("\n") + "\n");

console.log(`提取 ${raw.length} 条 -> 转换 ${converted.length} -> 自身去重 ${beforeDedupe}`);
if (removedAsDuplicate) console.log(`与现有重写源重复、已剔除 ${removedAsDuplicate} 条（否则会重复处理响应体）`);
console.log(`最终写入 ${unique.length} 条；未转换 ${skipped.length} 条`);
if (skipped.length && args.includes("--keep-unconverted")) {
  const p = dest.replace(/\.snippet$/, ".skipped.txt");
  writeFileSync(p, skipped.join("\n") + "\n");
  console.log(`未转换清单: ${relative(ROOT, p)}`);
}
console.log(`Wrote ${relative(ROOT, dest)}`);

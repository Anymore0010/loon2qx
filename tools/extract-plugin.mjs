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
 *   bun tools/extract-plugin.mjs <plugin-file> [--out=QuantumultX/rules/AnymoreEnhance.snippet]
 *                                 [--keep-unconverted]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoBase } from "./repo-url.mjs";

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
    // jq-path="..." 是 Loon 的「外部 jq 文件」写法，不是合法 jq 表达式：
    // QX 会对它求值失败 -> 规则静默失效。丢弃（其引用的 .jq 也无法镜像）。
    if (/^jq-path\s*=|^jq_file\s*=/i.test(jq)) return null;
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
    const u = r.url ?? "";
    if (!u) continue;
    const m = u.match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
    if (m) {
      const p = join(ROOT, "snapshot", "github.com", m[1]);
      if (existsSync(p)) files.push(p);
      continue;
    }
    // 非 raw 上游（如 github.com/.../releases/latest/download/...）：在 snapshot/host/ 下找副本
    const m2 = u.match(/^https:\/\/([^/]+)\/(.+)$/);
    if (m2) {
      const p = join(ROOT, "snapshot", "host", m2[1], m2[2]);
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
    // 不 fail-fast：与 fetch-snapshot 的约定一致 —— 单个上游坏掉不能中断整批刷新。
    // 失败时保留上一次的插件包与提取结果，错误写进 status 供最后一步统一报出。
    console.error(`下载插件失败: HTTP ${res.status} ${v.url}`);
    if (existsSync(cache)) {
      console.error(`  已保留上一次的插件包，继续用旧内容重新提取`);
      input = cache;
    } else {
      console.error(`  无旧副本可复用，跳过提取（其余快照仍会提交）`);
      writeFileSync(join(OUT_DIR, "extract-status.json"),
        JSON.stringify({ ok: false, error: `HTTP ${res.status}`, url: v.url }, null, 2) + "\n");
      process.exit(0);
    }
  } else {
    writeFileSync(cache, await res.text());
  }
  input = cache;
  console.log(`插件包就绪 -> ${relative(ROOT, cache)}`);
}
if (!input) {
  console.error("usage: bun tools/extract-plugin.mjs <plugin-file> [--out=path]");
  console.error("       bun tools/extract-plugin.mjs --all          # 从 sources.json 自动取源并全量去重");
  process.exit(2);
}
const outArg = args.find((a) => a.startsWith("--out="));
const outPath = outArg ? outArg.split("=")[1] : "QuantumultX/rules/AnymoreEnhance.snippet";

const text = readFileSync(input, "utf8").replace(/^\uFEFF/, "");

const raw = [...section(text, "Rewrite"), ...section(text, "Script")]
  .filter((l) => l && !l.startsWith("#"));
const converted = [];
const skipped = [];

/** URL 正则部分必须只含 ASCII 且无空格/逗号；否则是上游破损行（如 URL 里嵌中文）。 */
const isValidPattern = (p) => /^[\x20-\x7e]+$/.test(p) && !/[\s,]/.test(p);

for (const line of raw) {
  // 合并包里 script-path 可能出现在行中任意位置，统一先尝试脚本转换
  const isScript = /script-path\s*=/.test(line) || /^http-(request|response)/.test(line);
  const out = isScript ? (convertScriptLine(line) ?? convertRewriteLine(line)) : convertRewriteLine(line);
  // 污染/破损的上游行：URL 正则含非 ASCII 或分隔符 -> 直接丢弃
  const pat = out ? out.replace(/\s+url(?:-and-header)?\s+[\s\S]*$/, "") : "";
  if (out && !isValidPattern(pat)) {
    skipped.push(line + "   [丢弃：URL 正则含非 ASCII/分隔符，上游破损行]");
    continue;
  }
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
 * 插件 [MITM] 段里的 hostname 列表 —— 必须一并提取。
 *
 * Quantumult X 的 rewrite_remote 资源需要自带 hostname，QX 才会把主机名并入 MITM。
 * 缺了它，下面的 script-* / jsonjq-* 规则**永远不会触发**，而且不报错
 * （表现为「规则在，但不生效」）。
 */
const mitmHosts = section(text, "MITM")
  .filter((l) => /^hostname\s*=/i.test(l))
  .flatMap((l) => l.replace(/^hostname\s*=/i, "").split(","))
  .map((x) => x.trim())
  .filter(Boolean)
  // 上游合并包里有破损行：被注释掉的 `hostname =` 丢了前导 #，与上一行粘连成
  // "xxx.comhostname = yyy.com"。这类条目含 "=" 或 "hostname" 字样，是非法主机名，
  // QX 解析该行会报错 —— 必须剔除（并去重）。
  .filter((x) => x && !x.includes("=") && !/hostname/i.test(x) && /^[A-Za-z0-9*?._-]+$/.test(x))
  // 注意：曾在此处按「银行/支付类证书固定、MITM 无效」过滤 hostname，**已撤销**。
  // 该假设未经验证且与事实矛盾：上游专门维护 ccbLifeAds.js（建行生活）、CloudQuickPass
  // （云闪付）等脚本，说明银行系生活 App 的去广告是能生效的。
  // 是否要缩小 MITM 范围应由使用者决定，不应在提取阶段静默裁掉。
const mitmDedup = [...new Set(mitmHosts)];

/**
 * 与「已在配置里生效」的重写源去重。
 *
 * 为什么必须做：来源（wxs0625/loon-plugins）本身是 fmz 725 个插件 + kelee 33 个插件的
 * 合并包，所以提取结果与 fmz 聚合资源大量重叠。实测脚本类条目重合 69.7%，
 * 若两条都启用，同一个响应体会被两个 script-response-body 依次处理 —— 结果不可预期。
 *
 * 去重键按 Quantumult X 的真实语义：同 URL 正则 + 同动作 + 同脚本，才算同一条规则。
 */
/**
 * 把一个 URL 正则归一化成「语义键」，用于跨源去重。
 *
 * 为什么需要：现有去重是按**正则文本全等**比对，但不同源会用不同写法命中同一个 URL。
 * 实测（正是本项目一直防的坑）：
 *   fmz 聚合  ^https:\/\/(spclient\.wg\.spotify\.com|.*-spclient\.spotify\.com(:443)?)\/user-customization-service\/v1\/customize$
 *   插件提取  ^https:\/\/(?:\w+-spclient|spclient\.wg)\.spotify\.com(?::443)?\/(?:bootstrap|user-customization-service)
 *   两者都命中 /user-customization-service 的 protobuf 响应体 -> 同一 body 被两个
 *   script-response-body 依次改写，结果不可预期。文本比对全部漏判。
 *
 * 归一化：去转义/锚定/量词/非捕获组，只留下「域名与路径词元」的有序集合。
 * 两条规则若一方的重要词元全部出现在另一方里，即视为命中同一 URL。
 */
function urlSig(pattern) {
  // 注意：只去掉分组的**括号**，绝不能连内容一起去 —— 正则的关键信息常常就在
  // 分组里（如 `(?:bootstrap|user-customization-service)`），整组删掉会把
  // 「命中哪个接口」这个最关键的信息抹掉，导致语义比对失效。
  const p = pattern
    .replace(/\\/g, "")            // 去转义反斜杠（\. -> .）
    .replace(/\(\?:/g, " ")          // 非捕获组：只去掉 "(?:"，保留候选项
    .replace(/\(/g, " ")             // 普通组左括号
    .replace(/\)/g, " ")             // 右括号
    .toLowerCase();
  return new Set(p.split(/[^a-z0-9]+/).filter((t) => t.length >= 7));
}

/** 两条规则的 URL 正则是否命中同一路径（语义重合）。 */
function sameTarget(a, b) {
  const A = a.length >= b.length ? a : b; // 以词元多的一方为准
  const B = A === a ? b : a;
  if (B.size === 0) return false;
  let hit = 0;
  for (const t of B) if (A.has(t)) hit++;
  return hit >= 2 && hit / B.size >= 0.6;
}

function ruleKey(line) {
  const [pat, tail] = line.split(/\s+url\s+/);
  const [action, ...rest] = tail.split(/\s+/);
  // 脚本类动作：只比 (正则, 动作)，忽略脚本 URL。
  // 否则同一接口被两个源用不同版本号固定（实测 WeatherKit v3.1.0 vs v3.3.2）时，
  // 会被判定为「不同规则」而双双保留 —— 同一个响应体仍被处理两次。
  if (/^script-/.test(action)) return `${pat}|${action}`;
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
// 同时收集「已存在源的 URL 正则」：即便动作不同，同一 URL 被两条规则命中
// 也可能造成重复处理（实测 2 例：myusmile 与 12306）。
const existingPatterns = new Set();
// 语义键（见 urlSig）：文本不同的正则也可能命中同一 URL。
const existingSigs = [];
for (const f of baselineFiles) {
  try {
    for (const l of readFileSync(f, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const t = l.trim();
      if (!t || t.startsWith("#") || !/\surl\s/.test(t)) continue;
      existing.add(ruleKey(t));
      const pat = t.split(/\s+url\s+/)[0];
      existingPatterns.add(pat);
      // 只对「会改写响应体」的动作做语义比对：脚本/jsonjq 重复才会互相破坏。
      if (/\surl\s+(script-|jsonjq-)/.test(t)) existingSigs.push({ pat, sig: urlSig(pat) });
    }
  } catch (e) {
    console.warn(`  跳过 ${f}: ${e.message}`);
  }
}
const beforeDedupe = unique.length;
if (existing.size) {
  unique = unique.filter((l) => !existing.has(ruleKey(l)));
  // 同一 URL 已由其它源处理 -> 剔除，避免重复处理（动作不同也算）
  const before2 = unique.length;
  unique = unique.filter((l) => !existingPatterns.has(l.split(/\s+url\s+/)[0]));
  // 语义去重：文本不同但命中同一 URL 的 body 改写，同样必须剔除。
  const before3 = unique.length;
  const semDropped = [];
  unique = unique.filter((l) => {
    const m = l.match(/\surl\s+(script-|jsonjq-)/);
    if (!m) return true;
    const pat = l.split(/\s+url\s+/)[0];
    const sig = urlSig(pat);
    if (sig.size === 0) return true;
    const clash = existingSigs.find((e) => sameTarget(sig, e.sig));
    if (clash) { semDropped.push(pat); return false; }
    return true;
  });
  const removedByPattern = before2 - unique.length;
  if (removedByPattern) console.log(`同 URL 已被其它源处理、已剔除 ${removedByPattern} 条`);
  if (semDropped.length) {
    console.log(`语义重复（正则写法不同但命中同一 URL）、已剔除 ${semDropped.length} 条：`);
    for (const x of semDropped.slice(0, 5)) console.log(`    ${x.slice(0, 95)}`);
  }
}
const removedAsDuplicate = beforeDedupe - unique.length;

const header = [
  "# 由 tools/extract-plugin.mjs 自动生成 —— 请勿手工编辑",
  `# 来源: ${relative(ROOT, input) || input}`,
  `# 说明: 从 Loon 插件提取的 URL 级 rewrite（域名黑名单无法覆盖的部分）`,
  `# 提取: ${raw.length} 条 -> 转换 ${converted.length} 条 -> 自身去重 ${beforeDedupe} 条`,
  `# 与现有重写源重复已剔除: ${removedAsDuplicate} 条`,
  "# 最终规则数与 MITM 主机数见文件末尾（header 先于 finalRules 计算，故此处不重复打印）",
  `# 未能转换: ${skipped.length} 条（QX 无对应动作，如 mock-response-body / map-local）`,
  "# 重新生成: bun tools/extract-plugin.mjs --all   # 必须带 --all，它才会与已启用重写源去重",
  "",
];

const dest = join(ROOT, outPath);
mkdirSync(dirname(dest), { recursive: true });
// hostname 放在最后，与其它 QX 重写资源（如 weibo.snippet）的写法一致。
// 缺了它，上面的 script-* / jsonjq-* 规则永远不会触发（不报错，只是不生效）。
// 脚本 URL 指向本仓库快照（与 fetch-snapshot 的改写保持一致）。
// 否则这份被配置引用的文件仍依赖上游脚本，与「全部走本仓库」的目标矛盾。
const repoBase = resolveRepoBase(ROOT).rawBase;
const snapshotLocalFor = (url) => {
  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
  if (m) return `snapshot/github.com/${m[1]}`;
  const m2 = url.match(/^https:\/\/([^/]+)\/(.+)$/);
  return m2 ? `snapshot/host/${m2[1]}/${m2[2]}` : null;
};
const rewriteScripts = (line) =>
  line.replace(/(url(?:-and-header)?\s+script-\S+\s+)(https?:\/\/\S+)/g, (full, prefix, url) => {
    const clean = url.replace(/["'],$/, "");
    const local = snapshotLocalFor(clean);
    if (!local) return full;
    // 只在该快照文件确实存在时才改写，避免指向不存在的路径
    return existsSync(join(ROOT, local)) ? prefix + `${repoBase}/${local}` : full;
  });
const outRules = unique.map(rewriteScripts);
// 剔除依赖 kelee.one 脚本的规则。三重理由：
//   1. 脚本取不到（Cloudflare 403），无法纳入快照 -> 不享受兜底；仅 49 个 warning 噪音
//   2. 与现有可信源**重复处理**：实测至少 4 组（高德 splash_screen/frogserver/promotion-web）
//      与 ddgksf AmapAds.conf 命中同一 URL，但正则文本不同 -> 文本去重漏判，
//      同一响应体会被两个 script-response-body 依次处理
//   3. 这些内容上游（fmz QX 原生 rewrite.snippet / ddgksf）已覆盖
const keleeRules = outRules.filter((l) => /kelee\.one/.test(l));
const finalRules = outRules.filter((l) => !/kelee\.one/.test(l));
if (keleeRules.length) console.log(`剔除依赖 kelee.one 脚本的规则 ${keleeRules.length} 条（取不到 + 与现有源重复）`);
// 保留完整 hostname 列表。曾试图按规则正则反推「用不到的 hostname」并精简，
// 实测**不可行**：正则里的域名是转义的（\. ）且常带非捕获组，朴素抽取只命中 16/1038；
// 而 QX 的 rewrite 要看到 HTTPS 的 URL 路径**必须 MITM**，hostname 少一个就静默失效一条规则。
// 宁多勿少 —— 多解密一个域名的代价远小于规则静默失效。
const mitmFinal = mitmDedup;
const body = mitmFinal.length ? finalRules.concat(["", `hostname = ${mitmFinal.join(", ")}`]) : finalRules;

/**
 * 自用规则区段：手工维护、重新生成时必须原样保留。
 *
 * 为什么需要：这个文件由本脚本整份重写，若不做保留，使用者往里加的自定义规则
 * 会在下次 `bun tools/extract-plugin.mjs --all` 时被静默抹掉。
 * 用法：把自用规则写在文件末尾这两个标记之间即可。
 */
const CUSTOM_BEGIN = "# >>>>> Anymore 自用规则（重新生成时保留，勿删标记）>>>>>";
const CUSTOM_END = "# <<<<< Anymore 自用规则 <<<<<";
function readCustomBlock(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === CUSTOM_BEGIN);
  const j = lines.findIndex((l) => l.trim() === CUSTOM_END);
  return i >= 0 && j > i ? lines.slice(i, j + 1) : [];
}

// 取回上次的自用规则区段（若没有则新建空区段，方便使用者直接往里加）
const custom = readCustomBlock(dest);
const customBlock = custom.length
  ? custom
  : [
      CUSTOM_BEGIN,
      "# 在此处添加你自己的规则（重写/分流），重新生成时会原样保留。",
      "# 形如: ^https:\\/\\/example\\.com\\/ad url reject",
      "# 若用到新的域名，记得同时加入下面的 hostname 行（或写自己的 hostname）。",
      CUSTOM_END,
    ];
if (custom.length) console.log(`  保留自用规则区段: ${custom.length - 2} 行`);

// hostname 放在自用区段之前，避免自用规则被挤到 hostname 之后（QX 只认最后一条 hostname）
// 规则 + 自用区段 + hostname 的顺序是固定的：hostname 必须最后。
const rulesOnly = finalRules;
const outFinal = header.concat(
  rulesOnly,
  [""],
  customBlock,
  mitmFinal.length ? ["", `hostname = ${mitmFinal.join(", ")}`] : [],
);
writeFileSync(dest, outFinal.join("\n") + "\n");
// 打印真实写出的数量（曾出现 header 与实际不符，故这里显式对齐）
console.log(`  实际写出: 规则 ${finalRules.length} 条 / hostname ${mitmFinal.length} 个`);

console.log(`提取 ${raw.length} 条 -> 转换 ${converted.length} -> 自身去重 ${beforeDedupe}`);
if (removedAsDuplicate) console.log(`与现有重写源重复、已剔除 ${removedAsDuplicate} 条（否则会重复处理响应体）`);
console.log(`最终写入 ${unique.length} 条；未转换 ${skipped.length} 条`);
if (skipped.length && args.includes("--keep-unconverted")) {
  const p = dest.replace(/\.snippet$/, ".skipped.txt");
  writeFileSync(p, skipped.join("\n") + "\n");
  console.log(`未转换清单: ${relative(ROOT, p)}`);
}
console.log(`Wrote ${relative(ROOT, dest)}`);

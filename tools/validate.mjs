#!/usr/bin/env bun
/**
 * Validates the generated Quantumult X profiles.
 *
 * Checks real failure modes found while building this conversion:
 *  - missing/duplicated `[section]` headers, or sections QX does not know
 *  - keys outside of any section (silently ignored by QX)
 *  - `#` used mid-line (QX only treats it as a comment at the start of a line,
 *    so a trailing comment turns the whole rule into garbage)
 *  - filter/rewrite/policy lines referencing a policy that does not exist
 *  - snapshot profile pointing at files that were not mirrored
 *
 *   bun tools/validate.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoBase } from "./repo-url.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ONLINE = join(ROOT, "QuantumultX", "default.conf");
const OFFLINE = join(ROOT, "snapshot", "offline.conf");

/** Sections Quantumult X understands. Anything else is a fatal import error. */
const KNOWN_SECTIONS = new Set([
  "general",
  "dns",
  "policy",
  "server_local",
  "server_remote",
  "filter_local",
  "filter_remote",
  "rewrite_local",
  "rewrite_remote",
  "task_local",
  "http_backend",
  "mitm",
]);

/** Sections that may only appear once. */
const REQUIRED_SECTIONS = [...KNOWN_SECTIONS];

/** Rule types Quantumult X accepts in filter sections. */
const QX_RULE_TYPES = new Set([
  "host",
  "host-suffix",
  "host-keyword",
  "host-wildcard",
  "ip-cidr",
  "ip6-cidr",
  "ip-asn",
  "geoip",
  "user-agent",
  "url-regex",
  "final",
]);

const errors = [];
const warnings = [];

const err = (file, line, msg) => errors.push(`${file}:${line}: ${msg}`);
const warn = (file, line, msg) => warnings.push(`${file}:${line}: ${msg}`);

function parseProfile(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const sections = new Map();
  const seenHeader = new Map();
  const loose = [];
  let current = null;

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();

    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      if (!KNOWN_SECTIONS.has(name)) err(path, n, `unknown section [${name}]`);
      if (seenHeader.has(name)) err(path, n, `duplicate section [${name}] (first at line ${seenHeader.get(name)})`);
      seenHeader.set(name, n);
      current = name;
      if (!sections.has(name)) sections.set(name, []);
      return;
    }

    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) return;

    if (current === null) {
      loose.push({ n, line });
      return;
    }
    sections.get(current).push({ n, line });
  });

  return { path, text, sections, loose };
}

/**
 * QX only treats `#`/`;`/`//` as a comment when they start a line. A `#`
 * elsewhere is part of the value and usually breaks the rule.
 */
function checkStrayComments(p) {
  for (const [name, entries] of p.sections) {
    for (const { n, line } of entries) {
      const idx = line.indexOf("#");
      if (idx > 0) err(p.path, n, `'#' inside a value in [${name}] — QX would treat it as literal text: ${line.slice(0, 80)}`);
    }
  }
}

/**
 * [filter_remote] 的顺序有意义：谁先匹配谁决定去向。
 * 两条硬约束（来自 Loon 原配置与用户 QX 配置）：
 *   1. CN REGION 必须最后（Loon 注释明确「请勿修改远程 CN REGION 规则的排序」）；
 *   2. 广告拦截应在最前（用户 QX 配置如此；实测 42 个域名与 App 分流冲突）。
 */
function checkFilterOrder(p) {
  const order = (p.sections.get("filter_remote") ?? []).map((e) => e.line);
  if (!order.length) return;
  const tagOf = (l) => (l.match(/tag=([^,]+)/) ?? [])[1] ?? "";
  const tags = order.map((l) => tagOf(l).includes("CN REGION") ? "CN" : (l.startsWith("FILTER_REGION") ? "CN" : tagOf(l)));
  const cnIdx = tags.findIndex((t) => t === "CN");
  if (cnIdx !== -1 && cnIdx !== tags.length - 1) {
    err(p.path, 0, `CN REGION 不在 [filter_remote] 最后（第 ${cnIdx + 1}/${tags.length} 条）—— Loon 原配置要求它必须最后`);
  }
  const adsIdx = tags.findIndex((t) => t.includes("广告拦截") || t === "Advertising");
  if (adsIdx > 2) {
    warn(p.path, 0, `广告拦截在第 ${adsIdx + 1} 条，建议放最前（与你的 QX 配置一致）`);
  }
}

/** policy= / force-policy= / final must name an existing policy. */
function checkPolicyReferences(p) {
  const defined = new Set();
  const seen = new Map();
  for (const { n, line } of p.sections.get("policy") ?? []) {
    const m = line.match(/^(static|available|round-robin|dest-hash|url-latency-benchmark|ssid)\s*=\s*([^,]+)/);
    if (!m) continue;
    const name = m[2].trim();
    // Duplicate policy names make QX behaviour undefined, and are easy to
    // introduce when merging two configs that each define e.g. 香港节点.
    if (seen.has(name)) err(p.path, n, `duplicate policy "${name}" (first at line ${seen.get(name)})`);
    seen.set(name, n);
    defined.add(name);
  }
  const builtin = new Set(["direct", "reject", "proxy"]);

  const resolve = (name) => defined.has(name) || builtin.has(name);

  for (const [name, entries] of p.sections) {
    if (!["filter_local", "filter_remote", "rewrite_remote", "policy"].includes(name)) continue;
    for (const { n, line } of entries) {
      const fp = line.match(/(?:^|,)\s*force-policy=([^,]+)/);
      if (fp && !resolve(fp[1].trim())) err(p.path, n, `force-policy=${fp[1].trim()} is not defined in [policy]`);

      if (name === "filter_local") {
        // host, x.com, POLICY  /  final, POLICY
        const parts = line.split(",").map((s) => s.trim());
        if (parts[0].toLowerCase() === "final") {
          if (!resolve(parts[1])) err(p.path, n, `final target "${parts[1]}" is not defined in [policy]`);
        } else if (parts.length >= 3 && !resolve(parts[2])) {
          err(p.path, n, `rule references undefined policy "${parts[2]}"`);
        }
      }
    }
  }
}

/** filter_remote lines must be `url, key=value, ...`. */
function checkRemoteLines(p) {
  for (const name of ["filter_remote", "rewrite_remote", "server_remote"]) {
    for (const { n, line } of p.sections.get(name) ?? []) {
      const url = line.split(",")[0].trim();
      const builtinOk = /^(FILTER_REGION|FILTER_LAN)$/.test(url);
      if (!builtinOk && !/^https?:\/\//.test(url)) {
        err(p.path, n, `[${name}] entry does not start with an http(s) URL: ${url}`);
      }
      for (const kv of line.split(",").slice(1)) {
        const t = kv.trim();
        if (t && !/^[a-zA-Z_-]+=/.test(t)) err(p.path, n, `[${name}] malformed parameter "${t}"`);
        // 布尔参数必须是 true/false —— 曾生成 "opt-parser=undefined" 导致 QX 解析异常
        const bm = t.match(/^(enabled|opt-parser|inserted-resource)=(.*)$/);
        if (bm && bm[2] !== "true" && bm[2] !== "false") {
          err(p.path, n, `[${name}] ${bm[1]} 必须是 true 或 false，实际是 "${bm[2]}"`);
        }
      }
    }
  }
}

/** task_local lines must be `schedule url, key=value, ...`. */
function checkTasks(p) {
  const schedules = /^(?:\*|\d|event-network|event-interaction)/;
  for (const { n, line } of p.sections.get("task_local") ?? []) {
    const head = line.split(",")[0].trim();
    if (!schedules.test(head)) err(p.path, n, `[task_local] entry does not start with a schedule: ${head.slice(0, 60)}`);
    const target = head.split(/\s+/).pop();
    if (!/^(https?:\/\/|.*\.js$)/.test(target)) err(p.path, n, `[task_local] target is not a script URL: ${target}`);
  }
}

/**
 * Self-hosted URLs (pointing back at this repo) must resolve to a real file.
 * Catches path/prefix mistakes such as emitting `/rules/x.list` while the file
 * lives at `QuantumultX/rules/x.list` — which would silently drop those rules
 * in Quantumult X.
 */
function checkSelfHostedFiles(p, repoSlug) {
  const seen = new Set();
  for (const [name, entries] of p.sections) {
    for (const { n, line } of entries) {
      for (const m of line.matchAll(/https:\/\/raw\.githubusercontent\.com\/[^,\s]+\/([^,\s]+)/g)) {
        const url = m[0];
        if (!url.includes(`/${repoSlug}/`)) continue; // not self-hosted
        // Strip the "<repoSlug>/<ref>/" prefix to get the in-repo path.
        const idx = url.indexOf(`/${repoSlug}/`);
        const afterSlug = url.slice(idx + repoSlug.length + 2);
        const slash = afterSlug.indexOf("/");
        const rel = afterSlug.slice(slash + 1);
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (!existsSync(join(ROOT, rel))) {
          err(p.path, n, `self-hosted URL points at a missing file: ${rel} (in [${name}])`);
        }
      }
    }
  }
  return seen.size;
}

/**
 * Vendored rules must be valid Quantumult X filter syntax, not HTML error pages
 * or unconverted Loon rules. A wrong file would silently produce zero rules.
 */
function checkVendoredRules() {
  const dir = join(ROOT, "QuantumultX", "rules");
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((f) => f.endsWith(".list"));
  let total = 0;
  for (const f of files) {
    const rel = `QuantumultX/rules/${f}`;
    const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/);
    let count = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      // Must be "<type>, <value>[, policy]" with a QX type.
      const type = line.split(",")[0].trim().toLowerCase();
      if (!QX_RULE_TYPES.has(type)) {
        err(rel, 0, `not a valid Quantumult X rule type: "${line.slice(0, 60)}"`);
        continue;
      }
      // Field 3 must be a policy (or `no-resolve`-like option QX actually knows).
      // Guards against options landing in the policy slot — QX has no `no-resolve`,
      // and a mis-placed option silently breaks the rule.
      if (/^(ip-cidr|ip6-cidr|geoip|ip-asn)$/.test(type)) {
        const fields = line.split(",").map((x) => x.trim());
        const pol = fields[2];
        if (!pol) {
          err(rel, 0, `CIDR/ASN rule has no policy in field 3: "${line.slice(0, 60)}"`);
        } else if (/^(no-resolve|force-cellular|multi-interface|via-interface)/i.test(pol)) {
          err(rel, 0, `option "${pol}" is in the policy slot (Quantumult X expects the policy there): "${line.slice(0, 60)}"`);
        }
      }
      count++;
    }
    if (count === 0) err(rel, 0, "vendored rule file contains zero rules");
    total += count;
  }
  return { files: files.length, rules: total };
}

/**
 * 跨重写源检测「同一响应体被重复处理」。
 *
 * 这是本项目踩过的真坑：从插件提取的规则与 fmz 聚合资源大量重叠（实测 1454 条），
 * 两条同时启用时，同一个响应体会被两个 script-response-body 依次处理，结果不可预期。
 * QX 自己不会报错，所以必须在提交前拦住。
 *
 * 检查范围：每一个已启用的重写源（上游的从 snapshot 读，本仓库自带的直接读）。
 */
function checkRewriteDuplicates() {
  const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));
  const seen = new Map(); // 规则键 -> 来源文件
  let dupes = 0;

  for (const r of src.rewrites) {
    if (!r.enabled) continue;
    let file = null;
    if (r.local_file) {
      file = join(ROOT, r.local_file);
    } else {
      const m = (r.url ?? "").match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
      if (m) {
        const cand = join(ROOT, "snapshot", "github.com", m[1]);
        if (existsSync(cand)) file = cand;
      }
    }
    if (!file || !existsSync(file)) continue; // 无本地副本（如 releases 直链）则跳过

    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || t.startsWith("#") || !/\surl\s/.test(t)) continue;
      // 只有脚本类动作会「处理响应体」，重复才是危险的
      if (!/url\s+script-/.test(t)) continue;
      const key = t;
      const from = (relative(ROOT, file) || file).replace(/\\/g, "/");
      if (seen.has(key) && seen.get(key) !== from) {
        err("tools/sources.json", 0, `同一脚本重写同时来自两个源（响应体会被处理两次）:\n      ${t.slice(0, 90)}\n      ${seen.get(key)}  <->  ${from}`);
        dupes++;
      } else if (!seen.has(key)) {
        seen.set(key, from);
      }
    }
  }
  return dupes;
}

/**
 * 本地重写资源若含脚本/jsonjq 规则，必须自带 hostname。
 *
 * 这是本项目踩过的坑：从插件提取的规则里大部分是脚本类与 jsonjq 类，
 * 而 QX 依赖 rewrite_remote 资源自带的 hostname 才会把这些主机名并入 MITM。
 * 缺了 hostname 行，规则**不报错、也不生效** —— 属于最难发现的一类失效。
 */
function checkRewriteHostnames() {
  const dir = join(ROOT, "QuantumultX", "rules");
  if (!existsSync(dir)) return 0;
  let checked = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".snippet"))) {
    const rel = `QuantumultX/rules/${f}`;
    const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/);
    const hasHostname = lines.some((l) => /^hostname\s*=/i.test(l.trim()));
    // 只统计「需要 MITM 才能工作」的规则
    const needsMitm = lines.filter((l) => /\surl\s+(script-|jsonjq-)/.test(l)).length;
    if (needsMitm > 0 && !hasHostname) {
      err(rel, 0, `含 ${needsMitm} 条 script/jsonjq 规则但缺少 hostname 行 —— 这些规则不会生效（且不报错）`);
    }
    if (needsMitm > 0) checked++;
  }
  return checked;
}

/** In the snapshot profile, every referenced snapshot file must exist. */
function checkSnapshotFiles(p) {
  const seen = new Set();
  for (const name of ["filter_remote", "rewrite_remote", "server_remote", "task_local", "general"]) {
    for (const { n, line } of p.sections.get(name) ?? []) {
      for (const m of line.matchAll(/https:\/\/raw\.githubusercontent\.com\/[^,\s]+\/snapshot\/([^,\s]+)/g)) {
        const rel = `snapshot/${m[1]}`;
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (!existsSync(join(ROOT, rel))) err(p.path, n, `snapshot file missing on disk: ${rel}`);
      }
    }
  }
  return seen.size;
}

/** Non-empty requirement: essential sections must carry real content. */
function checkNonEmpty(p) {
  for (const name of ["general", "dns", "policy", "filter_local", "filter_remote", "rewrite_remote"]) {
    const entries = p.sections.get(name) ?? [];
    if (entries.length === 0) err(p.path, 0, `[${name}] is empty`);
  }
}

// ---- run -------------------------------------------------------------------
// Resolved so self-hosted URLs can be recognised regardless of which machine or
// CI job runs the check.
const repoSlug = resolveRepoBase(ROOT).slug;

{
  const vendored = checkVendoredRules();
  if (vendored) console.log(`QuantumultX/rules  ${vendored.files} file(s), ${vendored.rules} rules`);
  const dupes = checkRewriteDuplicates();
  console.log(`重写去重检查  跨源重复脚本重写: ${dupes}`);
  const hn = checkRewriteHostnames();
  console.log(`MITM 主机名检查  含脚本规则且自带 hostname 的文件: ${hn}`);
}
const profiles = [ONLINE, OFFLINE].filter((p) => {
  if (!existsSync(p)) {
    err(p, 0, "profile does not exist");
    return false;
  }
  return true;
});

for (const path of profiles) {
  const p = parseProfile(path);
  const rel = relative(ROOT, path).replace(/\\/g, "/");

  for (const { n, line } of p.loose) {
    err(rel, n, `line outside any section (QX ignores it): ${line.slice(0, 70)}`);
  }
  checkStrayComments({ ...p, path: rel });
  checkPolicyReferences({ ...p, path: rel });
  checkRemoteLines({ ...p, path: rel });
  checkTasks({ ...p, path: rel });
  checkNonEmpty({ ...p, path: rel });
  checkFilterOrder({ ...p, path: rel });

  // 段头必须全部存在 —— Quantumult X 会因为缺少某个模块而拒绝导入
  // （真实踩过：[server_local] 缺失 -> 导入报「缺少模块 server_local」）。
  // 段内可以为空，但段头不能少。
  const missing = REQUIRED_SECTIONS.filter((s) => !p.sections.has(s));
  for (const s of missing) err(rel, 0, `缺少段头 [${s}] —— Quantumult X 会因缺少该模块而无法导入`);

  let snapCount = 0;
  if (rel.includes("offline")) snapCount = checkSnapshotFiles({ ...p, path: rel });
  const selfHosted = checkSelfHostedFiles({ ...p, path: rel }, repoSlug);

  const counts = [...p.sections].map(([k, v]) => `${k}:${v.length}`).join(" ");
  console.log(`${rel}  ${counts}${snapCount ? `  snapshot-files:${snapCount}` : ""}${selfHosted ? `  self-hosted:${selfHosted}` : ""}`);
}

// Rule-count sanity: the snapshot must not be an empty mirror.
if (existsSync(join(ROOT, "snapshot", "index.json"))) {
  const idx = JSON.parse(readFileSync(join(ROOT, "snapshot", "index.json"), "utf8"));
  console.log(`snapshot/index.json  ${idx.mirrored}/${idx.total} mirrored, ${idx.failed} failed`);
  if (idx.failed > 0) {
    for (const r of idx.resources.filter((x) => x.error)) err("snapshot/index.json", 0, `failed: ${r.url} (${r.error})`);
  }
}

for (const w of warnings) console.warn(`WARN  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`\nOK — 0 errors, ${warnings.length} warning(s)`);

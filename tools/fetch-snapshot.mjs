#!/usr/bin/env bun
/**
 * Mirrors every external resource referenced by tools/sources.json into
 * snapshot/, which the single generated profile points at.
 * local copies instead of the upstream URLs.
 *
 * Why: the profile depends on ~50 third-party resources. If an upstream repo is
 * deleted or force-pushed, the profile silently loses rules. The snapshot is a
 * frozen copy that keeps working, and it can be re-synced weekly.
 *
 *   bun tools/fetch-snapshot.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoBase } from "./repo-url.mjs";
import { ruleSig, sameTarget } from "./lib/rule-target.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = join(ROOT, "snapshot");
const src = JSON.parse(
  await Bun.file(join(ROOT, "tools", "sources.json")).text()
);

const RAW_BASE_RE = /^https:\/\/raw\.githubusercontent\.com\//;

/**
 * Maps an upstream URL to a stable local path under snapshot/.
 * GitHub raw URLs become snapshot/github.com/<owner>/<repo>/<ref>/<path>,
 * everything else becomes snapshot/host/<path>.
 */
function localPathFor(url) {
  if (RAW_BASE_RE.test(url)) {
    const rest = url.replace(RAW_BASE_RE, "");
    const [owner, repo, ref, ...path] = rest.split("/");
    return join("github.com", owner, repo, ref, path.join("/"));
  }
  const u = new URL(url);
  return join("host", u.hostname, u.pathname.replace(/^\//, ""));
}

/** Every fetchable resource in the manifest, deduplicated. */
const repoInfo = resolveRepoBase(ROOT);
const rawBase = repoInfo.rawBase;

/** 图标 URL 是否已指向本仓库（如 QuantumultX/icons/JD.png 这类手工图标）。
 *  已在本仓库 -> 不再镜像，否则 fetch-snapshot 会把自家文件镜像进 snapshot/、
 *  build/iconUrl 还会因检测到 snapshot 而回退路径，造成每周震荡/首轮 404。 */
const isRepoLocal = (u) => {
  if (!u || !/^https?:/.test(u)) return true; // 本地相对路径，已是本仓库
  return u.startsWith(rawBase) || u.includes(`/${repoInfo.slug}/`);
};

/** 递归列出目录下所有文件。 */
function walkFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function collectResources() {
  const out = new Map();
  const add = (id, url, kind) => {
    if (!out.has(url)) out.set(url, { id, url, kind, local: localPathFor(url) });
  };

  for (const f of src.filters) {
    if (f.local_file) continue; // vendored into this repo, nothing external to mirror
    if (f.url.startsWith("FILTER_")) continue; // built-in, cannot be mirrored
    add(f.id, f.url, "filter");
  }
  for (const r of src.rewrites) { if (r.local_file) continue; add(r.id, r.url, "rewrite"); }
  for (const t of src.tasks) add(t.id, t.url, "task");

  // The parser is a hard dependency for opt-parser=true resources.
  add("resource-parser", src.general.resource_parser_url, "parser");
  // Icons: cosmetic, but mirroring them keeps the profile fully self-contained.
  if (src.general.profile_img_url) add("icon-profile", src.general.profile_img_url, "icon");
  for (const r of src.policies.regions) if (r.icon) add(`icon-${r.name}`, r.icon, "icon");
  for (const g of src.policies.groups ?? []) if (g.icon) add(`icon-${g.name}`, g.icon, "icon");
  for (const t of src.tasks) if (t.icon && /^https?:/.test(t.icon)) add(`icon-${t.id}`, t.icon, "icon");
  // filters / rewrites 的条目图标也要镜像，否则 iconUrl() 会把它们改写成本仓库地址
  // 而快照里并不存在 -> 404 死链（图标空白，QX 不报错）。
  // 注意：图标 URL 若已指向本仓库（如 QuantumultX/icons/JD.png 这类手工图标），
  // 就**别**再镜像 —— 否则会在 snapshot/ 里多出一份「自己的快照副本」造成嵌套，
  // 且首轮抓取时若文件未落到 master 会 404。这里跳过，让 iconUrl() 直接用原值。
  for (const f of src.filters) if (f.icon && !isRepoLocal(f.icon)) add(`icon-${f.id}`, f.icon, "icon");
  for (const r of src.rewrites) if (r.icon && !isRepoLocal(r.icon)) add(`icon-${r.id}`, r.icon, "icon");
  // geo_location_checker's script half.
  const geo = src.general.geo_location_checker.split(",").map((s) => s.trim())[1];
  if (geo && /^https?:/.test(geo)) add("geo-location-script", geo, "script");

  // 脚本镜像是**第二轮**完成的：见 collectScriptResources()。
  // 这里只处理 sources.json 声明的资源。
  return [...out.values()];
}

const resources = collectResources();

/** Downloads one resource, following redirects, and returns {ok, ...}. */
async function fetchOne(res) {
  try {
    const res0 = await fetch(res.url, {
      redirect: "follow",
      // kelee.one（用户源配置里 33 个插件的来源）对普通 UA 返回 Cloudflare 403，
      // 只有 Loon 的 User-Agent 能过。用它才能镜像到 kelee 的规则与脚本。
      headers: { "User-Agent": "Loon/998 CFNetwork/3896.200.41 Darwin/27.2.0" },
    });
    if (!res0.ok) return { ...res, ok: false, status: res0.status };
    if (res.kind === "icon") {
      const buf = Buffer.from(await res0.arrayBuffer());
      if (buf.length === 0) return { ...res, ok: false, status: res0.status, reason: "empty body" };
      return { ...res, ok: true, status: res0.status, body: buf };
    }
    const body = await res0.text();
    if (!body.trim()) return { ...res, ok: false, status: res0.status, reason: "empty body" };
    return { ...res, ok: true, status: res0.status, body };
  } catch (e) {
    return { ...res, ok: false, error: e.message };
  }
}

// 注意：**不能**先删空 snapshot 再抓。
// 之前是无条件 rmSync(SNAP) 后重新下载，结果只要中途网络抖动或某个上游超时，
// 就会留下一个空/残缺的快照 —— 而快照正是「上游挂了还能用」的那份兜底。
// 现在的策略：先抓全部，成功后才覆盖写入；失败的文件保留旧副本。
// 这样网络问题只会让内容「保持旧版」，绝不会让兜底副本消失。
mkdirSync(SNAP, { recursive: true });

const results = [];
const CONCURRENCY = 8;
for (let i = 0; i < resources.length; i += CONCURRENCY) {
  const batch = resources.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(fetchOne))));
}


// 脚本 URL -> 镜像记录（写入阶段改写规则文件时使用）

/** 递归列出 QuantumultX/rules 下的规则文件（含 kelee 子目录）。 */
function walkRules(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkRules(p, out);
    else if (/\.(snippet|conf|list)$/.test(n)) out.push(p);
  }
  return out;
}

/** 规则文件是否含 hostname 行 —— 决定它是否需要参与 MITM 汇总。 */
function hasHostnameLine(text) {
  return text.split(/\r?\n/).some((l) => /^\s*hostname\s*=/i.test(l));
}

/**
 * 某个上游资源需要排掉的规则正则。
 *
 * 两个来源，合并返回：
 *  1) sources.json 里该条目自己的 exclude_rule_patterns（历史用法）
 *  2) QuantumultX/rules/kelee/_exclusions.json —— 转换器生成：kelee 插件胜出后，
 *     把被 kelee 顶掉的重叠规则从聚合资源里排掉（用户要求"复刻插件效果"，
 *     若不去重则同一响应体会被两套脚本各处理一次）。
 * 排除都带「必须真的排掉」的断言：上游一改写法排除就会静默失效，必须报错而不是放过。
 */
/**
 * 某个上游资源需要排掉的规则。
 *
 * 两个来源，合并返回（元素形如 `{pattern, re, sig}`）：
 *  1) sources.json 里该条目自己的 exclude_rule_patterns（历史用法）
 *  2) QuantumultX/rules/kelee/_exclusions.json —— 转换器生成：kelee 插件胜出后，
 *     把被 kelee 顶掉的重叠规则从聚合资源里排掉（用户要求"复刻插件效果"，
 *     若不去重则同一响应体会被两套脚本各处理一次）。
 * 排除都带「必须真的命中」的断言：上游一改写法排除就会静默失效，必须报错而不是放过。
 */
function findExclusions(r) {
  const raw = [];
  const declared = [...src.rewrites, ...src.filters].find(
    (x) => x.exclude_rule_patterns && x.url === r.url,
  );
  if (declared) raw.push(...declared.exclude_rule_patterns);

  const manifest = join(ROOT, "QuantumultX", "rules", "kelee", "_exclusions.json");
  if (existsSync(manifest)) {
    try {
      const doc = JSON.parse(readFileSync(manifest, "utf8"));
      for (const t of doc.targets ?? []) {
        if (t.target === r.url) raw.push(...t.patterns);
      }
    } catch {
      console.error("WARN 读 _exclusions.json 失败（kelee 排除清单未生效）");
    }
  }
  return raw.map((pattern) => {
    let re = null;
    try { re = new RegExp(pattern, "i"); } catch { /* 非法正则则只走语义判据 */ }
    return { pattern, re, sig: ruleSig(pattern) };
  });
}

const rewriteStats = { local: 0, kept: 0, missing: new Set() };
/**
 * 声明了 exclude_rule_patterns、但一行都没排掉的上游。
 * 这类失败必须计入门禁：上游一改写法，排除就会静默失效，
 * 独立条目与聚合会再次重复处理同一响应体，而 CI 全绿（本仓库一贯在防的静默失效）。
 */
const exclusionMisses = [];


// ---- 第二轮：从「刚抓到的内容」中发现脚本引用并补下载 ----------------------
// 关键：必须基于 results 里的 body，而不是磁盘上的文件。
// 因为写入阶段会把规则里的脚本 URL 改写成本仓库地址，若下一轮仍扫描磁盘，
// 就会「找不到脚本 -> 不下载 -> 改写无从进行 -> 又写回上游地址」，
// 配置每周在「本仓库 / 上游」之间来回摇摆。
const scriptRe = /url(?:-and-header)?\s+script-\S+\s+(https?:\/\/\S+)/g;
const scriptTargets = new Map(); // url -> {url, kind, local}
{
  const bodies = [];
  for (const r of results) {
    if (!r.ok) continue;
    if (!/(\.snippet|\.conf|\.list)$/.test(r.local)) continue;
    bodies.push(r.body);
  }
  // 本仓库自带的规则文件（如插件提取重写）也要参与。
  // 必须**递归**：kelee 插件产物在 QuantumultX/rules/kelee/ 子目录里，
  // 非递归扫描会漏掉它们，导致这些脚本引用一直直链上游（kelee.one 对 QX UA 403）。
  const localRulesDir = join(ROOT, "QuantumultX", "rules");
  if (existsSync(localRulesDir)) {
    for (const p0 of walkRules(localRulesDir)) {
      try { bodies.push(readFileSync(p0, "utf8")); } catch {}
    }
  }
  for (const text of bodies) {
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*[#;]/.test(line)) continue; // 注释/禁用的规则不参与
      for (const m of line.matchAll(scriptRe)) {
        const u = m[1].replace(/["'],$/, "");
        if (!/^https?:\/\//.test(u)) continue;
        if (u.startsWith(rawBase) || u.includes(repoInfo.slug)) continue; // 已是本仓库
        if (scriptTargets.has(u)) continue;
        scriptTargets.set(u, { id: `script:${u.split("/").pop()}`, url: u, kind: "js", local: localPathFor(u) });
      }
    }
  }
}
if (scriptTargets.size) {
  const extra = [...scriptTargets.values()];
  for (let i = 0; i < extra.length; i += CONCURRENCY) {
    const batch = extra.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map(fetchOne))));
  }
  console.log(`第二轮：发现并抓取被引用的脚本 ${extra.length} 个`);
}

/**
 * 把规则文本里引用的外部脚本 URL 改写成本仓库的镜像地址。
 *
 * 这一步才是「上游挂了也不影响」的关键：光镜像规则文件不够，
 * 规则里 `url script-response-body https://外部/x.js` 这段仍指向外部；
 * 必须改写成本仓库路径，脚本才真的落地。
 * 取不到的脚本（kelee.one 403）保持原样。
 */
function rewriteScriptUrls(text, byUrl) {
  let out = text;
  let local = 0;
  let kept = 0;
  const missing = new Set();
  out = out.replace(/(url(?:-and-header)?\s+script-\S+\s+)(https?:\/\/\S+)/g, (full, prefix, url) => {
    const clean = url.replace(/["'],$/, "");
    const r = byUrl.get(clean);
    if (r) {
      local++;
      return prefix + `${rawBase}/snapshot/${r.local.split(/[\\/]/).join("/")}`;
    }
    kept++;
    missing.add(clean);
    return full; // 取不到 -> 保持原地址
  });
  return { text: out, local, kept, missing };
}

// 脚本 URL -> 镜像记录（写入阶段改写规则时使用；必须含第二轮结果）
const byUrlPre = new Map(results.filter((r) => r.ok).map((r) => [r.url, r]));

let ok = 0;
let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed++;
    const dest0 = join(SNAP, r.local);
    const kept = existsSync(dest0) ? "（已保留上一次抓取的副本）" : "（无旧副本）";
    console.error(`FAIL ${r.status ?? ""} ${r.error ?? r.reason ?? ""} ${r.url} ${kept}`);
    continue;
  }
  const dest = join(SNAP, r.local);
  mkdirSync(dirname(dest), { recursive: true });

  // 规则文件里引用的外部脚本，改写成仓库内镜像地址。
  // 只镜像规则文件是不够的：规则里 `url script-response-body https://外部/x.js` 那段
  // 仍指向外部，上游一挂规则就等于废掉。取不到的（kelee.one 403）保持原样。
  let body = r.body;

  // 落盘一份**未做排除**的原始副本。
  //
  // 为什么必须留：排除是**就地改写**快照的（下面的 exclude 逻辑会把行删掉），
  // 而 tools/convert-plugins.mjs 需要读「其他源的完整规则」来判定与 kelee 的重叠。
  // 若它读的是已被排除的快照，就会找不到重叠 -> 生成空 _exclusions.json
  // -> 下轮不再排除 -> fmz 重新下载的原文回灌 -> 清单再满：形成每周振荡，
  // 而链上每个断言都会通过（清单空则无 per-pattern 断言），CI 全绿。
  // 因此原始副本单独存一份，排除只作用于对外那一份。
  const rawDest = join(SNAP, "_raw", r.local);
  try {
    mkdirSync(dirname(rawDest), { recursive: true });
    writeFileSync(rawDest, r.body);
  } catch { /* 原始副本只是给转换器用，失败不影响主流程 */ }

  // 从某个上游资源里排除若干规则行（按正则匹配 URL 正则部分）。
  // 用途：fmz 聚合与独立的 Spotify 条目命中同一批 URL，同一条 protobuf 响应体
  // 会被两套 script-response-body 依次处理。改由独立条目负责，故把聚合里的排除掉。
  // 排除是**按 sources.json 声明**做的，并且带「必须真的排掉」的断言 —— 否则
  // 上游一改写法，排除就会静默失效，重复处理又回来了。
  const excl = findExclusions(r);
  if (excl && excl.length && /(\.snippet|\.conf|\.list)$/.test(r.local)) {
    const lines = body.split(/\r?\n/);
    const removeAt = new Set();
    const perPatternHits = new Map(excl.map((e) => [e.pattern, 0]));
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      // 匹配任何「规则行」（重写的 `url ...` 或分流的 `host-keyword, x, direct`），
      // 但不匹配注释/空行/hostname 行。
      const isRule =
        t &&
        !t.startsWith("#") &&
        !/^hostname\s*=/i.test(t) &&
        (t.includes(",") || /\s+url(?:-and-header)?\s+/.test(t));
      if (!isRule) continue;
      const linePat = t.split(/\s+url(?:-and-header)?\s+/)[0];
      const lineSig = ruleSig(linePat);
      // ⚠ 判定必须按**语义**（sameTarget），不能拿 kelee 的正则去 test 上游整行：
      // 两边写法常不同（kelee `^https:\/\/x` vs fmz `^https?:\/\/x`，差一个 `s?`），
      // 锚定的正则匹配不上，排除就静默失效 —— 而"全部 pattern 都没命中"这种粗断言
      // 会被其它恰好命中的 pattern 掩盖（实测就有失灵的 pattern 没人发现）。
      // 只对「URL 正则」型规则做语义比对；分流行没有域名/路径词元，
      // sameTarget 恒为 false，靠 e.re 兜底即可。
      let matched = false;
      for (const e of excl) {
        if ((e.re && e.re.test(lines[i])) || sameTarget(lineSig, e.sig)) {
          // 命中计数按**原始行集**累加：一条上游行可能同时满足多个 kelee pattern，
          // 若只对"存活行"计数，后面的 pattern 会因该行已被移除而误报"未命中"。
          perPatternHits.set(e.pattern, perPatternHits.get(e.pattern) + 1);
          matched = true;
        }
      }
      if (matched) removeAt.add(i);
    }
    // 逐个 pattern 断言：任一 pattern 一条都没命中 = 上游改了写法、排除已失效 -> 必须报错。
    for (const [pat, hits] of perPatternHits) {
      if (hits === 0) {
        console.error(`ERROR 排除规则未命中任何行（上游可能改了写法，排除已失效）: ${pat.slice(0, 100)}  <- ${r.url}`);
        exclusionMisses.push(pat);
      }
    }
    const kept = lines.filter((_, i) => !removeAt.has(i));
    if (removeAt.size) console.log(`  排除 ${removeAt.size} 行 <- ${r.url}`);
    body = kept.join("\n");
  }

  if (/(\.snippet|\.conf|\.list)$/.test(r.local) && /url(?:-and-header)?\s+script-/.test(body)) {
    const rw = rewriteScriptUrls(body, byUrlPre);
    body = rw.text;
    rewriteStats.local += rw.local;
    rewriteStats.kept += rw.kept;
    for (const u of rw.missing) rewriteStats.missing.add(u);
  }
  writeFileSync(dest, body);
  ok++;
}

// 本仓库自带的规则文件（QuantumultX/rules/*）也要就地改写。
// 它们不在 results 里（不是下载来的），但同样含脚本引用；不改写就会一直直链上游。
{
  const localRulesDir = join(ROOT, "QuantumultX", "rules");
  if (existsSync(localRulesDir)) {
    for (const p0 of walkRules(localRulesDir)) {
      const before = readFileSync(p0, "utf8");
      if (!/url(?:-and-header)?\s+script-/.test(before)) continue;
      const rw = rewriteScriptUrls(before, byUrlPre);
      if (rw.local > 0) {
        writeFileSync(p0, rw.text);
        rewriteStats.local += rw.local;
        rewriteStats.kept += rw.kept;
        for (const u of rw.missing) rewriteStats.missing.add(u);
      }
    }
  }
}

/** Absolute raw.githubusercontent.com URL for a snapshot path. */
function rawUrlFor(local) {
  const p = local.split(/[\\/]/);
  if (p[0] !== "github.com") return null;
  const [, owner, repo, ref, ...rest] = p;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
}

// 说明：不再生成 snapshot/offline.conf。
// 之前有「在线版(default.conf, 走上游) + 离线版(offline.conf, 走快照)」两份，
// 现在已统一为单一配置（prefer_local=true，全部走本仓库快照）。
// 残留的 offline.conf 还带 update-interval=-1（永不更新），属于有害遗留，已移除。

// ---- machine-readable index -------------------------------------------------
// No timestamp here on purpose: a volatile field would make every weekly run
// commit a no-op diff. Use the git commit date as the authoritative "when".
// 只有规则/脚本主体失败才算致命；引用脚本失效（上游已删）不影响可用性
const criticalFailures =
  results.filter((r) => !r.ok && r.kind !== "js").length + exclusionMisses.length;

const index = {
  repository: repoInfo.slug,
  ref: repoInfo.ref,
  total: results.length,
  mirrored: ok,
  failed: criticalFailures,
  exclusionMisses,
  resources: results.map((r) => ({
    id: r.id,
    kind: r.kind,
    url: r.url,
    snapshot: r.ok ? `snapshot/${r.local.split(/[\\/]/).join("/")}` : null,
    upstream_raw: r.ok ? rawUrlFor(r.local) : null,
    status: r.ok ? r.status : (r.status ?? null),
    error: r.ok ? null : (r.error ?? r.reason ?? `HTTP ${r.status}`),
  })),
};
writeFileSync(join(SNAP, "index.json"), JSON.stringify(index, null, 2) + "\n");

// 清理孤儿文件：从 sources.json 移除的源，其快照副本会一直留着。
// 门禁用 criticalFailures（规则/资源主体失败）而非 failed：
// failed 含 kelee.one 等永久 403 的引用脚本，若用它当门禁则 prune 永不执行，
// 已删除源的副本会无限堆积。
if (criticalFailures === 0) {
  const expected = new Set(results.map((r) => join(SNAP, r.local)));
  // 还要保护「被规则文件引用、但本轮未被发现」的镜像脚本。
  // 原因：写入阶段把规则里的脚本 URL 改写成本仓库地址后，下一轮 discovery 会跳过它们
  // （见 collectResources 的自引用排除），于是它们不在 results/expected 里，
  // 会在「清理孤儿」这一步被误删 —— 而规则仍指向它们，等于一周后自动失效。
  // 这里直接扫描已提交的规则文件，把其中指向本仓库 snapshot 的路径还原成磁盘路径。
  const referenced = new Set();
  // 扫描范围必须同时包含本仓库自带的规则目录：
  // vendor-rules 生成的 QuantumultX/rules/* 里引用的脚本，
  // 若只扫 snapshot/ 就会被当成孤儿删掉 —— 而规则仍指向它们（静默失效）。
  const refScanRoots = [SNAP, join(ROOT, "QuantumultX", "rules")].filter(existsSync);
  for (const root of refScanRoots) for (const f of walkFiles(root)) {
    if (!/(\.snippet|\.conf|\.list)$/.test(f)) continue;
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    // 排除 #：脚本 URL 可以带 `#key=value` 参数片段（kelee 转换器用它内联插件参数），
    // 若把 # 也算进路径，引用就会解析成不存在的文件名 -> 该脚本被当孤儿删掉 -> 规则指向 404。
    for (const m of text.matchAll(new RegExp(`${rawBase}/snapshot/([^\\s"',#]+)`, "g"))) {
      referenced.add(join(SNAP, decodeURIComponent(m[1])));
    }
  }
  for (const f of referenced) expected.add(f);
  const walk = walkFiles;
  let pruned = 0;
  for (const f of walk(SNAP)) {
    // 保留本脚本自己产出的文件
    const base = f.split(/[\\/]/).pop();
    if (base === "index.json") continue; // 本脚本自己产出的文件
    // snapshot/_raw/ 是**未做排除**的原始副本，供 tools/convert-plugins.mjs 判定重叠。
    // 它不是 sources.json 里的独立条目，若不显式保护会被当孤儿删掉，
    // 于是转换器又只能读到已排除的快照 -> 排除清单自我清空 -> 每周振荡。
    if (relative(SNAP, f).split(/[\\/]/)[0] === "_raw") continue;
    if (!expected.has(f)) {
      rmSync(f, { force: true });
      pruned++;
    }
  }
  if (pruned) console.log(`清理孤儿快照文件: ${pruned} 个（已从 sources.json 移除的源）`);
}

console.log(`Snapshot: ${ok}/${results.length} mirrored, ${failed} failed`);
if (rewriteStats.local || rewriteStats.kept) {
  console.log(`脚本 URL 本仓库化: ${rewriteStats.local} 处已改写, ${rewriteStats.kept} 处保留原地址（取不到）`);
  if (rewriteStats.missing.size) {
    console.log(`  取不到的脚本（保持原地址，规则未删）: ${rewriteStats.missing.size} 个`);
  }
}

console.log(`Wrote ${relative(ROOT, join(SNAP, "index.json"))}`);
// Default: exit 0 even when some upstreams fail, because snapshot/index.json
// records the failures and the partial mirror is still worth committing.
// `--strict` exits non-zero for use in a dedicated check step.
// 只有「规则/脚本主体」失败才算失败；纯脚本镜像取不到（上游已 404）
// 不影响规则可用性，降级为提示，否则每周任务会因几个死链常年标红。
// index.json 的 failed 也只看致命失败，否则每周任务会因已死脚本常年标红
if (failed > 0) {
  const notes = failed - criticalFailures;
  console.warn(`${failed} upstream resource(s) failed（其中 ${criticalFailures} 个为规则/脚本主体，${notes} 个为已失效的引用脚本）— see snapshot/index.json`);
  if (criticalFailures === 0) {
    console.warn("仅引用的外部脚本失效，规则与其余资源均正常。");
  }
  if (process.argv.includes("--strict") && criticalFailures > 0) process.exitCode = 1;
}

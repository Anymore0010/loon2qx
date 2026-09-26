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
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoBase } from "./repo-url.mjs";

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
      headers: { "User-Agent": "proxy-profile-snapshot/1.0" },
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

const rewriteStats = { local: 0, kept: 0, missing: new Set() };


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
  // 本仓库自带的规则文件（如插件提取重写）也要参与
  const localRulesDir = join(ROOT, "QuantumultX", "rules");
  if (existsSync(localRulesDir)) {
    for (const f of readdirSync(localRulesDir)) {
      if (!/\.(snippet|conf|list)$/.test(f)) continue;
      try { bodies.push(readFileSync(join(localRulesDir, f), "utf8")); } catch {}
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
    for (const f of readdirSync(localRulesDir)) {
      if (!/\.(snippet|conf|list)$/.test(f)) continue;
      const p0 = join(localRulesDir, f);
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
const criticalFailures = results.filter((r) => !r.ok && r.kind !== "js").length;

const index = {
  repository: repoInfo.slug,
  ref: repoInfo.ref,
  total: results.length,
  mirrored: ok,
  failed: criticalFailures,
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
// 只在「全部抓取成功」时才清理，避免网络问题导致误删仍需要的副本。
if (failed === 0) {
  const expected = new Set(results.map((r) => join(SNAP, r.local)));
  // 还要保护「被规则文件引用、但本轮未被发现」的镜像脚本。
  // 原因：写入阶段把规则里的脚本 URL 改写成本仓库地址后，下一轮 discovery 会跳过它们
  // （见 collectResources 的自引用排除），于是它们不在 results/expected 里，
  // 会在「清理孤儿」这一步被误删 —— 而规则仍指向它们，等于一周后自动失效。
  // 这里直接扫描已提交的规则文件，把其中指向本仓库 snapshot 的路径还原成磁盘路径。
  const referenced = new Set();
  // 扫描范围必须同时包含本仓库自带的规则目录：
  // vendor-rules/extract-plugin 生成的 QuantumultX/rules/* 里引用的脚本，
  // 若只扫 snapshot/ 就会被当成孤儿删掉 —— 而规则仍指向它们（静默失效）。
  const refScanRoots = [SNAP, join(ROOT, "QuantumultX", "rules")].filter(existsSync);
  for (const root of refScanRoots) for (const f of walkFiles(root)) {
    if (!/(\.snippet|\.conf|\.list)$/.test(f)) continue;
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const m of text.matchAll(new RegExp(`${rawBase}/snapshot/([^\\s"',]+)`, "g"))) {
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

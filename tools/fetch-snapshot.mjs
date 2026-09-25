#!/usr/bin/env bun
/**
 * Mirrors every external resource referenced by tools/sources.json into
 * snapshot/, and generates snapshot/loon2qx-offline.conf which points at the
 * local copies instead of the upstream URLs.
 *
 * Why: the profile depends on ~50 third-party resources. If an upstream repo is
 * deleted or force-pushed, the profile silently loses rules. The snapshot is a
 * frozen copy that keeps working, and it can be re-synced weekly.
 *
 *   bun tools/fetch-snapshot.mjs
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
  for (const r of src.rewrites) add(r.id, r.url, "rewrite");
  for (const t of src.tasks) add(t.id, t.url, "task");

  // The parser is a hard dependency for opt-parser=true resources.
  add("resource-parser", src.general.resource_parser_url, "parser");
  // Icons: cosmetic, but mirroring them keeps the offline profile fully self-contained.
  if (src.general.profile_img_url) add("icon-profile", src.general.profile_img_url, "icon");
  for (const r of src.policies.regions) if (r.icon) add(`icon-${r.name}`, r.icon, "icon");
  for (const g of src.policies.groups ?? []) if (g.icon) add(`icon-${g.name}`, g.icon, "icon");
  for (const t of src.tasks) if (t.icon && /^https?:/.test(t.icon)) add(`icon-${t.id}`, t.icon, "icon");
  // geo_location_checker's script half.
  const geo = src.general.geo_location_checker.split(",").map((s) => s.trim())[1];
  if (geo && /^https?:/.test(geo)) add("geo-location-script", geo, "script");

  return [...out.values()];
}

const resources = collectResources();

/** Downloads one resource, following redirects, and returns {ok, ...}. */
async function fetchOne(res) {
  try {
    const res0 = await fetch(res.url, {
      redirect: "follow",
      headers: { "User-Agent": "loon2qx-snapshot/1.0" },
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

// Rebuild from scratch so deleted upstream resources do not linger.
if (existsSync(SNAP)) rmSync(SNAP, { recursive: true, force: true });
mkdirSync(SNAP, { recursive: true });

const results = [];
const CONCURRENCY = 8;
for (let i = 0; i < resources.length; i += CONCURRENCY) {
  const batch = resources.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(fetchOne))));
}

let ok = 0;
let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed++;
    console.error(`FAIL ${r.status ?? ""} ${r.error ?? r.reason ?? ""} ${r.url}`);
    continue;
  }
  const dest = join(SNAP, r.local);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, r.body);
  ok++;
}

/** Absolute raw.githubusercontent.com URL for a snapshot path. */
function rawUrlFor(local) {
  const p = local.split(/[\\/]/);
  if (p[0] !== "github.com") return null;
  const [, owner, repo, ref, ...rest] = p;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
}

// ---- offline profile -------------------------------------------------------
// Same profile shape as tools/build.mjs, but every resource points at the copy
// committed in this repository. The base URL is resolved from CI env vars or the
// git remote so it can never be baked in as a stale/wrong value.
const repoInfo = resolveRepoBase(ROOT);
const rawBase = repoInfo.rawBase;

const byUrl = new Map(results.filter((r) => r.ok).map((r) => [r.url, r]));

function snapUrl(url) {
  const r = byUrl.get(url);
  return r ? `${rawBase}/snapshot/${r.local.split(/[\\/]/).join("/")}` : url;
}

const comment = (t) => `# ${t}`;
const rule = "#".repeat(72);
/** Quantumult X requires literal `[section]` headers, not just comment banners. */
const section = (key, t) => [rule, `# ${t}`, rule, `[${key}]`].join("\n");

const lines = [];
lines.push(comment("Quantumult X 离线配置 —— 所有远程资源均指向本仓库 snapshot/ 快照"));
lines.push(comment("用途：上游仓库失效时仍可使用。导入后仍需自行添加订阅链接并信任证书。"));
lines.push(comment("重新生成：GitHub Actions → Snapshot（每周自动）或本地 `bun tools/fetch-snapshot.mjs`"));
lines.push("");

lines.push(section("general", "常规设置"));
lines.push(`resource_parser_url=${snapUrl(src.general.resource_parser_url)}`);
lines.push(`profile_img_url=${snapUrl(src.general.profile_img_url)}`);
lines.push(`server_check_url=${src.general.server_check_url}`);
lines.push(`server_check_timeout=${src.general.server_check_timeout}`);
lines.push(`network_check_url=${src.general.network_check_url}`);
lines.push(
  `geo_location_checker=http://ip-api.com/json/?lang=zh-CN, ${snapUrl(
    src.general.geo_location_checker.split(",")[1].trim()
  )}`
);
lines.push(`dns_exclusion_list=${src.general.dns_exclusion_list}`);
lines.push(`excluded_routes=${src.general.excluded_routes}`);
lines.push(`fallback_udp_policy=${src.general.fallback_udp_policy}`);
if (src.general.udp_drop_list) lines.push(`udp_drop_list=${src.general.udp_drop_list}`);
lines.push("");

lines.push(section("dns", "DNS"));
if (src.dns.no_ipv6) lines.push("no-ipv6");
lines.push(`doh-server=${src.dns.doh_server.join(", ")}`);
for (const s of src.dns.domain_servers ?? []) lines.push(s);
lines.push("");

lines.push(section("policy", "策略组"));
for (const r of src.policies.regions) {
  lines.push(
    `static=${r.name}, resource-tag-regex=., server-tag-regex=${r.regex}, img-url=${snapUrl(r.icon)}`
  );
}
const regionByName = new Map(src.policies.regions.map((r) => [r.name, r]));
for (const s of src.policies.selects) {
  lines.push(`static=${s.name}, ${s.region}, img-url=${snapUrl(regionByName.get(s.region).icon)}`);
}
for (const g of src.policies.groups ?? []) {
  lines.push(`static=${g.name}, ${g.region}, img-url=${snapUrl(g.icon)}`);
}
lines.push("");

lines.push(section("server_remote", "节点订阅"));
lines.push(comment("订阅链接属于个人敏感信息，需手动添加（风车 → 节点 → 添加订阅）。"));
lines.push("");

lines.push(section("filter_local", "本地分流"));
for (const r of src.local_rules.rules) lines.push(r);
lines.push("");
lines.push(`final, ${src.local_rules.final}`);
lines.push("");

lines.push(section("filter_remote", "远程分流"));
for (const f of src.filters) {
  // Vendored filters are already in this repo; point at them directly.
  const u = f.local_file ? `${rawBase}/${f.local_file}` : snapUrl(f.url);
  const parts = [u, `tag=${f.tag}`];
  if (f.policy) parts.push(`force-policy=${f.policy}`);
  parts.push("update-interval=-1", `opt-parser=${f.parser}`, `enabled=${f.enabled}`);
  lines.push(parts.join(", "));
}
lines.push("");

lines.push(section("rewrite_local", "本地重写"));
lines.push(comment("离线快照模式下，重写内容全部来自下方 rewrite_remote 引用的快照文件。"));
lines.push("");

lines.push(section("rewrite_remote", "远程重写"));
for (const r of src.rewrites) {
  lines.push(
    [snapUrl(r.url), `tag=${r.tag}`, "update-interval=-1", `opt-parser=${r.parser}`, `enabled=${r.enabled}`].join(
      ", "
    )
  );
}
lines.push("");

lines.push(section("task_local", "任务"));
for (const t of src.tasks) {
  const icon = /^https?:/.test(t.icon) ? snapUrl(t.icon) : t.icon; // SF Symbols keep their name
  lines.push(
    [`${t.schedule} ${snapUrl(t.url)}`, `tag=${t.tag}`, `img-url=${icon}`, `enabled=${t.enabled}`].join(", ")
  );
}
lines.push("");

lines.push(section("http_backend", "HTTP 后端"));
lines.push("");

lines.push(section("mitm", "MITM"));
lines.push(comment("证书需在本机生成并信任。"));
lines.push("passphrase = ");
lines.push("p12 = ");

writeFileSync(join(SNAP, "loon2qx-offline.conf"), lines.join("\n") + "\n");

// ---- machine-readable index -------------------------------------------------
// No timestamp here on purpose: a volatile field would make every weekly run
// commit a no-op diff. Use the git commit date as the authoritative "when".
const index = {
  repository: repoInfo.slug,
  ref: repoInfo.ref,
  total: results.length,
  mirrored: ok,
  failed: failed,
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

console.log(`Snapshot: ${ok}/${results.length} mirrored, ${failed} failed`);
console.log(`Wrote ${relative(ROOT, join(SNAP, "loon2qx-offline.conf"))}`);
console.log(`Wrote ${relative(ROOT, join(SNAP, "index.json"))}`);
// Default: exit 0 even when some upstreams fail, because snapshot/index.json
// records the failures and the partial mirror is still worth committing.
// `--strict` exits non-zero for use in a dedicated check step.
if (failed > 0) {
  console.warn(`${failed} upstream resource(s) failed — see snapshot/index.json`);
  if (process.argv.includes("--strict")) process.exitCode = 1;
}

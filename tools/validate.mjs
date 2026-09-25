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
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ONLINE = join(ROOT, "QuantumultX", "loon2qx.conf");
const OFFLINE = join(ROOT, "snapshot", "loon2qx-offline.conf");

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

/** policy= / force-policy= / final must name an existing policy. */
function checkPolicyReferences(p) {
  const defined = new Set();
  for (const { line } of p.sections.get("policy") ?? []) {
    const m = line.match(/^(static|available|round-robin|dest-hash|url-latency-benchmark|ssid)\s*=\s*([^,]+)/);
    if (m) defined.add(m[2].trim());
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

  const missing = REQUIRED_SECTIONS.filter((s) => !p.sections.has(s));
  for (const s of missing) warn(rel, 0, `section [${s}] absent (allowed if unused)`);

  let snapCount = 0;
  if (rel.includes("offline")) snapCount = checkSnapshotFiles({ ...p, path: rel });

  const counts = [...p.sections].map(([k, v]) => `${k}:${v.length}`).join(" ");
  console.log(`${rel}  ${counts}${snapCount ? `  snapshot-files:${snapCount}` : ""}`);
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

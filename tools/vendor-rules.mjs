#!/usr/bin/env bun
/**
 * Vendors upstream Loon/Surge rule lists into this repository as Quantumult X
 * filter files, under QuantumultX/rules/.
 *
 * Why: the profile's remaining `opt-parser=true` entries depend on Quantumult X's
 * *runtime* resource parser. That has three problems:
 *   1. No fallback. If the upstream file or the parser script breaks, the rules
 *      disappear silently on the device.
 *   2. Rules the parser cannot express are dropped, surfaced only as an iOS
 *      notification that is easy to miss. Measured on fmz's AI.list: 2 `AND`
 *      rules silently lost.
 *   3. The conversion result is invisible — nothing to review before it runs.
 *
 * Vendoring converts once, here, and commits the result: reviewable in git,
 * no runtime parser needed, and any dropped rule is recorded in
 * QuantumultX/rules/CONVERSION.md.
 *
 *   bun tools/vendor-rules.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { convertRuleList } from "./convert-rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));

const OUT_DIR = join(ROOT, "QuantumultX", "rules");
mkdirSync(OUT_DIR, { recursive: true });

/** Filters flagged `vendor: true` are fetched, converted and committed locally. */
const toVendor = src.filters.filter((f) => f.vendor);

if (toVendor.length === 0) {
  console.log("No filters marked vendor:true — nothing to do.");
  process.exit(0);
}

const report = [];
let failures = 0;

for (const f of toVendor) {
  process.stdout.write(`vendoring ${f.id} … `);
  let text;
  try {
    const res = await fetch(f.upstream_url, { headers: { "User-Agent": "loon2qx-vendor/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    failures++;
    console.log(`FAILED (${e.message})`);
    report.push({ id: f.id, url: f.upstream_url, ok: false, error: e.message });
    continue;
  }

  const { rules, dropped, notes, stats } = convertRuleList(text, { policy: f.policy });

  // Header records provenance so the file is self-explanatory when reviewed.
  const header = [
    `# 由 tools/vendor-rules.mjs 自动生成 —— 请勿手工编辑`,
    `# 来源（上游）: ${f.upstream_url}`,
    `# 转换说明: Loon/Surge 规则 → Quantumult X 分流格式`,
    `# 规则数: ${rules.length}${dropped.length ? `  已丢弃: ${dropped.length}（见 rules/CONVERSION.md）` : ""}`,
    `# 重新生成: bun tools/vendor-rules.mjs`,
    "",
  ];

  const body = header.concat(rules).join("\n") + "\n";
  const file = join(ROOT, "QuantumultX", "rules", f.vendored_as);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log(`${rules.length} rules${dropped.length ? `, ${dropped.length} dropped` : ""}${notes.length ? `, ${notes.length} adjusted` : ""} -> ${f.vendored_as}`);
  report.push({ id: f.id, url: f.upstream_url, ok: true, count: rules.length, dropped, notes, stats, file: f.vendored_as });
}

// ---- conversion report -----------------------------------------------------
const lines = [
  "# 规则自动转换报告",
  "",
  "由 `tools/vendor-rules.mjs` 生成。这些规则原本依赖 Quantumult X 的**运行时资源解析器**",
  "（`opt-parser=true`），现已在本仓库内预转换为 Quantumult X 原生格式。",
  "",
  "好处：不依赖运行时解析器、结果可在 git 中审查、被丢弃的规则有记录（而不是只在 iOS 上弹一条通知）。",
  "",
  "| 上游来源 | 转换后文件 | 规则数 | 丢弃 |",
  "|---|---|---|---|",
];
for (const r of report) {
  if (!r.ok) {
    lines.push(`| ${r.url} | — | **抓取失败**：${r.error} | — |`);
  } else {
    lines.push(`| ${r.url} | \`QuantumultX/rules/${r.file}\` | ${r.count} | ${r.dropped.length} |`);
  }
}
lines.push("", "## 选项调整（规则保留）", "");
const withNotes = report.filter((r) => r.ok && (r.notes ?? []).length);
if (withNotes.length === 0) {
  lines.push("无。");
} else {
  lines.push("这些规则**被保留**，只是移除了 Quantumult X 不支持的选项：", "");
  for (const r of withNotes) {
    lines.push(`### ${r.id}`, "");
    for (const n of r.notes) lines.push(`- \`${n.rule}\`  \n  ${n.note}`);
    lines.push("");
  }
}
lines.push("", "## 丢弃的规则", "");
const withDrops = report.filter((r) => r.ok && r.dropped.length);
if (withDrops.length === 0) {
  lines.push("无。");
} else {
  lines.push("Quantumult X 的分流不支持 `AND` / `OR` / `NOT` 组合规则（官方 sample.conf 中不存在这些类型）。", "拆开写会放宽匹配条件、拦截到不该拦的流量，因此选择丢弃：", "");
  for (const r of withDrops) {
    lines.push(`### ${r.id}`, "");
    for (const d of r.dropped) lines.push(`- \`${d.rule}\`  \n  原因：${d.reason}`);
    lines.push("");
  }
}
writeFileSync(join(OUT_DIR, "CONVERSION.md"), lines.join("\n") + "\n");
// Machine-readable status so the workflow's failure step can see vendored-rule
// failures too (it previously only read snapshot/index.json).
const status = {
  total: report.length,
  ok: report.filter((r) => r.ok).length,
  failed: failures,
  rules: report.filter((r) => r.ok).reduce((a, r) => a + r.count, 0),
  resources: report.map((r) => ({
    id: r.id,
    upstream: r.url,
    file: r.ok ? `QuantumultX/rules/${r.file}` : null,
    rules: r.ok ? r.count : null,
    dropped: r.ok ? r.dropped.length : null,
    adjusted: r.ok ? (r.notes ?? []).length : null,
    error: r.ok ? null : r.error,
  })),
};
writeFileSync(join(OUT_DIR, "status.json"), JSON.stringify(status, null, 2) + "\n");
console.log(`Wrote ${relative(ROOT, join(OUT_DIR, "CONVERSION.md"))}${failures ? ` (${failures} failure(s))` : ""}`);
// Same policy as fetch-snapshot.mjs: a single broken upstream must not abort the
// whole weekly refresh. Failures are recorded in the report; `--strict` (used by
// the workflow's final check) turns them into a non-zero exit.
if (failures) {
  console.warn(`${failures} vendored upstream(s) failed — see QuantumultX/rules/CONVERSION.md`);
  if (process.argv.includes("--strict")) process.exitCode = 1;
}

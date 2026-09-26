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
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { convertRuleList } from "./convert-rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));

const OUT_DIR = join(ROOT, "QuantumultX", "rules");
mkdirSync(OUT_DIR, { recursive: true });

/**
 * 合并组：把多个上游规则源合成一个本地文件（用同一个策略）。
 *
 * 用途：AI 相关的三条（fmz AI.list + bm7 OpenAI + bm7 Anthropic）本就是同一类分流，
 * 合成一条便于维护，也避免同一域名被多条规则以不同策略重复命中。
 */
const mergeGroups = src.rule_merges ?? [];

/** Filters flagged `vendor: true` are fetched, converted and committed locally. */
const toVendor = src.filters.filter((f) => f.vendor);

if (toVendor.length === 0 && mergeGroups.length === 0) {
  console.log("No filters marked vendor:true — nothing to do.");
  process.exit(0);
}

const report = [];
let failures = 0;

for (const f of toVendor) {
  process.stdout.write(`vendoring ${f.id} … `);
  let text;
  try {
    const res = await fetch(f.upstream_url, { headers: { "User-Agent": "proxy-profile-vendor/1.0" } });
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

// ---- 合并组 ----------------------------------------------------------------
for (const g of mergeGroups) {
  // raw_rewrite：直接给出最终 QX 规则（无需从上游转换），用于「上游是 JS 脚本、
  // 规则要自己写」的情况，例如京东比价。
  if (g.raw_rewrite?.length) {
    process.stdout.write(`合并 ${g.id} … `);
    // 注意：这里**不**改写脚本 URL —— 交给 fetch-snapshot 统一处理。
    // 原因：改写需要快照副本已存在，而副本由 fetch-snapshot 创建，
    // 若在此改写会形成死结（首次永远不改 -> 永远不进快照）。
    // fetch-snapshot 会扫描 QuantumultX/rules/* 并把脚本镜像 + 改写。
    const header = [
      "# 由 tools/vendor-rules.mjs 自动生成 —— 请勿手工编辑",
      ...(g.sources ?? []).map((u) => `# 参考来源: ${u}`),
      `# 规则数: ${g.raw_rewrite.filter((l) => !l.startsWith("hostname")).length}`,
      "# 重新生成: bun tools/vendor-rules.mjs",
      "",
    ];
    const file = join(ROOT, "QuantumultX", "rules", g.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, header.concat(g.raw_rewrite).join("\n") + "\n");
    console.log(`${g.raw_rewrite.length} 行 -> ${g.out}`);
    report.push({ id: g.id, url: (g.sources ?? []).join(" + "), ok: true,
      count: g.raw_rewrite.filter((l) => !l.startsWith("hostname")).length,
      dropped: [], notes: [], file: g.out });
    continue;
  }
  process.stdout.write(`合并 ${g.id} … `);
  const all = [];
  const seenKeys = new Set();
  let perSource = [];
  let groupFailed = false; // 本组任一源失败 -> 不覆盖已提交的产物
  for (const u of g.sources) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": "proxy-profile-vendor/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rules } = convertRuleList(await res.text(), { policy: g.policy });
      // exclude_domains：这些域名由别的条目负责，合并时必须剔除，
      // 否则会因顺序把它们抢到本策略下（实测 Apple relay 域名被抢到「人工智能」）。
      const excluded = new Set((g.exclude_domains ?? []).map((x) => x.toLowerCase()));
      let added = 0;
      for (const r of rules) {
        const dom = r.split(",")[1]?.trim().toLowerCase();
        if (dom && excluded.has(dom)) continue;
        if (seenKeys.has(r)) continue; // 跨来源去重（同一域名+同一策略）
        seenKeys.add(r);
        all.push(r);
        added++;
      }
      perSource.push(`${u.split("/").slice(-2).join("/")}: ${added}`);
    } catch (e) {
      failures++;
      groupFailed = true;
      console.log(`FAILED (${e.message})`);
      report.push({ id: g.id, url: u, ok: false, error: e.message });
    }
  }
  // 与 fetch-snapshot 的「抓全才覆盖」一致：只要有一个源失败（或结果为空），
  // 就**跳过写入**，保留上一次提交的完整版本。
  // 否则 merge-google 里 YouTube 源一挂，已提交的 Google.list 会被重写成只剩
  // Google 的 711 条（YouTube 196 条消失），而 CI 是先 commit 再变红 ——
  // 设备下周就会拉到残缺规则，直到下次成功才自愈。
  if (groupFailed || all.length === 0) {
    const keep = existsSync(join(ROOT, "QuantumultX", "rules", g.out))
      ? "已保留上一次的完整版本"
      : "无旧版本可保留（本次不写入）";
    console.log(`跳过写入 ${g.out} —— ${keep}`);
    report.push({ id: g.id, url: g.sources.join(" + "), ok: false,
      error: groupFailed ? "部分来源失败，保留旧版" : "结果为空，保留旧版", file: g.out, kept: true });
    continue;
  }
  const header = [
    "# 由 tools/vendor-rules.mjs 自动生成 —— 请勿手工编辑",
    `# 合并来源（${g.sources.length} 个）:`,
    ...g.sources.map((u) => `#   ${u}`),
    `# 统一策略: ${g.policy}`,
    `# 规则数: ${all.length}（已跨来源去重）`,
    ...perSource.map((x) => `#   各源贡献 ${x}`),
    "# 重新生成: bun tools/vendor-rules.mjs",
    "",
  ];
  const file = join(ROOT, "QuantumultX", "rules", g.out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, header.concat(all).join("\n") + "\n");
  console.log(`${all.length} 条 -> ${g.out}`);
  report.push({ id: g.id, url: g.sources.join(" + "), ok: true, count: all.length, dropped: [], notes: [], file: g.out });
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

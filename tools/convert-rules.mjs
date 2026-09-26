#!/usr/bin/env bun
/**
 * Converts Loon/Surge-style rule lists into Quantumult X filter format.
 *
 * Why pre-convert instead of relying on QX's runtime resource parser:
 *   - A Quantumult X remote resource has no fallback. If the file 404s or the
 *     parser upstream changes, the rules vanish silently on the device.
 *   - The runtime parser drops rules it cannot express (measured: 2 `AND` rules
 *     in fmz's AI.list) and only reports that as an iOS notification.
 *   - Pre-converting makes the outcome reviewable in git and deterministic.
 *
 * `AND` / `OR` / `NOT` combination rules have no Quantumult X equivalent, so
 * they are dropped with an explicit report rather than silently.
 *
 *   bun tools/convert-rules.mjs <input> [--policy=NAME]
 *   (when imported, use convertRuleList() directly)
 */

/**
 * Loon/Surge rule type -> Quantumult X rule type.
 *
 * 必须同时收录 Quantumult X **自身**的类型名（host / host-suffix / ...），
 * 因为合并组的上游里混着两类文件：
 *   - Loon/Surge 语法（domain-suffix, ...）—— fmz 的 AI.list 等
 *   - Quantumult X 原生语法（HOST-SUFFIX, ...）—— bm7 的 QuantumultX/*.list
 * 之前只收了前者，于是所有 QX 原生列表在合并时被整批丢弃
 * （实测 Google.list 711 条只活下来 8 条，703 条被当成「不支持的规则类型」）。
 * 这里把 QX 原生名做成恒等映射。查表时已统一 toLowerCase()。
 */
const TYPE_MAP = {
  // Quantumult X 原生类型（恒等映射）
  host: "host",
  "host-suffix": "host-suffix",
  "host-keyword": "host-keyword",
  "host-wildcard": "host-wildcard",
  "ip-cidr": "ip-cidr",
  "ip6-cidr": "ip6-cidr",
  "ip-asn": "ip-asn",
  geoip: "geoip",
  "user-agent": "user-agent",
  "url-regex": "url-regex",
  // Loon / Surge 类型 -> Quantumult X
  domain: "host",
  "domain-suffix": "host-suffix",
  "domain-keyword": "host-keyword",
  "domain-wildcard": "host-wildcard",
  "ip-cidr6": "ip6-cidr",
};

/** Policy value -> Quantumult X policy value. */
const POLICY_MAP = {
  reject: "reject",
  "reject-200": "reject",
  "reject-img": "reject",
  "reject-dict": "reject",
  "reject-array": "reject",
  "reject-drop": "reject",
  rejectdrop: "reject",
  direct: "direct",
  proxy: "proxy",
};

const LOGICAL = /^(and|or|not)\s*,\s*\(/i;

/**
 * @param {string} text raw rule list content
 * @param {{policy?: string}} [opts] policy to append when the source omits one
 * @returns {{rules: string[], dropped: {rule: string, reason: string}[], stats: Record<string, number>}}
 */
export function convertRuleList(text, opts = {}) {
  const rules = [];
  const dropped = [];
  const notes = [];
  const stats = {};
  const seen = new Set();

  for (const raw of text.split(/\r?\n/)) {
    // 行内 `//` 注释必须先剥掉：Loon 的 .lsr 大量使用 `DOMAIN-SUFFIX, push.apple.com //推送通知`，
    // 不剥的话注释会落进值字段（实测生成 `host-suffix, push.apple.com //推送通知, APNs` ——
    // 域名里带上中文注释，规则直接失效）。注意 `//` 出现在 URL 里时不算注释，
    // 但分流规则的值不会是 URL，所以按第一个 `//` 截断是安全的。
    const line = raw.split("//")[0].trim();

    // Comments: QX accepts # ; // at line start. Metadata uses #!.
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[.*\]$/.test(line)) continue;

    // Logical combination rules cannot be expressed in QX.
    if (LOGICAL.test(line)) {
      dropped.push({ rule: line, reason: "AND/OR/NOT 组合规则在 Quantumult X 中无对应写法" });
      continue;
    }

    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 2) {
      dropped.push({ rule: line, reason: "字段不足，无法解析" });
      continue;
    }

    const type = parts[0].toLowerCase();
    const qxType = TYPE_MAP[type];
    if (!qxType) {
      // Rule types QX filter does not support (e.g. URL-REGEX variants, RULE-SET).
      dropped.push({ rule: line, reason: `规则类型 "${parts[0]}" 在 Quantumult X 分流中不支持` });
      continue;
    }

    const value = parts[1];

    // `no-resolve` is a Loon/Surge option with NO Quantumult X equivalent:
    // the official sample.conf never mentions it, and its ip-cidr lines put the
    // policy directly in field 3. Emitting it would push the policy out of its
    // slot and silently break the rule, so it is dropped.
    const hasNoResolve = parts.some((p, i) => i >= 2 && /^no-resolve$/i.test(p));
    // The policy is the last comma field that is not an option.
    let policy = null;
    for (let i = parts.length - 1; i >= 2; i--) {
      const p = parts[i];
      if (/^no-resolve$/i.test(p)) continue;
      policy = p;
      break;
    }
    if (policy) {
      policy = POLICY_MAP[policy.toLowerCase()] ?? policy;
    } else {
      policy = opts.policy ?? null;
    }

    const out = [qxType, value];
    if (policy) out.push(policy);

    if (hasNoResolve) {
      // Rule is KEPT; only the unsupported option is removed. Tracked separately
      // so reports do not overstate how many rules were lost.
      notes.push({ rule: line, note: "已移除 no-resolve 选项（Quantumult X 无此选项），规则保留" });
    }

    const rule = out.join(", ");
    if (seen.has(rule)) continue; // de-duplicate; QX tolerates but it is noise
    seen.add(rule);
    rules.push(rule);
    stats[qxType] = (stats[qxType] ?? 0) + 1;
  }

  return { rules, dropped, notes, stats };
}

// ---- CLI -------------------------------------------------------------------
if (import.meta.main) {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith("--"));
  const policyArg = args.find((a) => a.startsWith("--policy="));
  if (!input) {
    console.error("usage: bun tools/convert-rules.mjs <input-file> [--policy=NAME]");
    process.exit(2);
  }
  const text = await Bun.file(input).text();
  const { rules, dropped, notes, stats } = convertRuleList(text, {
    policy: policyArg ? policyArg.split("=")[1] : undefined,
  });
  process.stdout.write(rules.join("\n") + "\n");
  console.error(`converted ${rules.length} rules; dropped ${dropped.length}; adjusted ${notes.length}`);
  console.error(`  types: ${JSON.stringify(stats)}`);
  for (const d of dropped) console.error(`  dropped: ${d.rule}  (${d.reason})`);
  for (const n of notes) console.error(`  adjusted: ${n.rule}  (${n.note})`);
}

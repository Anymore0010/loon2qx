#!/usr/bin/env bun
/**
 * Generates QuantumultX/loon2qx.conf from tools/sources.json.
 *
 * The profile is generated, never hand-edited: sources.json is the single
 * source of truth so the online profile and the offline snapshot cannot drift.
 *
 *   bun tools/build.mjs           # write QuantumultX/loon2qx.conf
 *   bun tools/build.mjs --check   # fail if the committed file is stale
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "QuantumultX", "default.conf");

const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));

/** Quantumult X comment marker. `#` is only valid as the first character. */
const comment = (text) => `# ${text}`;

/**
 * Quantumult X requires literal `[section]` headers; a comment banner alone is
 * not a section. Emits the banner, the human-readable title, then the header.
 */
function section(key, title) {
  const bar = "#".repeat(72);
  return [bar, `# ${title}`, bar, `[${key}]`].join("\n");
}

function buildGeneral(g) {
  const lines = [section("general", "常规设置"), ""];
  lines.push(comment("从 Loon [General] 转换而来：只保留 Quantumult X 有对应语义的项。"));
  lines.push(`resource_parser_url=${g.resource_parser_url}`);
  lines.push(`profile_img_url=${g.profile_img_url}`);
  lines.push(comment("对应 Loon proxy-test-url / test-timeout=2（毫秒）"));
  lines.push(`server_check_url=${g.server_check_url}`);
  lines.push(`server_check_timeout=${g.server_check_timeout}`);
  lines.push(comment("对应 Loon internet-test-url"));
  lines.push(`network_check_url=${g.network_check_url}`);
  lines.push(comment("对应 Loon geoip-url / ipasn-url 的用途：节点页顶部信息展示"));
  lines.push(`geo_location_checker=${g.geo_location_checker}`);
  lines.push(comment("这些域名不使用 fake-ip，避免本地/内网域名被劫持"));
  lines.push(`dns_exclusion_list=${g.dns_exclusion_list}`);
  lines.push(comment("对应 Loon bypass-tun：这些流量不交给 Quantumult X 处理"));
  lines.push(`excluded_routes=${g.excluded_routes}`);
  lines.push(comment("UDP 兜底策略：节点不支持 UDP 中转时使用"));
  lines.push(`fallback_udp_policy=${g.fallback_udp_policy}`);
  if (g.udp_drop_list) {
    lines.push(comment("丢弃这些 UDP 端口（QUIC 等），避免与 TCP 分流策略不一致"));
    lines.push(`udp_drop_list=${g.udp_drop_list}`);
  }
  return lines.join("\n");
}

function buildDns(d) {
  const lines = [section("dns", "DNS"), ""];
  lines.push(comment("对应 Loon [General] doh-server。设置了 doh-server 后 non-encrypted server 会被忽略。"));
  lines.push(comment("Loon ip-mode = dual / ipv6-vif = auto，因此这里刻意不写 no-ipv6。"));
  lines.push(comment("官方要求多个 doh-server 写在同一行、以逗号分隔（并发查询）。"));
  lines.push(`doh-server=${d.doh_server.join(", ")}`);
  return lines.join("\n");
}

function buildPolicy(p) {
  const lines = [section("policy", "策略组"), ""];
  lines.push(comment("对应 Loon [Remote Filter]：按节点名正则筛选出可手动选择的节点集合。"));
  lines.push(comment("resource-tag-regex=. 表示匹配全部节点订阅，与 server-tag-regex 一起决定候选节点。"));
  for (const r of p.regions) {
    lines.push(
      `static=${r.name}, resource-tag-regex=., server-tag-regex=${r.regex}, img-url=${r.icon}`
    );
  }
  lines.push("");
  lines.push(comment("对应 Loon [Proxy Group] select：手动指定走哪个区域集合。"));
  const regionByName = new Map(p.regions.map((r) => [r.name, r]));
  for (const s of p.selects) {
    const region = regionByName.get(s.region);
    if (!region) throw new Error(`policy "${s.name}" references unknown region "${s.region}"`);
    lines.push(`static=${s.name}, ${s.region}, img-url=${region.icon}`);
  }
  // 融合自 fmz200/wool_scripts 配置的策略组，供其分流规则使用。
  if (p.groups?.length) {
    lines.push("");
    lines.push(comment("以下策略组融合自 fmz200/wool_scripts 的日常配置，供对应分流规则使用。"));
    for (const g of p.groups) {
      const target = regionByName.get(g.region) ?? null;
      if (!target && g.region !== "direct") {
        throw new Error(`policy group "${g.name}" references unknown region "${g.region}"`);
      }
      lines.push(`static=${g.name}, ${g.region}, img-url=${g.icon}`);
    }
  }
  return lines.join("\n");
}

function buildServerRemote() {
  const lines = [section("server_remote", "节点订阅"), ""];
  lines.push(comment("订阅链接属于个人敏感信息，刻意不写入本仓库。"));
  lines.push(comment("在 Quantumult X 里手动添加：风车 → 节点 → 添加订阅，或直接粘贴到下面并去掉注释符。"));
  lines.push(comment("解析器会自动把 Clash / Surge / Loon 等格式的订阅转成 Quantumult X 节点。"));
  lines.push("");
  lines.push(comment("示例（取消注释并填入你自己的链接）："));
  lines.push(comment("#https://example.com/your-subscription, tag=MyNodes, opt-parser=true, update-interval=86400, enabled=true"));
  return lines.join("\n");
}

function buildFilterLocal(l) {
  const lines = [section("filter_local", "本地分流"), ""];
  lines.push(comment("Loon [Rule] 逐条对应：DOMAIN→host, DOMAIN-SUFFIX→host-suffix, DOMAIN-KEYWORD→host-keyword, DIRECT→direct。"));
  lines.push(comment("本地规则优先于同名远程规则。"));
  lines.push("");
  for (const rule of l.rules) lines.push(rule);
  lines.push("");
  lines.push(comment("以下为 Loon [Rule] 中被注释的模板，保留供参考："));
  lines.push(comment("ip-cidr, 192.168.0.0/16, direct"));
  lines.push(comment("ip-cidr, 10.0.0.0/8, direct"));
  lines.push(comment("ip-cidr, 172.16.0.0/12, direct"));
  lines.push(comment("ip-cidr, 127.0.0.0/8, direct"));
  lines.push("");
  lines.push(comment("未被任何规则命中的流量。对应 Loon FINAL,DIRECT。"));
  lines.push(`final, ${l.final}`);
  return lines.join("\n");
}

function buildFilterRemote(filters) {
  const lines = [section("filter_remote", "远程分流"), ""];
  lines.push(comment("opt-parser=true 表示交给 resource_parser_url 转换（读取 Loon/Surge/Clash 格式的规则文件）。"));
  lines.push(comment("FILTER_REGION / FILTER_LAN 是 Quantumult X 内置资源，等同于 Loon 的 REGION_SPLITTER / LAN_SPLITTER。"));
  lines.push(comment("顺序即优先级：CN REGION 必须保持在最后。"));
  lines.push("");
  for (const f of filters) {
    const parts = [f.url, `tag=${f.tag}`];
    // 规则自带策略的资源（如分流修正）不设 force-policy，否则会覆盖其原有策略。
    if (f.policy) parts.push(`force-policy=${f.policy}`);
    parts.push("update-interval=86400", `opt-parser=${f.parser}`, `enabled=${f.enabled}`);
    if (f.note) lines.push(comment(f.note));
    lines.push(parts.join(", "));
  }
  return lines.join("\n");
}

function buildRewriteLocal() {
  const lines = [section("rewrite_local", "本地重写"), ""];
  lines.push(comment("Loon 的插件（.lpx）无法在 Quantumult X 运行，且 [Rewrite]/[Script] 段落全部由插件注入，"));
  lines.push(comment("所以 Loon 配置本体没有可平移的本地重写。所有重写都在下面的 rewrite_remote 中以 Quantumult X 原生资源替代。"));
  return lines.join("\n");
}

function buildRewriteRemote(rewrites) {
  const lines = [section("rewrite_remote", "远程重写"), ""];
  lines.push(comment("每个条目都对应原 Loon 配置里的一个插件，映射理由见 MAPPING.md。"));
  lines.push(comment("hostname 由这些资源自带，Quantumult X 会自动合并进 MITM 主机名列表。"));
  lines.push("");
  for (const r of rewrites) {
    const parts = [
      r.url,
      `tag=${r.tag}`,
      "update-interval=86400",
      `opt-parser=${r.parser}`,
      `enabled=${r.enabled}`,
    ];
    lines.push(parts.join(", "));
  }
  return lines.join("\n");
}

function buildTasks(tasks) {
  const lines = [section("task_local", "任务"), ""];
  lines.push(comment("event-interaction 表示在 Quantumult X 中手动点击触发，对应 Loon 的节点检测等交互式工具。"));
  lines.push("");
  for (const t of tasks) {
    lines.push(
      [
        `${t.schedule} ${t.url}`,
        `tag=${t.tag}`,
        `img-url=${t.icon}`,
        `enabled=${t.enabled}`,
      ].join(", ")
    );
  }
  return lines.join("\n");
}

function buildHttpBackend() {
  return [section("http_backend", "HTTP 后端"), "", comment("本配置未使用本地 HTTP 后端。")].join("\n");
}

function buildMitm() {
  const lines = [section("mitm", "MITM"), ""];
  lines.push(comment("证书必须在本机生成，任何证书私钥都不应提交到仓库。"));
  lines.push(comment("Quantumult X：风车 → 设置 → MITM → 生成证书 → 安装描述文件 → 到「设置-通用-关于本机-证书信任设置」开启信任。"));
  lines.push(comment("这里刻意不写 hostname：rewrite_remote 提供的重写资源自带 hostname，"));
  lines.push(comment("Quantumult X 会自动汇总；写一个空的 hostname= 反而会覆盖它。"));
  lines.push(comment("如需额外主机名，请在 Quantumult X 界面的 MITM 页面添加，或在此写 hostname = a.com, *.b.com。"));
  lines.push("");
  lines.push("passphrase = ");
  lines.push("p12 = ");
  return lines.join("\n");
}

const profile = [
  comment("Quantumult X 配置 —— 由 Loon 配置转换而来"),
  comment("生成来源：tools/sources.json（请勿手工编辑本文件，改 sources.json 后运行 `bun tools/build.mjs`）"),
  comment("原始 Loon 配置：loon_config/*.lcf"),
  comment("插件替换说明：MAPPING.md"),
  "",
  buildGeneral(src.general),
  "",
  buildDns(src.dns),
  "",
  buildPolicy(src.policies),
  "",
  buildServerRemote(),
  "",
  buildFilterLocal(src.local_rules),
  "",
  buildFilterRemote(src.filters),
  "",
  buildRewriteLocal(),
  "",
  buildRewriteRemote(src.rewrites),
  "",
  buildTasks(src.tasks),
  "",
  buildHttpBackend(),
  "",
  buildMitm(),
  "",
].join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing file is a stale state */
  }
  if (current !== profile) {
    console.error(`${relative(ROOT, OUT)} is stale. Run: bun tools/build.mjs`);
    process.exit(1);
  }
  console.log(`${relative(ROOT, OUT)} is up to date.`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, profile);
  const counts = {
    filters: src.filters.length,
    rewrites: src.rewrites.length,
    tasks: src.tasks.length,
    policies: src.policies.regions.length + src.policies.selects.length,
    localRules: src.local_rules.rules.length,
  };
  console.log(`Wrote ${relative(ROOT, OUT)} (${profile.split("\n").length} lines)`);
  console.log(counts);
}

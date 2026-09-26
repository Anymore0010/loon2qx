# 三份配置的差异说明

本文件回答：**`QuantumultX/default.conf`（本仓库生成）与你原本的 Loon 配置、你本机在用的 Quantumult X 配置，到底差在哪。**

三份配置：

| 简称 | 文件 | 说明 |
|---|---|---|
| **Loon** | `legacy/loon/*.lcf` | 你给的 Loon 配置，是本次转换的起点 |
| **你的 QX** | `legacy/quantumultx/*.conf` | 你本机实际在用的配置（来源：fmz200 的默认配置 + 你自己加了订阅） |
| **本配置** | `QuantumultX/default.conf` | 本仓库生成 |

> 注意：你的 QX 配置本身**就是** fmz200 那套默认配置（文件头写着 `项目地址：…/fmz200/wool_scripts/…/QuanX.conf`），
> 只是多了你自己的订阅链接。所以「融合 fmz 配置」这件事，实际上等于**以你正在用的那套为底座**，再补上 Loon 侧独有的东西。

---

## 取值原则：冲突时以 Loon 为准

**Loon 配置是权威来源**。融合 fmz200 的 QX 配置只用于补充 Loon 没有的能力，
不覆盖 Loon 已设定的取值。已据此修正：

| 项 | 你的 QX（fmz） | Loon（权威） | 本配置 |
|---|---|---|---|
| `fallback_udp_policy` | `direct` | `udp-fallback-mode = REJECT` | **`reject`** |
| `server_check_timeout` | `3000` | `test-timeout = 2`（秒） | **`2000`**（毫秒） |

因此下文凡标注「沿用 fmz」的地方若与 Loon 冲突，**以 Loon 为准**。
`no-ipv6` 即是一例：Loon 是 `ip-mode = dual`（双栈），所以本配置**不**写 `no-ipv6`
（与你 QX 的 fmz 取向不同——这是有意的，依据就是 Loon）。

## 零、`final`：未命中流量的去向（**最容易被忽略、影响最大**）

| | 你的 QX | 本配置 |
|---|---|---|
| `[filter_local]` 的 final | `final, 兜底策略` | `final, direct` |
| `兜底策略` 是什么 | `static=兜底策略, proxy, direct, 香港节点, 台湾节点…` | —— |
| 未命中任何规则时 | **走代理**（默认 `proxy`，即走你当前选中的节点） | **直连** |

这是两份配置**行为差异最大**的一处：

- **你的 QX**：只有被规则明确命中的流量才分流，**其余全部走代理**。所以你平时上网
  默认是挂代理的，国内网站靠 `CN REGION` 规则排除。
- **本配置**：沿用了 Loon 的 `FINAL,DIRECT`——**未命中即直连**，只有被规则命中的才走代理。
  换言之「默认不挂代理」。

两种取向都合理，但**取决于你是否希望"默认走代理"**：

- 想跟现在的 QX 一致（默认走代理）：把 `tools/sources.json` 的 `local_rules.final`
  改成 `兜底策略`，并在 `policies.groups` 里加回 `兜底策略` 组（`proxy` 开头 + 各节点）；
- 保持现状（默认直连，与 Loon 一致）：无需改动。

> 这一条也影响下面「Spotify 无 force-policy」那条：在你的配置里它**跟随 final 走代理**，
> 在本配置里**跟随 final 直连**。两者不是等价行为，只是各自的 final 不同。

## 一、策略组：手动 vs 自动（最影响体验的差异）

| | 你的 QX | 本配置 |
|---|---|---|
| 地区组类型 | `url-latency-benchmark`（**自动选延迟最低**） | `static` + `server-tag-regex`（**手动选**） |
| 正则 | `港\|HK\|Hong\|🇭🇰`（宽松） | Loon 的完整正则（含 `回国/校园/游戏` 排除） |
| 组名 | 香港/台湾/美国/日本/韩国/狮城**节点** | 香港/日本/韩国/新国/美国/全球**节点**（6 个）+ 12 个服务组（Google/Telegram/X/Meta/Spotify/GitHub/Netflix/Disney/Apple/APNs/OpenAI & Anthropic/Apple AI） |

**为什么不同**：你的 Loon 配置里 8 个组全是 `select`（手动选择），本次转换忠实保留了这个语义。
你的 QX 配置用的是自动择优，两者行为不同：

- 你的 QX：选中「香港节点」后，每次请求自动走香港里**延迟最低**的那个；
- 本配置：**已删除「…手动策略」中间层** —— 它只是 `select → 地区节点组` 的转发，而地区节点组本身可在 QX 里选节点。现在规则直接指向地区节点组或服务组。

如果你的实际偏好是自动择优，把 `tools/sources.json` 里 `policies.regions` 的 `static` 改成
`url-latency-benchmark` 即可（改一行类型的活）。

**本配置多出来的组**：`全球节点`（兜底集合）、以及 12 个「服务组」
（Google/Telegram/X/Meta/Spotify/GitHub/Netflix/Disney/Apple/APNs/
OpenAI & Anthropic/Apple AI）—— 每个服务一条，便于**逐条**选节点。
原先的 8 个 `…手动策略` **已删除**：它们只是 `select → 地区节点组` 的转发层，
而地区节点组本身可在 QX 里选节点，故属冗余。

---

## 二、DNS：本配置更完整

| | 你的 QX | 本配置 |
|---|---|---|
| DoH | 仅 `dns.alidns.com` 一个 | 阿里 + 腾讯 + Google 三个并发 |
| `no-ipv6` | ✅ 有（禁用 IPv6） | ❌ 没有（Loon 是 `ip-mode=dual`，保留 IPv6） |
| 按域名指定 DNS | 22 条（路由管理页、dl.google.com 等） | ✅ 已补齐（见下） |

**三处实质差异**（前两处是**有意不同**，不是遗漏）：

### 1. `no-ipv6`：有意保留差异

| | 你的 QX | 本配置 |
|---|---|---|
| `no-ipv6` | 有（禁用 IPv6，只走 A 记录） | **无**（保留 IPv6） |

**判断依据**：Loon 侧是 `ip-mode = dual` + `ipv6-vif = auto`，也就是**明确要双栈**。
你的 QX 用了 fmz 的 `no-ipv6`，两者语义相反。我选择跟 Loon（转换的起点）一致。

**取舍**：保留 IPv6 的好处是能走 IPv6-only 的线路、部分 CDN 更快；代价是偶尔遇到
IPv6 质量差的网络会变慢。若你更认同 fmz 的取向，改 `tools/sources.json` 的 `dns` 加
`"no_ipv6": true` 重新生成即可。

### 2. 按域名指定 DNS：已补齐（原本是缺陷，不是差异）

22 条路由管理页（`router.asus.com`、`tplogin.cn`、`miwifi.com`、`melogin.cn`…）与
Google 下载域名（`dl.google.com`、`update.googleapis.com`、`*.dl.playstation.net`）的解析规则。

官方 sample.conf 原文：*"system and all other non-encrypted regular(no specific domains are
bond to it) servers will be ignored"* —— 只忽略**未绑定域名**的 `server=`，
**绑定了域名的仍然生效**。

**为什么必须补**：这些路由管理页域名只有内网 DNS 能解析。缺了这 22 条，它们的解析会走
DoH（公网），**你在外网 DNS 下就打不开路由器后台**。已从你的配置逐条补入。

### 3. 裸 `server=` 未照搬（有意）

你 QX 里的 `server=223.5.5.5` / `server=119.29.29.29` 属于「未绑定域名」，
会被 `doh-server` **静默忽略**——照搬是无效行，所以没抄。

> 你的 QX 里那两条裸 `server=223.5.5.5` / `server=119.29.29.29` 属于「未绑定域名」，
> 会被 `doh-server` 忽略，因此**没有**照搬（照搬也是无效行）。

---

## 三、分流规则（filter_remote）

你的 QX 有 16 条，本配置有 27 条。逐条对应关系：

### 共有 / 等价

| 用途 | 你的 QX | 本配置 |
|---|---|---|
| 广告拦截合集 | fmz `filter.list` | ✅ 同 |
| 分流修正 | fmz `filterFix.list` | ✅ 同 |
| AI 分流合集 | fmz `Loon/rule/AI.list`（`opt-parser=true`） | ✅ 同源 + **kelee AI.lsr**（排第一），已预转换为 `filter/AI.list` |
| TikTok | bm7 TikTok | ❌ **未迁移**（用户确认不需要） |
| Telegram | bm7 Telegram | ✅ 同 |
| Google | bm7 Google | ✅ 同 |
| Spotify | bm7 Spotify | ✅ 同 |
| Talkatone | fmz talkatone | ❌ **未迁移**（用户确认不需要） |
| GeoIP_CN | — | ❌ **已删除**（与 CN REGION 等效，用户确认不需要） |
| 苹果屏蔽系统更新 | fmz `blockAppleUpdate`（disabled） | ✅ 同（保持 disabled） |

### 本配置新增

**kelee 插件是逐条转换过来的**（不再用"找替代品"的方式），所以 Loon 插件里的能力
基本都被保留：

| 来源 | 产物 | 说明 |
|---|---|---|
| kelee `[Plugin]`（38 个启用） | `rules/rewrite/kelee/*.snippet`（30）+ `rules/filter/kelee/*.list`（30） | `tools/convert-plugins.mjs` 逐条转换 |
| kelee `BlockAdvertisers` | 合并进 `AdsBlockMAX`（重写 + 分流）作**第一个来源** | 含 direct 白名单（短信/推送验证类域名） |
| kelee `Block_HTTPDNS` | 合并进 `HTTPDNS拦截器` | 与 bm7 版合并 |
| kelee `Remove_ads_by_keli` | 合并进 `Anymore自用广告过滤` | 与手写规则合并 |
| kelee `[Remote Rule]` 的 8 个 `.lsr` | 各分组的**第一个来源** | AI / Google / GitHub / X / Telegram / Spotify / Netflix / Disney |

用户主动去掉的：`LoonGallery`（插件仓库）、`QuickSearch`（快捷搜索）、kelee 版 WeatherKit、
`TikTok` / `OneDrive`（`[Remote Rule]` 里原有）。

### 你的 QX 有、本配置移除

| 移除 | 原因 |
|---|---|
| fmz `cookies.snippet` | 你的配置里本来就是 `enabled=false`，移除无影响 |

> **Spotify 特别说明**：你的 QX 引的是 `app2smile/rules/module/spotify.conf`。
> 本配置改用 fmz 聚合资源，但已实测：fmz 聚合里那 3 条 Spotify 规则与 app2smile
> **逐条同 URL、同动作、同脚本**（`spotify-qx-header.js` / `spotify-proto.js` /
> `spotify-json.js`）。所以功能等价，不是「换了个实现」。

---

## 五、本配置独有的工程保障（你的 QX 没有）

这些不改变使用行为，但决定「会不会某天悄悄失效」：

| 机制 | 作用 |
|---|---|
| **规则预转换** | 所有 Loon 格式规则都已转成 QX 原生存入 `QuantumultX/rules/`（含 40 个 kelee 插件的转换产物与各合并组），不再依赖运行时解析器。**你 QX 里那 3 条 `opt-parser=true` 正是这个风险**：解析器转换不了的规则会在手机上被静默丢弃，实测 `AI.list` 会丢 2 条 `AND` 规则 |
| **全量快照** | 51 个上游资源已冻结在 `snapshot/`，离线配置**零外部依赖**，上游仓库被删也能用 |
| **每周自动刷新** | GitHub Actions 每周一 03:17 UTC 重转+重拉+校验，有变化才提交 |
| **配置校验** | 段头、策略引用、重复策略名、自托管 URL 是否存在、预转换规则合法性，均有断言（都做过负向测试） |
| **敏感信息不入库** | 订阅链接与证书都在本地，仓库可公开 |

---

## 六、订阅与证书

| | 你的 QX | 本配置 |
|---|---|---|
| 订阅 | `…/link/QEY2…?clash=3&extend=1`，`tag=ikuuu`，`update-interval=172800` | **留空**，需手动添加（敏感信息） |
| 证书 | 已生成并信任 | **需重新生成**（证书不能跨设备复制） |

订阅参数建议保持一致：`opt-parser=true` 是**必需的**——你的订阅是 `?clash=3` 的 Clash YAML，
必须靠解析器才能变成 QX 节点。

---

## 七、任务（task_local）

你的 QX 有 8 条，本配置有 6 条。

| | 说明 |
|---|---|
| 共有 | 流媒体解锁查询、代理链路检测、节点详情查询、策略流量查询、节点速度测试、节点信息查询 |
| 你的 QX 多出 | `Gist备份` / `Gist恢复`（**两条都是 `enabled=false`**），未纳入 |

`Node_detection_tool.lpx`（Loon 的节点检测）由这些交互式任务替代。

---

## 八、一句话总结

**底座是你现在用的那套**（fmz200 默认配置），本配置在原基础上：

1. **补**上 Loon 侧独有的分流（GitHub/Netflix/YouTube/Disney/Apple 系列等 11 条）与去广告重写（6 条）；
2. **删**掉你不要的 3 条（抖音/小红书/快手 IP）与 2 条无效条目（`cookies` disabled、裸 `server=`）；
3. **改**策略组语义为「手动选择」（与 Loon 一致，你 QX 原本是自动择优）；
4. **加**规则预转换、全量快照、每周刷新、配置校验四层保障，解决「上游失效后静默丢规则」。

需要我把策略组改回自动择优、或加上 `no-ipv6`，改 `tools/sources.json` 重新生成即可。

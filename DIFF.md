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
  默认是挂代理的，国内网站靠 `CN REGION`/`GeoIP_CN` 等规则排除。
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
| 组名 | 香港/台湾/美国/日本/韩国/狮城**节点** | 香港/台湾/美国/日本/韩国/**新国**/游戏/**全球**节点 + 8 个「…手动策略」 |

**为什么不同**：你的 Loon 配置里 8 个组全是 `select`（手动选择），本次转换忠实保留了这个语义。
你的 QX 配置用的是自动择优，两者行为不同：

- 你的 QX：选中「香港节点」后，每次请求自动走香港里**延迟最低**的那个；
- 本配置：选中「香港手动策略」后，走**你手动指定的那个**；「香港节点」是可再选的集合。

如果你的实际偏好是自动择优，把 `tools/sources.json` 里 `policies.regions` 的 `static` 改成
`url-latency-benchmark` 即可（改一行类型的活）。

**本配置多出来的组**：`游戏节点`（Loon 有，你 QX 没有）、`全球节点`（兜底集合）、
以及全部 8 个 `…手动策略`。`人工智能` 是唯一从你 QX 侧保留的组——因为你 QX 里
`AI分流合集` 规则在用 `force-policy=人工智能`。

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
| AI 分流合集 | fmz `Loon/rule/AI.list`（`opt-parser=true`） | ✅ 同源，但**已预转换**为 QX 原生（见第五节） |
| TikTok | bm7 TikTok | ✅ 同 |
| Telegram | bm7 Telegram | ✅ 同 |
| Google | bm7 Google | ✅ 同 |
| Spotify | bm7 Spotify | ✅ 同 |
| Talkatone | fmz talkatone | ✅ 同 |
| GeoIP_CN | fmz `GeoIP_CN.list` | ✅ 同源，已预转换 |
| 苹果屏蔽系统更新 | fmz `blockAppleUpdate`（disabled） | ✅ 同（保持 disabled） |

### 本配置新增

| 新增 | 为什么加 |
|---|---|
| `LAN` | Quantumult X 内置，等同 Loon 的 `LAN_SPLITTER.lsr` |
| `CN REGION` | Quantumult X 内置，等同 Loon 的 `REGION_SPLITTER.lsr`；Loon 原配置明确要求「勿改排序」，故固定在最后 |
| `Apple AI` | Loon 侧 `AppleIntelligence.list` |
| `AI OpenAI` / `AI Anthropic` | Loon 侧 `AI.lsr` 的拆分；bm7 原生 QX 规则 |
| `Apple Push Notification Service` / `Apple Account` / `App Store` | Loon 侧对应 `.lsr` |
| `GitHub` / `Netflix` / `YouTube` / `Disney` / `Twitter` / `Facebook` / `Instagram` / `OneDrive` | Loon 侧对应 `.lsr`（你的 QX 没有这些） |
| `Advertising` | Loon 侧 `BlockAdvertisers.lpx` 的分流部分 |

### 你的 QX 有、本配置**移除**

| 移除 | 原因 |
|---|---|
| `抖音IP` / `小红书IP` / `快手IP` | **你明确说用不到**，要求删掉 |
| `苹果服务@奶思`（`AppleAll.list`） | 由 `Apple` + `AppleID` + `AppStore` 三条更细的规则覆盖 |
| `Twitter@奶思` | 本配置用 bm7 的 Twitter 规则（同一分流目的） |

**分流目标（force-policy）差异**需注意：你的 QX 里 `Github@bm7` 走 `proxy`、
`Spotify@bm7` **没有**设 force-policy（即跟随 final）；本配置里它们走具体的地区组
（`全球手动策略` / `新国手动策略`），便于策略可预测。

> ⚠️ 注意 `final` 本身不同（见第零节）：你的 `final` 是 `兜底策略`（走代理），
> 本配置是 `direct`。所以「跟随 final」这两者**并不等价**——同样的 Spotify 规则，
> 在你的配置里走代理，在本配置里直连。本配置显式指定了地区组，正是为了消除这种不确定性。

---

## 四、重写规则（rewrite_remote）

| | 你的 QX | 本配置 |
|---|---|---|
| 条目数 | 7 | 11 |

### 共有

| 用途 | 你的 QX | 本配置 |
|---|---|---|
| 微博去广告 | fmz `weibo.snippet` | ✅ 同源 |
| 广告拦截合集（730 款 App） | fmz `rewrite.snippet` | ✅ 同源 |
| Spotify | app2smile `spotify.conf` | ✅ 同源，且**实测逐条脚本 URL 完全一致** |
| BoxJs | chavyleung | ✅ 同源 |
| Sub-Store | sub-store-org | ✅ 同源 |
| Script-Hub | Script-Hub-Org | ✅ 同源 |

### 本配置新增

| 新增 | 替代 Loon 的什么 |
|---|---|
| bm7 `Advertising.conf` | `BlockAdvertisers.lpx`（纯 reject，无脚本） |
| bm7 `BlockHTTPDNS.conf` | `Block_HTTPDNS.lpx` |
| ddgksf `AmapAds.conf` | `Amap_remove_ads.lpx` |
| ddgksf `Bilibili_CC.conf` | `bilibili.lpx` |
| Orz-3 `JD_TB_price.conf` | `JD_Price.lpx` |
| fmz `cleanup.snippet` | 小程序广告清理 |

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
| **规则预转换** | 3 份 Loon 格式规则（AI/GeoIP_CN/AppleIntelligence）已转成 QX 原生存入 `QuantumultX/rules/`，不再依赖运行时解析器。**你 QX 里那 3 条 `opt-parser=true` 正是这个风险**：解析器转换不了的规则会在手机上被静默丢弃，实测 `AI.list` 会丢 2 条 `AND` 规则 |
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

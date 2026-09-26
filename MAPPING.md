# 插件映射表

原 Loon 配置的每个 `[Plugin]` 条目 → 本配置里对应的 Quantumult X 资源。

## 为什么无法直接转换

原配置引用了 40 多个 `kelee.one/Tool/Loon/Lpx/*.lpx` 插件。这些文件：

1. **是 Loon 专有格式**。插件中心明确声明「所有插件均为 Loon 专用，不建议其他工具转换使用」。
2. **无法在本机取回**。`kelee.one` 对 curl 与无头浏览器均返回 Cloudflare 403，因此无法读取其内容做逐个翻译。

结论：Loon 插件这一层**不做翻译，改用功能等价的 Quantumult X 原生资源**。以下是逐条对照。

## 分流规则（Loon `[Remote Rule]`）

Loon 的 `.lsr` 与 Quantumult X 的 `.list` 是同一套 `host-suffix, x, POLICY` 语义，但上游
`kelee.one` 的 `.lsr` 同样被 Cloudflare 挡（403）。因此改用 **blackmatrix7/ios_rule_script**
的 Quantumult X 版规则库 —— 该仓库同时维护 Loon/Quantumult X/Surge 多份，是同类规则的标准来源。

| Loon 远程规则 | Quantumult X 替代 | 策略 |
|---|---|---|
| AppleIntelligence.list（ddgksf2013） | 同源，`opt-parser=true` | 全球手动策略 |
| Telegram.lsr | bm7 `Telegram/Telegram.list` | 全球手动策略 |
| ~~TikTok.lsr~~ | ❌ 未迁移（用户确认不需要） | — |
| AI.lsr | bm7 `OpenAI` + `Anthropic` | 美国手动策略 |
| ApplePushNotificationService.lsr | 从 bm7 `Apple/Apple.list` **提取** push/courier 域（上游无独立 APNs 列表） | 苹果推送（可选组） |
| AppleAccount.lsr | bm7 `AppleID/AppleID.list` | direct |
| AppStore.lsr | bm7 `AppStore/AppStore.list` | direct |
| GitHub.lsr | bm7 `GitHub/GitHub.list` | 全球手动策略 |
| Netflix.lsr | bm7 `Netflix/Netflix.list` | 新国手动策略 |
| YouTube.lsr | bm7 `YouTube/YouTube.list` | 全球手动策略 |
| Disney.lsr | bm7 `Disney/Disney.list` | 全球手动策略 |
| Twitter.lsr | bm7 `Twitter/Twitter.list` | 全球手动策略 |
| Facebook.lsr | bm7 `Facebook/Facebook.list` | 全球手动策略 |
| Instagram.lsr | bm7 `Instagram/Instagram.list` | 美国手动策略 |
| Spotify.lsr | bm7 `Spotify/Spotify.list` | 全球手动策略 |
| Google.lsr | bm7 `Google/Google.list` | 新国手动策略 |
| OneDrive.lsr | bm7 `OneDrive/OneDrive.list` | direct |
| LAN_SPLITTER.lsr | Quantumult X 内置 `FILTER_LAN` | direct |
| REGION_SPLITTER.lsr | Quantumult X 内置 `FILTER_REGION`（CN REGION） | direct |

> `FILTER_REGION` 必须保持在 `[filter_remote]` 的最后一项，与 Loon 侧「请勿修改远程 CN REGION 规则的排序」的要求一致。

## 去广告 / 脚本插件（Loon `[Plugin]`）

**重要：这些 App 由 fmz 聚合资源统一覆盖，不要再按 App 添加拆分片段。**

原配置的插件绝大多数是「某 App 去广告」，而 fmz 的
`QuantumultX/rewrite/rewrite.snippet` 是一个**聚合资源**（约 730 款 App）。实测它包含原先
按 App 拆分的 20 个片段中的 **19 个**（同 URL、同动作），因此配置里**只引用聚合资源**。

> 为什么不能两种都留：同一个响应体会被两个 `script-response-body` 依次处理，
> 结果不可预期。这是**重复脚本**问题，不是"多一份更保险"。

因此 `[rewrite_remote]` 里只剩聚合资源未覆盖的少量条目：

| 用途 | Quantumult X 资源 | 来源 | 原因 |
|---|---|---|---|
| 通用去广告 | `rewrite/QuantumultX/Advertising/Advertising.conf` | blackmatrix7 | 纯 reject，无脚本，无重复处理风险 |
| HTTPDNS 拦截器 | `rewrite/QuantumultX/BlockHTTPDNS/BlockHTTPDNS.conf` | blackmatrix7 | 同上 |
| 730 款 App 去广告 | `QuantumultX/rewrite/rewrite.snippet` | fmz200 | 聚合主体 |
| 小程序广告清理 | `QuantumultX/rewrite/cleanup.snippet` | fmz200 | 聚合未含 |
| 微博去广告 | `QuantumultX/rewrite/weibo.snippet` | fmz200 | 聚合未覆盖 |
| 高德地图去广告 | `AdBlock/AmapAds.conf` | ddgksf2013 | 聚合未覆盖（18 条规则 0 命中） |
| 哔哩哔哩去广告 | `Function/Bilibili_CC.conf` | ddgksf2013 | 聚合未覆盖 |
| 京东/淘宝比价 | `JD_TB_price.conf` | Orz-3 | 对应 JD_Price.lpx，聚合未覆盖 |
| BoxJs | `box/rewrite/boxjs.rewrite.quanx.conf` | chavyleung | 工具类 |
| Sub-Store | `config/QX.snippet` | sub-store-org | 工具类 |
| Script-Hub | `modules/script-hub.beta.qx.conf` | Script-Hub-Org | 工具类 |

由聚合资源覆盖、**不再单独列出**的 App（原配置插件的对应项）：
雪球、Spotify（含歌词）、微信外链解锁、拼多多、番茄小说、闲鱼、夸克、12306、淘宝、京东、
腾讯视频、爱奇艺、阿里云盘、QQ音乐、微信公众号、小红书、什么值得买、知乎、酷安、YouTube、菜鸟裹裹。

如需核对某一 App 是否被覆盖，直接在上游聚合文件里搜其域名即可：
<https://raw.githubusercontent.com/fmz200/wool_scripts/main/QuantumultX/rewrite/rewrite.snippet>

## 工具类插件

| Loon 插件 | Quantumult X 替代 | 说明 |
|---|---|---|
| Node_detection_tool.lpx | `task_local` 的 `event-interaction` 脚本（节点详情 / 流媒体解锁 / 链路检测） | Loon 的节点测试是插件内 UI，Quantumult X 用交互式任务实现 |
| Prevent_DNS_Leaks.lpx | 不需要 | Quantumult X 的 DNS 走自身 `[dns]` 模块，配合 `dns_exclusion_list`，不存在 Loon 那种 DNS 泄漏场景 |

## 未迁移（上游无等价资源）

原配置里这些插件在上游找不到对应的 Quantumult X 实现，**未列入**。如需请自行寻找替代：

| Loon 插件 | 状态 |
|---|---|
| XiaoHeiHe_remove_ads.lpx（小黑盒） | 未找到 |
| RiskBird_remove_ads.lpx（风鸟） | 未找到 |
| LoonGallery.lpx | Loon 专属插件商店，无对应概念 |
| QuickSearch.lpx | Loon 专属（Safari 搜索引擎切换），无对应概念 |
| iRingo.WeatherKit.lpx | 该项目无 Quantumult X 版本 |

## 已移除的分流规则

用户明确不需要，已从 `tools/sources.json` 删除（连同其策略组 `大陆抖音` / `海外抖音`）：

| 原条目 | 内容 |
|---|---|
| `Loon/rule/Douyin.list` | 抖音 IP 分流 |
| `Loon/rule/RedBook.list` | 小红书 IP 分流 |
| `Loon/rule/KuaiShou.list` | 快手 IP 分流 |

## 规则预转换（不再依赖运行时解析器）

见 README「规则已预转换为 Quantumult X 原生格式」。简言之：`opt-parser=true` 的 3 份文件
（AI 分流合集、GeoIP_CN、AppleIntelligence）已由 `tools/vendor-rules.mjs` 预转换为
`QuantumultX/rules/*.list`，理由是没有 fallback 且运行时丢弃规则不可见。

## 取值原则：与 Loon 冲突时以 Loon 为准

本配置的**权威来源是 Loon 配置**。融合 fmz200 的 QX 配置只用于**补充 Loon 没有的能力**
（如域名级 DNS、交互式任务），不覆盖 Loon 已明确设定的取值。

据此修正过的两处（原先误用了 fmz 的值）：

| 项 | Loon（权威） | 修正前 | 现在 |
|---|---|---|---|
| `fallback_udp_policy` | `udp-fallback-mode = REJECT` | `direct`（误用 fmz） | **`reject`** ✅ |
| `server_check_timeout` | `test-timeout = 2`（秒） | `3000`（误用 fmz） | **`2000`**（毫秒）✅ |

其余与 Loon 的一致性核对：

| 项 | Loon | 本配置 |
|---|---|---|
| `server_check_url` | `proxy-test-url`（gstatic/generate_204） | ✅ 一致 |
| `network_check_url` | `internet-test-url`（hicloud/generate_204） | ✅ 一致 |
| DoH | `doh-server` 三个（阿里/腾讯/Google） | ⚠️ **有意偏离**：改为二源（阿里/腾讯）+ `prefer-doh3`。Google DoH 内地常不可达，保留会拖慢并发查询。 |
| IPv6 | `ip-mode = dual`（双栈） | ✅ 保留（不写 `no-ipv6`） |
| 域名级 DNS | 无此概念 | ⚠️ **有意偏离**：已按用户要求清空（含路由器管理页那批） |
| `final` | `FINAL,DIRECT` | ✅ `final, direct` |
| 策略组类型 | 8 组均为 `select`（手动） | ✅ 8 个「…手动策略」static 组 |

### 两个易混项的判定

| 项 | Loon 有吗 | 判定 |
|---|---|---|
| `dns_exclusion_list`（含 fmz 加的 `*.pingan.com.cn`、`*.cmbchina.com`） | **无**此概念 | **纯新增，保留**。它只是「这些域名不用 fake-ip」，不覆盖 Loon 任何设置 |
| `excluded_routes` 里的 `239.255.255.250/32` | Loon `bypass-tun` 无此项 | **已移除**。它已被 Loon 的 `224.0.0.0/4` 完整覆盖（多播段），属冗余 |
| `excluded_routes` 其余 13 段 | Loon `bypass-tun` | ✅ 逐段一致 |

**判据**：与 Loon **冲突**（同一项取了不同值）→ 以 Loon 为准；
Loon **没有**该项（纯补充）→ 保留。上表两类正好各一例。

**仍与 Loon 不同、且属于能力补充的**：域名级 DNS 22 条（Loon 无对应概念）、
交互式任务（替代 Loon 插件的节点检测）、`rewrite_remote` 的去广告重写（替代 Loon 插件）。

## 已知行为差异

1. **逻辑组合规则**：Loon 支持 `AND,((DOMAIN-SUFFIX,a),(OR,(...)))` 这类组合分流。Quantumult X 的
   远程规则不支持等价写法，用大而全的黑名单库替代时，极少数依赖组合条件的拦截会失效。
2. **去广告效果不会逐一相同**：上游各家规则库的拦截面与实现都不同，请按 App 实测。
3. **MITM 主机名**：Quantumult X 会自动合并 `rewrite_remote` 资源自带的 `hostname`，
   因此配置文件里**刻意不写** `hostname =`（写空会覆盖自动汇总的结果）。

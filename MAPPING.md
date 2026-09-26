# 插件映射表

原 Loon 配置的每个 `[Plugin]` 条目 → 本配置里对应的 Quantumult X 资源。

## 插件是**逐条转换**的，不是"找替代品"

原配置引用了 40 个 `kelee.one/Tool/Loon/Lpx/*.lpx` 插件。它们确实是 Loon 专有格式，
**不能直接被 Quantumult X 引用** —— 但可以**转换**：

1. **能取回**。早期结论「kelee.one 对 curl 与无头浏览器均返回 403、无法读取」是**错的**：
   Cloudflare 只放行 Loon 的 User-Agent。带上 `Loon/998 CFNetwork/...` 后 40 个插件全部可取。
   `tools/fetch-plugins.mjs` 就是这么抓的（原样副本存 `vendor/loon-plugins/`）。
2. **转换**。`tools/convert-plugins.mjs` 把 `[Rule]`/`[Rewrite]`/`[Script]`/`[MitM]`
   转成 Quantumult X 的 `[filter_remote]`/`[rewrite_remote]` 资源
   （`rules/filter/kelee/*.list`、`rules/rewrite/kelee/*.snippet`）。

**脚本必须镜像进本仓库**：kelee.one 只对 Loon 的 UA 放行，而 Quantumult X 抓脚本用的是
它自己的 UA → 403 → 脚本静默不执行。所以脚本全部抓进 `snapshot/host/kelee.one/`
并改写成本仓库地址。

无法转换的构造（QX 确实没有对应语法）逐条记账在 `_conversion-report.json`，
例如 `AND(...PROTOCOL QUIC)`、`mock-response-body`、Loon 的脚本化写法
`request if ${url} ~= ...`。以下是逐条对照。

## 分流规则（Loon `[Remote Rule]`）

Loon 的 `.lsr` 与 Quantumult X 的 `.list` 是同一套 `host-suffix, x, POLICY` 语义。
**kelee 的 `.lsr` 可以直接用**（同样只需 Loon 的 UA），所以按源 Loon 配置的 `[Remote Rule]`
把 kelee 源排为各分组的**第一个来源**，blackmatrix7 只作补充。
合并与去重由 `tools/vendor-rules.mjs` 完成（见 README「关于去重」）。

| Loon 远程规则 | 本仓库产物 | 策略组 | 来源顺序（先到者胜） |
|---|---|---|---|
| AI.lsr | `filter/AI.list` | AI | **kelee AI.lsr** + fmz AI.list + bm7 OpenAI + bm7 Anthropic |
| Telegram.lsr | `filter/Telegram.list` | Telegram | **kelee** + bm7 |
| ApplePushNotificationService.lsr | `filter/ApplePush.list` | APNs | **kelee**（唯一来源） |
| GitHub.lsr | `filter/GitHub.list` | GitHub | **kelee** + bm7 |
| Netflix.lsr | `filter/Netflix.list` | Netflix | **kelee** + bm7 |
| Disney.lsr | `filter/Disney.list` | Disney | **kelee** + bm7 |
| Twitter.lsr | `filter/X.list` | X | **kelee** + bm7 |
| Spotify.lsr | `filter/Spotify.list` | Spotify | **kelee** + bm7 |
| Google.lsr | `filter/Google.list` | Google | **kelee** + bm7 |
| Facebook.lsr / Instagram.lsr | `filter/Meta.list` | Meta | bm7 两份合并（kelee 无对应 .lsr） |
| AppleIntelligence.list | `filter/AppleIntelligence.list` | Apple AI | ddgksf2013（同源） |
| AppleAccount.lsr / AppStore.lsr | 由 `filter/Apple.list` 覆盖 | Apple | — |
| YouTube.lsr | 由 `filter/Google.list` 覆盖 | Google | — |
| ~~TikTok.lsr~~ / ~~OneDrive.lsr~~ | ❌ 用户确认不需要 | — | — |
| LAN_SPLITTER.lsr | QX 内置 `FILTER_LAN` | direct | — |
| REGION_SPLITTER.lsr | QX 内置 `FILTER_REGION` | direct | — |

> `FILTER_REGION` 必须保持在 `[filter_remote]` 的最后一项，与 Loon 侧「请勿修改远程 CN REGION 规则的排序」的要求一致。

## 去广告 / 脚本插件（Loon `[Plugin]`）—— 逐插件转换

40 个插件里 **38 个启用**（`BoxJs`、`Sub-Store` 在源 Loon 里就是 disabled），由
`tools/convert-plugins.mjs` 逐条转换。产物：

| 类型 | 位置 | 数量 |
|---|---|---|
| 分流 | `rules/filter/kelee/*.list` | 30 |
| 重写 | `rules/rewrite/kelee/*.snippet` | 30 |

用户主动去掉的 3 个（转换器里有 `SKIP_PLUGINS` 清单，不会被重新生成）：
`LoonGallery`（插件仓库）、`QuickSearch`（快捷搜索）、`iRingo.WeatherKit`（保留社区版）。

### 合并组

同类条目合并成一份，每个来源前有分块注释：

| 合并条目 | 位置 | 来源顺序（先到者胜） |
|---|---|---|
| `AdsBlockMAX`（重写） | `rules/rewrite/AdsBlockMAX.snippet` | kelee `BlockAdvertisers` → fmz `rewrite.snippet` → bm7 `Advertising.conf` |
| `AdsBlockMAX(分流)` | `rules/filter/AdsBlockMAX.list` | kelee `BlockAdvertisers` → fmz `filter.list` → bm7 `Advertising.list` → AWAvenue |
| `HTTPDNS拦截器` | `rules/rewrite/HTTPDNSBlock.snippet` | kelee `Block_HTTPDNS` + bm7 `BlockHTTPDNS` |
| `Anymore自用广告过滤` | `rules/rewrite/AnymoreADEnhance.snippet` | sources.json 内联手写规则 + kelee `Remove_ads_by_keli` |

### 未能转换的构造（逐条记账在 `_conversion-report.json`）

- `AND(...PROTOCOL QUIC)` —— QX 无 PROTOCOL 条件（已由 `udp_drop_list=443` 覆盖）
- `DEST-PORT` 分流 —— QX 分流无此类型
- `mock-response-body` / `response-header-add` —— QX 无该动作名
- Loon 的脚本化写法 `request/response if ${url} ~= ...` —— QX 无等价语法
- 插件参数 `argument=` / `[Argument]` —— QX 无插件参数机制，脚本走自身默认分支


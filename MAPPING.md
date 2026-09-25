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
| TikTok.lsr | bm7 `TikTok/TikTok.list` | direct |
| AI.lsr | bm7 `OpenAI` + `Anthropic` | 美国手动策略 |
| ApplePushNotificationService.lsr | bm7 `Apple/Apple.list` | direct |
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

| Loon 插件 | Quantumult X 替代 | 来源 |
|---|---|---|
| Block_HTTPDNS.lpx（HTTPDNS 拦截器，所有去广告插件的依赖） | `rewrite/QuantumultX/BlockHTTPDNS/BlockHTTPDNS.conf` | blackmatrix7 |
| BlockAdvertisers.lpx（广告平台拦截器）+ Remove_ads_by_keli.lpx | bm7 `rewrite/QuantumultX/Advertising/Advertising.conf`（重写）+ `rule/QuantumultX/Advertising/Advertising.list`（分流，`reject`） | blackmatrix7 |
| Weibo_remove_ads.lpx | `QuantumultX/rewrite/weibo.snippet` | fmz200 |
| Snowball_remove_ads.lpx（雪球） | `QuantumultX/rewrite/split/partX/XueQiu.snippet` | fmz200 |
| JD_Price.lpx（京东比价） | `JD_TB_price.conf` | Orz-3 |
| Spotify_remove_ads.lpx | `module/spotify.conf` | app2smile |
| Spotify_lyrics_translation.lpx | 同上（`spotify.conf` 内含歌词增强） | app2smile |
| Weixin_external_links_unlock.lpx | `Function/UnblockURLinWeChat.conf` | ddgksf2013 |
| PinDuoDuo_remove_ads.lpx | `split/partP/Pinduoduo.snippet` | fmz200 |
| DragonRead_remove_ads.lpx（番茄小说） | `split/partF/FanQieNovel.snippet` | fmz200 |
| FleaMarket_remove_ads.lpx（闲鱼） | `split/partX/XianYu.snippet` | fmz200 |
| QuarkBrowser_remove_ads.lpx | `split/partK/Quark.snippet` | fmz200 |
| 12306_remove_ads.lpx | `split/part1/12306.snippet` | fmz200 |
| Taobao_remove_ads.lpx | `split/partT/Taobao.snippet` | fmz200 |
| JD_remove_ads.lpx | `split/partJ/JD.com.snippet` | fmz200 |
| Tencent_Video_remove_ads.lpx | `split/partT/TencentVideo.snippet` | fmz200 |
| iQiYi_Video_remove_ads.lpx | `split/partA/iQIYI.snippet` | fmz200 |
| AliYunDrive_remove_ads.lpx | `split/partA/AlibabaCloudDrive.snippet` | fmz200 |
| Amap_remove_ads.lpx | `AdBlock/AmapAds.conf` | ddgksf2013 |
| QQMusic_remove_ads.lpx | `split/partQ/QQMusic.snippet` | fmz200 |
| Weixin_Official_Accounts_remove_ads.lpx | `split/partW/WeChatOfficialAccount.snippet` | fmz200 |
| RedPaper_remove_ads.lpx（小红书） | `split/partX/Xiaohongshu.snippet` | fmz200 |
| smzdm_remove_ads.lpx | `split/partS/SMZDM.snippet` | fmz200 |
| Zhihu_remove_ads.lpx | `split/partZ/Zhihu.snippet` | fmz200 |
| CoolApk_remove_ads.lpx | `split/partK/Coolapk.snippet` | fmz200 |
| bilibili.lpx（kokoryh/Sparkle）+ Bilibili_remove_ads.lpx | `Function/Bilibili_CC.conf` | ddgksf2013 |
| YouTube_remove_ads.lpx | `split/partY/YouTube.snippet` | fmz200 |
| Cainiao_remove_ads.lpx | `split/partC/CaiNiaoGuoGuo.snippet` | fmz200 |
| BoxJs.lpx（原配置 disabled） | `box/rewrite/boxjs.rewrite.quanx.conf` | chavyleung |
| Sub-Store.lpx（原配置 disabled） | `config/QX.snippet` | sub-store-org |
| Script-Hub.lpx | `modules/script-hub.beta.qx.conf` | Script-Hub-Org |

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

## 已知行为差异

1. **逻辑组合规则**：Loon 支持 `AND,((DOMAIN-SUFFIX,a),(OR,(...)))` 这类组合分流。Quantumult X 的
   远程规则不支持等价写法，用大而全的黑名单库替代时，极少数依赖组合条件的拦截会失效。
2. **去广告效果不会逐一相同**：上游各家规则库的拦截面与实现都不同，请按 App 实测。
3. **MITM 主机名**：Quantumult X 会自动合并 `rewrite_remote` 资源自带的 `hostname`，
   因此配置文件里**刻意不写** `hostname =`（写空会覆盖自动汇总的结果）。

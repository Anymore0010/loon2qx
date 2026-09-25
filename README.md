# proxy-profile

自用的代理配置仓库：**以 Quantumult X 为主**，从 Loon 配置转换并融合现有 QX 配置而来。

生成的配置：**`QuantumultX/default.conf`**（在线版）与 `snapshot/offline.conf`（离线版）。

| 文件 | 作用 |
|---|---|
| `QuantumultX/default.conf` | **日常导入用的配置** |
| `QuantumultX/rules/` | 预转换的 QX 原生规则（不依赖运行时解析器） |
| `snapshot/` | 全部上游资源的冻结副本 + 离线配置 |
| `legacy/loon/` | 原始 Loon 配置（转换来源，保留备查） |
| `legacy/quantumultx/` | 本机在用的 QX 配置（对比基准） |
| `MAPPING.md` | Loon 插件 → Quantumult X 资源逐条映射 |
| `DIFF.md` | **本配置 vs 你的 Loon vs 你的 QX** 逐段差异 |

> 起点是 Loon 转换，但本仓库的目标是**维护一套长期可用的自用 QX 配置**：
> 像 `fmz200/wool_scripts` 那样，把规则、重写、快照与生成脚本都放在版本控制下，
> 上游变化时靠每周任务自动跟进，而不是手工改配置。

## 为什么不是简单的格式翻译

Loon 和 Quantumult X 的差异不在语法，而在**功能承载方式**：

| 能力 | Loon | Quantumult X |
|---|---|---|
| 增强模块 | 插件 `.lpx`（自带 Rewrite / Script / MITM / 定时任务） | 没有插件系统，只有 `rewrite_remote` + `task_local` |
| 节点筛选 | `[Remote Filter]` 的 `NameRegex` | `[policy]` 里的 `server-tag-regex` |
| 分流规则 | `[Rule]` / `[Remote Rule]`（`.lsr`） | `[filter_local]` / `[filter_remote]` |
| 证书 | `[Mitm]` 内嵌 p12 | 必须在 App 内现场生成 |

原配置里有 **40 多个 kelee.one 的 `.lpx` 插件**。这些插件是 Loon 专用的（作者在插件中心明确写着「所有插件均为 Loon 专用，不建议其他工具转换使用」），无法在 Quantumult X 运行，所以这部分**不是翻译，而是用功能等价的 Quantumult X 原生资源替代**。

## 使用步骤

### 1. 导入配置

在 Quantumult X 中：

- **风车 → 配置文件 → 添加配置**，或直接打开链接导入：

  ```
  https://raw.githubusercontent.com/Anymore0010/proxy-profile/master/QuantumultX/default.conf
  ```

### 2. 添加订阅链接

订阅链接是个人敏感信息，**刻意没有写进仓库**。请自行添加：

- **风车 → 节点 → 添加订阅**，粘贴你的订阅链接；
- 或编辑配置文件里 `[server_remote]` 段（那里有一段注释示例）。
- 本配置已设置 `resource_parser_url`，会自动把 Clash / Surge / Loon 格式的订阅转成 Quantumult X 节点。

> 节点名必须含地区关键词（如 `香港`、`🇭🇰`、`HK`），策略组才能按正则筛选到。原 Loon 的正则已原样保留。

### 3. 生成并信任证书

**风车 → 设置 → MITM → 生成证书 → 安装描述文件**，然后到
**设置 → 通用 → 关于本机 → 证书信任设置** 里开启信任。

没有这一步，所有去广告重写都不会生效。

### 4. 选择策略组

导入后先把各地区的「手动策略」选好（香港 / 新国 / 日本 / 美国 / 全球），否则规则命中的策略组是空的。

### 自动刷新状态

**已启用**：`.github/workflows/snapshot.yml` 已在 master 上并被 GitHub 注册（state: active）。

- 每周一 **03:17 UTC** 自动刷新（重转规则 → 拉快照 → 校验 → 有变化才提交）；
- 也可在 **Actions → Snapshot → Run workflow** 手动触发；
- 任何上游失效都不会中断整批刷新：失败的资源记录在 `snapshot/index.json` 与
  `QuantumultX/rules/CONVERSION.md`，任务最后一步才会标红提醒。

本地手动刷新：

```bash
bun tools/vendor-rules.mjs     # 重转 Loon 规则为 QX 原生格式
bun tools/build.mjs            # 生成 QuantumultX/default.conf
bun tools/fetch-snapshot.mjs   # 拉取快照 + 生成离线配置
bun tools/validate.mjs         # 校验
```

## 目录结构

```
QuantumultX/default.conf          在线配置（从 sources.json 生成，勿手改）
snapshot/offline.conf              离线配置（所有资源指向仓库内快照）
snapshot/index.json               快照清单：每个资源的来源、状态
tools/sources.json                唯一事实来源：所有外部资源与本地规则
tools/build.mjs                   生成在线配置
tools/fetch-snapshot.mjs          拉取快照 + 生成离线配置
tools/validate.mjs                校验生成的配置
legacy/loon/                       原始 Loon 配置（转换来源）
legacy/quantumultx/                你本机在用的 QX 配置（对比基准）
MAPPING.md                        插件 → Quantumult X 资源逐条映射
```

改配置请改 `tools/sources.json`，然后：

```bash
bun tools/build.mjs          # 重新生成 QuantumultX/default.conf
bun tools/validate.mjs       # 校验
bun tools/fetch-snapshot.mjs # 刷新快照 + 离线配置
```

## 快照机制

配置文件依赖 59 个第三方资源（含图标）。任何一个上游仓库被删或强推，配置就会**静默地少掉规则**。

因此 `snapshot/` 保存了一份冻结副本，`snapshot/offline.conf` 指向仓库内的副本而不是上游：

- GitHub Actions **每周一 03:17 UTC 自动刷新**（已启用，实测可运行）；
- 上游挂掉时，改用离线配置即可继续工作；
- 手动刷新：`bun tools/fetch-snapshot.mjs`。

在线配置用上游最新资源（更新快），离线配置用仓库内快照（不怕上游失效）。两者都由同一个 `sources.json` 生成，不会互相漂移。

## 规则已预转换为 Quantumult X 原生格式

原本有 3 份规则依赖 QX 的**运行时资源解析器**（`opt-parser=true`，即 Loon 格式文件在手机上现转）。
现已改为**在本仓库内预先转换**，存于 `QuantumultX/rules/`：

| 上游（Loon 格式） | 本仓库（QX 原生） | 规则数 |
|---|---|---|
| ddgksf2013 `AppleIntelligence.list` | `rules/AppleIntelligence.list` | 11 |
| fmz200 `Loon/rule/AI.list` | `rules/AI.list` | 64 |
| fmz200 `Loon/rule/GeoIP_CN.list` | `rules/GeoIP_CN.list` | 1 |

**为什么预转换，而不是让手机现转：**

1. QX 的远程资源**没有 fallback**——文件 404 或解析器脚本一改，规则就在设备上**静默消失**；
2. 运行时解析器转换不了的规则会被丢弃，而且**只在 iOS 上弹一条通知**，很容易漏掉。
   实测 fmz 的 `AI.list` 里有 2 条 `AND` 规则就是这样丢的；
3. 预转换的结果可以**在 git 里审查**，改动、丢弃都留痕。

丢弃的规则记录在 `QuantumultX/rules/CONVERSION.md`（QX 分流不支持 `AND`/`OR`/`NOT` 组合规则，
官方 sample.conf 中也不存在这些类型；拆开写会放宽匹配条件，故选择丢弃）。

重新生成：`bun tools/vendor-rules.mjs`（每周 workflow 也会跑）。

> 其余 `filter_remote` 条目用的是 blackmatrix7 / fmz200 的**原生 Quantumult X 规则库**，
> 本来就不需要解析器，保持上游链接以便自动更新。

## 融合了 fmz200 日常配置

本配置不止是 Loon 的单向转换，还融合了 [`fmz200/wool_scripts`](https://github.com/fmz200/wool_scripts)
的 Quantumult X 日常配置（`QuantumultX/config/QuanX.conf`），因为那套规则覆盖面更广：

| 来自 | 内容 |
|---|---|
| Loon 配置 | 本地分流规则、8 个地区策略组及其正则、DNS、远程分流的语义 |
| fmz200 | 广告拦截合集（重写 + 约 9700 条 reject 分流）、小程序清理、AI/抖音/小红书/快手/GeoIP_CN 分流、策略组、交互式任务 |

### 关于去重

fmz 的 `rewrite.snippet` 是聚合资源（覆盖约 730 款 App）。实测它**包含原先按 App 拆分的 20 个片段中的 19 个**（同一 URL、同一动作）。
同时保留两者会让**同一个响应体被两个脚本重复处理**，因此改为只引用聚合资源，仅保留聚合未覆盖的 4 项：

- 微博去广告
- 高德地图去广告
- 哔哩哔哩去广告
- 京东/淘宝比价

`blackmatrix7` 的两份重写（Advertising / BlockHTTPDNS）是纯 `reject` 规则、不含脚本，重复不会造成二次处理，故保留。

## 分流规则体积说明

`[filter_remote]` 同时引用了两份广告黑名单，实测体量：

| 资源 | 域名数 | 体积 |
|---|---|---|
| blackmatrix7 `Advertising/Advertising.list` | 285,592 | **12.2 MB** |
| fmz200 `filter/filter.list` | 2,624 | 123 KB |

两份重合 1,811 条（fmz 的 69% 被 bm7 覆盖），fmz 另有 **813 条独有**域名。
QX 启动时要把它们全部载入内存匹配，12 MB 那份在手机上是可感知的开销。

**默认两者都保留**（覆盖优先）。若觉得卡顿，二选一：

- 想要轻量：把 `tools/sources.json` 里 `filter-advertising` 的 url 换成
  `.../AdvertisingLite/AdvertisingLite.list`（1.4 MB），再跑 `bun tools/build.mjs`；
- 或直接删除 `filter-advertising` 条目（省 12 MB，但会丢掉那 813 条以外的大量拦截）。

## 相对原配置的取舍

**保留**

- 全部本地分流规则（逐条转换，见 `[filter_local]`）
- 8 个地区策略组及其正则筛选
- DNS（DoH 三源，对应 Loon `doh-server`）
- 远程分流规则的语义
- 去广告、脚本能力（改用 Quantumult X 原生资源）

**未迁移**

- **订阅链接与证书**：敏感信息，需手动添加（这也是仓库可以公开的原因）
- **部分小众 App 插件**：小黑盒、风鸟、LoonGallery、快捷搜索等找不到等价的 Quantumult X 资源。详见 `MAPPING.md`
- **`[Host]` 段**：原配置为空

**行为差异（需知悉）**

- Loon 用 `AND`/`OR` 逻辑组合的分流规则，Quantumult X 远程规则不支持等价写法，极少数依赖组合条件的分流会失效。
- 各家去广告库实现不同，效果不会与 Loon 逐 App 完全一致，建议按 App 实测。
- 离线快照与在线配置由同一份 `sources.json` 生成，两者内容一致，仅资源指向不同。

## 许可证

配置转换部分为个人使用。引用的第三方规则 / 脚本版权归各自作者所有，本仓库仅做引用与快照备份。

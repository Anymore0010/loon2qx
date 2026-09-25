# loon2qx

把一份 Loon 配置（`loon_config/*.lcf`）转换成可用的 Quantumult X 配置。

生成的配置文件：**`QuantumultX/loon2qx.conf`**（另有 `snapshot/loon2qx-offline.conf` 离线版）

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
  https://raw.githubusercontent.com/<owner>/<repo>/main/QuantumultX/loon2qx.conf
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

## 目录结构

```
QuantumultX/loon2qx.conf          在线配置（从 sources.json 生成，勿手改）
snapshot/loon2qx-offline.conf     离线配置（所有资源指向仓库内快照）
snapshot/index.json               快照清单：每个资源的来源、状态
tools/sources.json                唯一事实来源：所有外部资源与本地规则
tools/build.mjs                   生成在线配置
tools/fetch-snapshot.mjs          拉取快照 + 生成离线配置
tools/validate.mjs                校验生成的配置
loon_config/                      原始 Loon 配置
MAPPING.md                        插件 → Quantumult X 资源逐条映射
```

改配置请改 `tools/sources.json`，然后：

```bash
bun tools/build.mjs          # 重新生成 QuantumultX/loon2qx.conf
bun tools/validate.mjs       # 校验
bun tools/fetch-snapshot.mjs # 刷新快照 + 离线配置
```

## 快照机制

配置文件依赖约 54 个第三方资源。任何一个上游仓库被删或强推，配置就会**静默地少掉规则**。

因此 `snapshot/` 保存了一份冻结副本，`snapshot/loon2qx-offline.conf` 指向仓库内的副本而不是上游：

- GitHub Actions **每周一自动刷新**（`.github/workflows/snapshot.yml`），有失败会标记出来；
- 上游挂掉时，改用离线配置即可继续工作；
- 也可以手动在 Actions 页面点 **Snapshot → Run workflow**。

在线配置用上游最新资源（更新快），离线配置用仓库内快照（不怕上游失效）。两者都由同一个 `sources.json` 生成，不会互相漂移。

## 相对原配置的取舍

**保留**

- 全部本地分流规则（逐条转换，见 `[filter_local]`）
- 8 个地区策略组及其正则筛选
- DNS（DoH 三源，对应 Loon `doh-server`）
- 远程分流规则的语义（Loon `.lsr` 换成 blackmatrix7 的 Quantumult X 版）
- 去广告、脚本等能力，用 Quantumult X 原生资源替代

**未迁移**

- **订阅链接与证书**：敏感信息，需手动添加（这也是仓库可以公开的原因）
- **部分小众 App 插件**：小黑盒、风鸟、LoonGallery、快捷搜索等在上游找不到等价的 Quantumult X 资源，未列入。详见 `MAPPING.md`
- **`[Host]` 段**：原配置为空

**行为差异（需知悉）**

- 原 Loon 用 `AND`/`OR` 逻辑组合的分流规则，Quantumult X 的远程规则不支持等价写法。用黑名单规则库替代时这部分覆盖面会略有不同。
- 各家去广告规则库实现不同，「去广告效果」不会与 Loon 逐 App 完全一致，建议按 App 实际验证。

## 许可证

配置转换部分为个人使用。引用的第三方规则 / 脚本版权归各自作者所有，本仓库仅做引用与快照备份。

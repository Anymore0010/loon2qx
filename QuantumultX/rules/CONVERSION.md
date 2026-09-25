# 规则自动转换报告

由 `tools/vendor-rules.mjs` 生成。这些规则原本依赖 Quantumult X 的**运行时资源解析器**
（`opt-parser=true`），现已在本仓库内预转换为 Quantumult X 原生格式。

好处：不依赖运行时解析器、结果可在 git 中审查、被丢弃的规则有记录（而不是只在 iOS 上弹一条通知）。

| 上游来源 | 转换后文件 | 规则数 | 丢弃 |
|---|---|---|---|
| https://raw.githubusercontent.com/ddgksf2013/Filter/refs/heads/master/AppleIntelligence.list | `QuantumultX/rules/AppleIntelligence.list` | 11 | 0 |
| https://raw.githubusercontent.com/fmz200/wool_scripts/main/Loon/rule/AI.list | `QuantumultX/rules/AI.list` | 64 | 2 |
| https://raw.githubusercontent.com/fmz200/wool_scripts/main/Loon/rule/GeoIP_CN.list | `QuantumultX/rules/GeoIP_CN.list` | 1 | 0 |

## 丢弃的规则

Quantumult X 的分流不支持 `AND` / `OR` / `NOT` 组合规则（官方 sample.conf 中不存在这些类型）。
拆开写会放宽匹配条件、拦截到不该拦的流量，因此选择丢弃：

### filter-ai-fmz

- `AND, ((DOMAIN-KEYWORD, chatgpt-async-webps-prod-), (DOMAIN-SUFFIX, webpubsub.azure.com))`  
  原因：AND/OR/NOT 组合规则在 Quantumult X 中无对应写法
- `AND, ((DOMAIN-KEYWORD, openaicom-api-), (DOMAIN-SUFFIX, azurefd.net))`  
  原因：AND/OR/NOT 组合规则在 Quantumult X 中无对应写法


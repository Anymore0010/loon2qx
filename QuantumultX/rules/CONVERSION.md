# 规则自动转换报告

由 `tools/vendor-rules.mjs` 生成。这些规则原本依赖 Quantumult X 的**运行时资源解析器**
（`opt-parser=true`），现已在本仓库内预转换为 Quantumult X 原生格式。

好处：不依赖运行时解析器、结果可在 git 中审查、被丢弃的规则有记录（而不是只在 iOS 上弹一条通知）。

| 上游来源 | 转换后文件 | 规则数 | 丢弃 |
|---|---|---|---|
| https://raw.githubusercontent.com/fmz200/wool_scripts/main/Loon/rule/GeoIP_CN.list | `QuantumultX/rules/GeoIP_CN.list` | 1 | 0 |
| https://raw.githubusercontent.com/ddgksf2013/Filter/refs/heads/master/NOPE.list | — | **抓取失败**：HTTP 404 | — |
| https://raw.githubusercontent.com/fmz200/wool_scripts/main/Loon/rule/AI.list + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/OpenAI/OpenAI.list + https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Anthropic/Anthropic.list | `QuantumultX/rules/AI.list` | 58 | 0 |

## 选项调整（规则保留）

无。

## 丢弃的规则

无。

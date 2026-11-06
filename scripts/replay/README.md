# 压缩阈值离线回放（scripts/replay）

用本机历史会话离线回放 ACP 的增长提醒，比较不同 `nudgeGrowthTokens` 下的 Opus 成本、调用耗时和压缩次数，并统计压缩后的重读、decompress 次数，作为质量代理指标。脚本只读取会话文件，中间数据写到系统临时目录，不随 npm 包发布（`package.json` 的 `files` 不包含 `scripts/`）。

## 运行

```bash
node scripts/replay/extract.mjs --since 2026-10-07      # → $TMP/acp-replay/traces.json
node scripts/replay/quality.mjs                         # 质量代理
node scripts/replay/sim.mjs                             # 基础场景 + 会话 bootstrap
node scripts/replay/sim.mjs --scenarios                 # 敏感性场景
node scripts/replay/sim.mjs --g 50,70,100 --set FOLD_FRAC=1 --set PRESSURE=349000
```

`extract.mjs` 的参数：`--sessions`（默认 `~/.pi/agent/sessions`）、`--since`、`--model`（默认 `claude-opus-5-5`）、`--min-share`（会话中该模型调用的占比下限，默认 0.8）、`--out`。`quality.mjs`/`sim.mjs` 用 `--traces` 指定数据文件。`traces.json` 含文件路径和用户消息片段，不要提交。

## 模型与假设（sim.mjs）

- **单位**：`nudgeGrowthTokens` 和 `minPressureBenefitTokens` 按 ACP 的文本估算计数，`maxContextLimit` 和增长下限按 provider 的 token 计数。`K` 取压缩时“provider ctx ÷ ACP 报告的压缩前大小”的中位数，2026-11 测得为 1.92。它只是历史观测到的比值，不是通用的换算系数。
- **还原增长**：用相邻两次调用的 `input + cacheRead + cacheWrite` 之差作为增长。真实压缩的回收量取“压缩调用的 ctx − 下一次调用的 ctx + 一次典型增长 D0”。差值低于 −20K 且不是紧接在压缩之后，视为分支或跳转并重置；其他负增长从最近的内容里扣掉。失败请求（ctx=0）全部排除，fork 会话里复制自父会话的条目只用来还原状态，不计入成本和次数。
- **保护范围**：按 `computeProtectedRefs` 近似，即最近 `PROTECT_CALLS` 次调用的内容加上最近一条用户消息（`USER_MSG` 个 token）。提醒条件按 `decideNudge`：可压缩量 ÷ K ≥ G，且自上次折叠以来的增长 ≥ max(20K, 0.45·G)。压力护栏条件为 ctx ≥ `PRESSURE` 且可压缩量 ÷ K ≥ 30K。
- **压缩分类**：idle 表示在 idle-check 轮内；task 表示上次压缩以来出现过 `acp-nudge`；user 表示用户消息明确要求压缩；其余归为 self。task 类在回放中由策略重新决定；其余三类按原位置、原回收量折叠，所有 G 相同。
- **每次折叠**：一次 Opus compress 调用（读缓存的 ctx 加 800 个输出 token），等待 11s + 67s，折叠可压缩内容的 `FOLD_FRAC`。下一次调用从最早的改动位置开始全部按未缓存计费。摘要大小 = 4.3% × 折叠量（ACP 单位）× `SUM_K`。
- **普通调用**：价格取 usage.cost 中的标价：缓存读 $0.2/M、未缓存 $4/M、输出 $20/M。耗时 = 实际 durationMs + 9.8ms/K·Δctx + 28.3ms/K·Δ未缓存，这两个系数来自 OLS 回归，只代表相关性；结果下限取 0.2 倍实际耗时。非目标模型的调用沿用实际成本。
- **校验**：`actual-folds` 一行按真实的折叠位置回放。2026-11 的结果是成本比实际高 5.9%、平均 ctx 高 14%（143K 对 125K），说明还原存在偏差，结果只适合比较不同 G 之间的相对差异。

## 已知局限

- 回放固定了模型的行为：压缩时机不同之后，模型会读什么、写什么、摘要质量如何，都没有模拟。
- 质量代理只统计 `read` 工具和 codemode 里字面写出路径的 `tools.read`，bash 的 `cat`/`rg` 不在内。各次折叠的统计窗口互相重叠，会话末尾的窗口会被截断。decompress 主要集中在少数测试扩展的会话里。
- 价格是标价，经过代理后的实际账单没有核对；luna 的价格未知，可用 `--set LUNA_IN=… LUNA_OUT=…` 设置。

## 2026-11-06 结果（10-07 起，123 个会话，去重后 24,339 次有效调用）

| G | 成本 | 模型+压缩等待耗时 | 压缩等待 | 任务折叠次数 |
|---|---|---|---|---|
| 50K | −15.6% | +4.7% | 12.1h | 481 |
| 70K | −9.3%（90% CI −9.9~−8.7） | +1.6%（CI +1.3~+2.0） | 8.5h | 313 |
| 100K | 基准 | 基准 | 5.6h | 180 |
| 130K | +8.7% | +0.2% | 4.3h | 117 |
| 150K | +13.8% | +0.6% | 3.8h | 86 |

所有敏感性场景下，成本都随 G 增大而单调上升；耗时的排序则会随假设改变。用户据此把 Opus 的阈值改为 70K，作为可以回滚的试验配置。

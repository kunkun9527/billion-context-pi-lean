# 当前状态

本次任务的目标是：多次压缩之后，提高 Claude 的 prompt-cache 命中率。基准提交是 v0.3.1 的 `535c090`。

- **compress 声明固定**（已提交）：`lean/index.ts` 中定义了常量 `COMPRESS_DESCRIPTION`。旧实现的描述会随 acp.json 是否配置了专用模型而变。Pi 在加载配置之前就记下了工具声明，之后只要重新读取一次工具列表，就会把 compress 当成新工具重新声明，并排到列表末尾，工具定义之后的整段缓存前缀因此全部失效。最近的 586 个会话里有 42 个出现过这种情况。专用模型的兜底规则现在只写在每轮的系统提示里（`DEDICATED_PROMPT_LINE`）。经用户同意，`lean/tests/facade.test.mjs` 中原先要求“描述必须包含兜底规则”的断言，改成了断言两种模式下声明保持一致。
- **Fold anchor**（已提交，实验性，默认关闭）：实现在 `src/fold-anchor.ts`，接入点在 `src/index.ts`。只有同时满足以下条件才生效：设置了 `ACP_FOLD_ANCHOR=1`、走 `*responses` API、模型名包含 `claude`。生效时，会在最早一个可压缩范围之前的最后一个文本 part 上加 `cache_control`，让压缩后仍保持不变的前缀有机会继续命中缓存。
- `docs/REDESIGN.md`：一份更早的重写方案，没有纳入版本管理。用户的结论是暂不重写。

## 已验证

- `npm run check && git diff --check`：结果见本次提交前的后台日志。
- 真实运行：在临时目录里用 Haiku 5.5 新建会话，执行一次工具调用，再用 `-c` 恢复会话，然后检查 session 中 `role: system` 的条目。旧代码出现了 `added ['compress'] removed ['compress']`，新代码只有一条初始声明。
- Haiku 实验：开启 fold anchor 后，命中率从 74.6% 升到 77.5%。按 `input + 2×write + 0.1×read` 计算的费用指数下降约 9.7%。第 3 次压缩后，第一个请求的缓存读取量从 10.9K 升到 15.2K。两组运行生成的内容并不相同，所以这不是严格的因果结论。

## 已决定不做

- **stale thinking 修复**：压缩会改写历史前缀，导致压缩调用消息上的 thinking 签名失效，服务端会按 `prefix_binding_mismatch` 把这段 thinking 丢掉（CLIProxyAPI 在 `claude_executor_request.go:413-454` 设置了 `drop_block`）。如果这一轮的最后一条回复没有 thinking，下一个请求的缓存就只能命中到锚点为止。回放确认，由客户端主动剥掉这段 thinking 后可以完整命中。但 30 天的 Opus 会话里只有 2 例真正掉了缓存，用户同意先不做。
- **“折叠后模型否认自己调用过工具”**：这是支线问题，与缓存目标无关，用户要求回到缓存这条主线。结论记录如下，代码没有改动：
  - 根因：折叠会把原位置的工具调用连同结果一起移走（pair expansion），摘要则内联进模型自己发起的 compress 参数里。用 Haiku 或 DeepSeek 追问“你读过文件吗”，会稳定地得到“没读过，摘要是我编的”。
  - 曾尝试 D+A：把摘要移到 compress 结果里，并补一句说明。这个方案没有解决问题，已撤回。
  - 请求层模拟（`M:/Temp/fold-view/archive.ts`）显示，只要在原位置保留真实的调用，并在输出里写明“当时已收到，后来被移除”，两个会话 30/30 都承认调用过 read。不过 Haiku 仍可能把时间顺序说错。Oracle 第四轮倾向于把摘要放在 compress 结果里、原位置只保留回执，但这一点还没有实验验证。正式实现估计要改 250–450 行。
  - 没有在 Opus 上验证过（用户考虑成本，不跑）。也没有发现它在真实工作中造成损失的实例。

## 限制与未验证

- fold anchor 在真实长 Opus 会话里的收益还没有验证。增加第二个锚点可能会挤掉代理放在 system 上的断点，Oracle 建议暂时不加。
- 已有会话里 compress 已经排到工具列表末尾，这个顺序会一直保留，新代码只能保证以后不再变化。
- CLIProxyAPI `config.yaml:1610` 已恢复为 `request-log: false`。

## 建议技能

- `code-review`：需要时按 `~/.agents/skills/code-review/auto-spec-review.md` 做 Spec 审查。

## 单一步骤

日常使用 Opus 时，启动 Pi 前设置 `ACP_FOLD_ANCHOR=1`，不需要额外花钱。几天后统计每次 fold 之后第一个请求的 `cacheRead`，看是否高于之前统计的中位数 10.5K。如果有提升且没有异常，再考虑默认开启。

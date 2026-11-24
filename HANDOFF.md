# 当前状态

本次任务的目标是：多次压缩之后，提高 Claude 的 prompt-cache 命中率。基准提交是 v0.3.1 的 `535c090`。

已发布 **v0.4.3**（2026-11-24，合并提交 `c10db4d`，tag `v0.4.3`，GitHub Release 和 npm 都已发布）。发布前 `npm run check` 通过（源码测试 789 个、Lean 测试 27 个），`npm pack --dry-run` 确认含 `lean/index.ts`。包含两项：

- **issue #6**（`fa2ff78`，从 `fix/issue-6` 合入）：Google 推理模型作摘要模型时，非共享前缀的摘要调用改走 `streamSimple(..., { reasoning: "minimal" })`，输出预算不变。没有 Gemini 凭据，未实机复测；报告人尚未回复，用户决定不等验证直接发布，有问题等报告。
- **`compress.claudeFoldAnchor: "tool-output"`**（`e903be7`）：CLIProxyAPI#7782 已由上游 `8cab158` 修复（v8.1.1 起），设成这个值时锚点直接加在范围前的 `function_call_output` 上（item 级 `cache_control`），不再退回更早的文本 part。默认值 `true` 行为不变（只标文本 part）。Oracle 审查要求改成显式开启：item 级字段需要 CLIProxyAPI ≥ 8.1.1，旧版本会丢掉，其他端点不一定接受。用户的 `~/.pi/acp.json` 已设为 `"tool-output"`，本机代理为 8.1.2（`85225381`）。实测（脚本在 `C:/Users/Su/Documents/Pi-Context-Vault/experiments/`，未提交）：`wire_tool_anchor.py`，Haiku 5.5，非流式，约 80K 前缀，折叠后缓存读取 tool 79,740 / text 515 / none 518；`wire_opus_stream.py`，Opus 5.5，流式，按 Pi 的 codex-responses 形状构造，工具输出带图片，签名 thinking 原样回放，约 30K 前缀，折叠后 tool 30,192/30,229、none 527，两组都不报错，模型都能读出图片。
- 新增 `scripts/replay/post-fold-cache.mjs`：按时间点对比每次折叠后第一个请求的缓存命中。

**注意**：`tests/config-panel.test.ts` 会删除并重写真实的 `~/.pi/acp.json`，只有走 `npm test`（加载 `tests/support/isolate-env.ts`）时才会隔离。2026-11-24 单独用 `npx tsx --test` 跑这个文件，把用户的 acp.json 删了，已按用户要求重建为 `compressionModelId: cliproxyapi/gpt-6-luna` + `claudeFoldAnchor: "tool-output"`，其他项取默认。不要绕过 `npm test` 单独跑测试文件。

已发布 **v0.4.0**（提交 `07ee173`，tag `v0.4.0`，GitHub Release 和 npm 都已发布）。发布前 `npm run check` 通过（源码测试 781 个、Lean 测试 27 个），`git diff --check` 通过；Spec 审查只有一条意见（`dist` 没有重建），已修复。注意：这个仓库里直接运行 `gh` 会默认指向上游 `ranxianglei/billion-context-pi`，发 Release 时要加 `--repo kunkun9527/billion-context-pi-lean`。

已发布 **v0.4.1**（2026-11-12，提交 `6c4f2c5`，tag `v0.4.1`，GitHub Release 和 npm 都已发布）。发布前 `npm run check` 通过（源码测试 784 个、Lean 测试 27 个），`git diff --check` 通过；Spec 审查有两条意见：措辞忽略了用户明确要求继续压缩的情况（已改）；hook 测试没覆盖前缀改变（已补）。起点往前移的 hook 测试没有补。这次修了两处：

- **锚点在最后一次折叠后丢失**：真实会话「比较两个 MFG 解锁项目 (2)」（sid `01a1b815…`）里，用户让模型“尽量压缩”，模型连续折叠了 3 次。前两次压缩后，请求都读到了 70,143 的缓存；第三次之后已经没有可压缩范围，`acp.log` 记录 `reason=no-range`，缓存读取降到 10,548，96,043 token 被重写（EasyCLIProxyAPI `usage.db` 第 104098、104100 条）。Oracle 确认这是缓存性能 bug。修法：没有新范围时沿用上一次的起点（`src/index.ts`），在 session start、`/tree`、shutdown 时清空。仍按 ref 编号重新扫描，不保存 index。修复后能否读到约 70K 还没有实测：当时没有保存最终请求体，无法排除前缀本身也变了。
- **连续小折叠**：每多折叠一次，就要把其后的历史重写一遍。现在 Lean 常驻提示要求一次 compress 调用传入全部范围；压缩结果里剩余的范围标注为可选，剩余总量低于 `minPressureBenefitTokens` 时提示停止。结果里仍然列出范围，这是 Oracle 的建议。
- 未做（Oracle 认为优先级低）：摘要模型（Haiku）的一次性请求被代理 cloak 打上缓存断点，按缓存写计费。需要在代理层验证能否关闭，客户端配置未必有效。

- **compress 声明固定**（已提交）：`lean/index.ts` 中定义了常量 `COMPRESS_DESCRIPTION`。旧实现的描述会随 acp.json 是否配置了专用模型而变。Pi 在加载配置之前就记下了工具声明，之后只要重新读取一次工具列表，就会把 compress 当成新工具重新声明，并排到列表末尾，工具定义之后的整段缓存前缀因此全部失效。最近的 586 个会话里有 42 个出现过这种情况。专用模型的兜底规则现在只写在每轮的系统提示里（`DEDICATED_PROMPT_LINE`）。经用户同意，`lean/tests/facade.test.mjs` 中原先要求“描述必须包含兜底规则”的断言，改成了断言两种模式下声明保持一致。
- **Fold anchor**（默认开启，用户长期使用）：实现在 `src/fold-anchor.ts`，接入点在 `src/index.ts`。默认开启，用 acp.json 的 `compress.claudeFoldAnchor: false` 或设置面板关闭，和其他 `compress` 字段一样可以按 provider 或 model 覆盖（最初版本用的是环境变量 `ACP_FOLD_ANCHOR=1`，已改为配置项）。只有同时满足以下条件才生效：配置未设为 `false`、走 `*responses` API、模型名包含 `claude`。用户的 `~/.pi/acp.json` 设为 `"tool-output"`。生效时，会在最早一个可压缩范围之前的最后一个文本 part 上加 `cache_control`；设为 `"tool-output"` 时，工具输出直接标在该项上（v0.4.3 起，见「当前状态」），让压缩后仍保持不变的前缀有机会继续命中缓存。
- `docs/REDESIGN.md`：一份更早的重写方案，没有纳入版本管理。用户的结论是暂不重写。

## 已验证

- `npm run check && git diff --check`：结果见本次提交前的后台日志。
- 真实运行：在临时目录里用 Haiku 5.5 新建会话，执行一次工具调用，再用 `-c` 恢复会话，然后检查 session 中 `role: system` 的条目。旧代码出现了 `added ['compress'] removed ['compress']`，新代码只有一条初始声明。
- 线路实测（Haiku 5.5，直接请求本地 CLIProxyAPI 8.0.67）：构造两次请求，第一条 user 消息之后放一段约 2.2 万 token 的稳定前缀 A，后面的内容在第二次请求里换成一句摘要，模拟折叠。不加锚点时，第二次请求的 `cached_tokens` 为 0；在 A 上加锚点后，`/backend-api/codex/responses`（`cliproxyapi-codex-responses`）读到 22,100，`/v1/responses`（Pi 内置的 `openai-responses`）读到 23,404。两条线路都不报错。注意：把 A 放在第一条 user 消息时，不加锚点也能全部命中，因为代理的 cloak 本来就会在第一条 user 消息上打断点。其他代理（例如别家的 Responses 接口）没有条件测试。
- Haiku 实验：开启 fold anchor 后，命中率从 74.6% 升到 77.5%。按 `input + 2×write + 0.1×read` 计算的费用指数下降约 9.7%。第 3 次压缩后，第一个请求的缓存读取量从 10.9K 升到 15.2K。两组运行生成的内容并不相同，所以这不是严格的因果结论。

## 已决定不做

- **调整 fold anchor 的起点规则**（2026-11-20 一周复盘，Oracle 第二轮同意）：代码没有 bug，标注位置与线路效果都正常。收益低的原因是模型经常跳过最早的小残段，从更后面开始折叠：50 次折叠中 22 次押早，6 次完全押中，12 次从 m00001 开始，本来就没有前缀可保。改成「最早 ≥5K」只多拿约 0.7% fresh，而且大部分来自一个会话，有过拟合风险，所以不改。另外，当时 CLIProxyAPI 会丢掉 function_call_output 上的 cache_control（https://github.com/router-for-me/CLIProxyAPI/issues/7782），锚点只能退回更早的文本，这次复盘的收益数字因此偏低；8.1.1 已修，v0.4.3 起可用 `"tool-output"` 把锚点打在工具输出上（见「当前状态」），这一条需要用新数据重新评估。证据 `M:/Temp/acp-live/EVIDENCE.md` 已随临时目录清理，不存在了。若以后重新评估，按原始调用 ID 去重、用真实 pre/post 载荷并按会话留出验证，只改 `src/index.ts:413-415`。

- **stale thinking 修复**：压缩会改写历史前缀，导致压缩调用消息上的 thinking 签名失效，服务端会按 `prefix_binding_mismatch` 把这段 thinking 丢掉（CLIProxyAPI 在 `claude_executor_request.go:413-454` 设置了 `drop_block`）。如果这一轮的最后一条回复没有 thinking，下一个请求的缓存就只能命中到锚点为止。回放确认，由客户端主动剥掉这段 thinking 后可以完整命中。但 30 天的 Opus 会话里只有 2 例真正掉了缓存，用户同意先不做。
- **“折叠后模型否认自己调用过工具”**：这是支线问题，与缓存目标无关，用户要求回到缓存这条主线。结论记录如下，代码没有改动：
  - 根因：折叠会把原位置的工具调用连同结果一起移走（pair expansion），摘要则内联进模型自己发起的 compress 参数里。用 Haiku 或 DeepSeek 追问“你读过文件吗”，会稳定地得到“没读过，摘要是我编的”。
  - 曾尝试 D+A：把摘要移到 compress 结果里，并补一句说明。这个方案没有解决问题，已撤回。
  - 请求层模拟（`M:/Temp/fold-view/archive.ts`）显示，只要在原位置保留真实的调用，并在输出里写明“当时已收到，后来被移除”，两个会话 30/30 都承认调用过 read。不过 Haiku 仍可能把时间顺序说错。Oracle 第四轮倾向于把摘要放在 compress 结果里、原位置只保留回执，但这一点还没有实验验证。正式实现估计要改 250–450 行。
  - 没有在 Opus 上验证过（用户考虑成本，不跑）。也没有发现它在真实工作中造成损失的实例。

## 限制与未验证

- fold anchor 在真实长 Opus 会话里的收益此前很小（见上方「已决定不做」）：折叠后首个请求的缓存读取中位数，更新前约 10.7K，更新后约 9.5K；2026-11-24 用 `post-fold-cache.mjs` 复测前 14 天为 9.9K（n=70，命中率中位数 17%）。这些都是旧锚点加旧代理的数据，`"tool-output"` 在真实长会话里的收益还没测（只有上面的线路实测）。v0.4.1 声明漂移的修复在真实使用中生效（24 个会话 → 1 个）；Opus 连续折叠 8 → 0。增加第二个锚点可能会挤掉代理放在 system 上的断点，Oracle 建议暂时不加。
- 已有会话里 compress 已经排到工具列表末尾，这个顺序会一直保留，新代码只能保证以后不再变化。
- CLIProxyAPI `config.yaml:1610` 已恢复为 `request-log: false`。

## 建议技能

- `code-review`：需要时按 `~/.agents/skills/code-review/auto-spec-review.md` 做 Spec 审查。

## 单一步骤

用户重启 Pi 后 `"tool-output"` 生效，记下重启时间（UTC）。正常使用约一周、攒到 30 次以上折叠后运行 `node scripts/replay/post-fold-cache.mjs --split <重启时间>`：after 段的命中率中位数明显高于 before 段的 17%，就把结果交给用户，由用户决定是否改成默认值，并决定是否重新评估「起点规则」；没有提升，就检查 `acp.log` 里的 `fold-anchor` 记录，看锚点有没有打上、打在哪一项。这一步是端到端验证：目前只有单元测试和直连代理的线路实测，还没有经过 Pi 真实折叠和请求钩子的结果。另外留意 issue #6 报告人的回复。

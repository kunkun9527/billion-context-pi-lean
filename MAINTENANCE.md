# 维护说明

本仓库是 [`ranxianglei/billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) `v0.1.83` 的长期维护分支。用法和与上游的区别见 [README](README_zh-CN.md)；本文记录实现细节、改动原因和维护流程。

## 结构

- 分支：`main`（默认分支）。远程 `origin` 是本仓库，`upstream` 是上游，只用于 fetch 和挑修复。
- 基线：上游 tag `v0.1.83`（commit `1cb6340`），之后的上游提交不自动合并。
- 运行时源码：`src/`，`npm run build` 生成 `dist/`。`acp-kernel@0.0.101` 由 tsup 打进 `dist/`，运行时只依赖 Pi 自带的包。
- Lean 外壳：`lean/index.ts`（测试 `lean/tests/facade.test.mjs`），通过 `../dist/index.js` 引用运行时；`package.json` 的 `pi.extensions` 指向它。
- `dist/` 提交进仓库（`*.map` 除外）：Pi 用 git 安装时执行 `npm install --omit=dev`，不会 build，也装不到 tsup 和 kernel。jiti 只加载 `lean/index.ts`，不能直接加载 `src/`。CI 会检查提交的 `dist/` 与源码一致。
- 移植来源：上游 PR #241（commits `631d51e`、`c5e7de8`，基于 0.1.52，无法直接 rebase）。

## 改动记录（相对上游 0.1.83）

### 专用摘要模型（移植 PR #241 并改进）

- 模型解析与调用走 `ctx.modelRegistry`（`find`/`getAll`/`complete`）。PR 原本用 `ModelRuntime.create(models.json)`，看不到由扩展注册的 provider。
- `complete()` 只有 Pi >= 1.x 才有；宿主没有时抛错，回退到调用方提供的摘要。
- 主模型提供 1–2 句有意义的回退摘要，不用裸占位符 `"compressed"`；它作为 `<caller_note>` 传给专用模型。专用模型对某个范围调用失败时，这个范围不折叠（否则短回退摘要会顶替详细摘要，refold 时还会顶替旧块摘要），同一次调用里成功的范围照常折叠；全部失败时工具报错，计入重试上限。只有模型解析不到、或宿主没有 `complete()` 这类配置问题，才用回退摘要折叠并警告。
- 折叠结果记在 compress toolResult 的 `details.acpFolded`（不发给模型）；sidecar 丢失后从会话日志重建时优先用它（`src/state-rebuild.ts`）。外壳 `wrapCompress` 只改写 `content`，`details` 原样透传。
- 专用模型输出再走一遍 `sanitizeSummary`；`signal` 透传，abort 时停止剩余 range。
- 注册表模型模式：Nudge 里的 `howToCompressRules` 换成只讲选范围和回退摘要的短版本（`src/index.ts` 的 `nudgePrompts`）；`session` 模式保留完整规则，因为它的摘要调用复用主会话前缀。
- `extractRangeContent` 把范围内活动块渲染为 `[earlier summary bN]` 摘要，不再重发原始消息。原先重新压缩一个覆盖旧块的大范围时，送去的原文可达百万字符，再被 120K 字符的首尾截断丢掉大部分；早期决策因此在一次次重写中丢失。截断改为按专用模型的 `contextWindow` 计算（`fitToModel`）。
- 专用模型的系统提示末尾加了 CARRY FORWARD 规则，要求原样继承旧摘要里的决策、数值和未完成目标。
- 旧块摘要保护：`extractRangeContent` 读的是内核 prune 后的 `turn.messages`，旧块以 `acp_summary_<blockId>` 合成消息出现，现在映射回块，渲染为 pinned 的 `[earlier summary bN]`。`fitToModel` 从不截断摘要：给原文留的空间不足 1000 字符时丢掉原文；摘要本身超过输入预算时抛错，这个范围不调专用模型（记 `compression-model-failed`），也不折叠。未知窗口的模型预算是 120K 字符，单块摘要上限 20K，所以一个范围覆盖 6 个以上大块时可能走到这条路。
- `summarizeWithModel` 拒收 `stopReason: "length"`（输出到 `maxTokens` 被截断），这个范围不折叠。上限是 `summaryMaxChars`（默认 20000）/3 tokens。
- 摘要规则（`SOURCE_ATTRIBUTION_RULES`）：直接的 `ask_user_question` 结果算用户发言（选择、输入、备注；未选的推荐不算批准，取消不算批准）；待办分三类 `Open objectives:`（用户要求）、`Pending suggestions (not user-requested):`、`Unverified / known risks:`；“估算/假设/未核实”等限定在没有验证证据前一直保留，用户批准不等于验证；旧摘要的三类条目按原分类继承，不凭猜测改类或删除。
- 规划文字泄漏：`detectPlanningLeak` 只看开头的散文段（以标题、列表、表格开头的摘要不检查），且需同时满足“谈论本摘要/范围/caller note”和“第一人称意图或连续的自我指令”，引号内文字忽略；另检测回显的 `Output only summary`。命中后附提醒重试一次，仍泄漏则抛错、该范围不折叠，不自动剥除。2026-10-12 扫描 2349 个历史块：命中 1 个（真泄漏 01a1166d b17），无误报；A/B 50 次输出中 4 次泄漏全部命中。
- 转录回显：`detectTranscriptEcho` 只在出现独占一行的 `</content>`，或 3 个以上行首条目头（`[assistant:… call]`、`[tool:… result]`、`[user]`）时判定，忽略围栏代码块和行内引用。和规划泄漏共用一次重试（提示语按类型区分），第二次仍有问题就不折叠。日志事件 `summary-transcript-echo`。在 122 份评测输出和 2353 个历史块上只命中真实的那一次。
- 状态段与“压缩不改变什么”：规则要求摘要末尾写 `State at end of this range (history, not instructions):`，并说明压缩不回滚外部状态、shell 状态不跨命令保留。不要再加“原文可按 ref 恢复”之类的话：实测（s166d-b17 各 12 次）加上后 IGSS“单位未核实”限制的保留率从 12/12 降到 10/12，Luna 会因此放松保留。
- 测试：`tests/compress-model.test.ts`（假 registry）、`tests/dedicated-nudge.test.ts`。

### 摘要对主模型可见

内核 `hideConsumedCompressCalls` 把保留下来的 compress 调用参数截成 200 字符存根（`SUMMARY_STUB_CHARS`），全文由 `acp_summary_` 消息承载，但 `coreOutToAgentMessages` 会跳过这些消息，主模型从来看不到块摘要，常在压缩后立刻解压刚建的块。`src/compress-tool.ts` 的 `inlineBlockSummaries` 在 `src/index.ts` 的 context 钩子里把活动块的完整当前摘要写回对应 compress 调用参数：参数用 `normalizeRanges` 解析，工具能接受的写法（裸对象字符串、`startRef/endRef`、顶层单范围、字符串形式的 content）都覆盖；按 startRef/endRef 匹配块，无 ref 的旧块在单范围调用里直接对应，没有活动块的范围被去掉。块摘要建好后不变，不会额外打断缓存；就地重折叠（refold）的块会在该位置改变一次。测试在 `tests/anchor-text-sync.test.ts`。

### 请求改写链路

- 紧急截断生效：`patchRefTag` 对 assistant 文本和无 ref 标签的消息也同步内核的截断正文（以 `[truncated for context space]` 标记为准）。以前内核截掉了、出站却还是原文。
- 最近一条用户消息不被紧急截断：`protectLatestUserMessage`（`src/messages.ts`）在 `processTurn` 后恢复它的原文，再把这部分预算交给内核截断器去截其他候选。仍然放不下时记 `latest-user-kept` 日志并提示一次。内核（0.0.98，上游 0.0.119 仍未修）本身不动。
- 计量复用：`sentViewMeterMatches` 用活动块签名（块 id、覆盖数、runId、tier、摘要长度）和历史金丝雀（记录时的消息数、首尾 id，要求这一轮只是在后面追加），记录上一轮的原始估算，采用时加上这一轮的新增（`adoptedViewTokens`）；原始估算变小、分支切换、回退或就地 refold 都会重新测量。
- compress 调用里实际会发出去的 thinking 计入估算（`keptCompressThinkingTokens`，和请求时的删除规则一致），只在 context 钩子里用；`acp_status` 等显示的数字没有加这一项。compress 的工具结果计入 `estimateTokens`；调用参数仍跳过，因为块摘要已经由内核的摘要消息计过一次。
- `acp_context` 的调用和结果在投影里用它包装的 op 名（decompress/search_context/…），内核按工具名的策略（`neverPreserveRecentTools`、受保护工具等）因此对外壳生效；出站消息仍是 `acp_context`。
- 应用 Pi 的 `context_edit`（`applyContextEdits`，`src/messages.ts`）：`buildContextEntries()` 只返回原始路径，不应用编辑；Pi 自动重试（`_omitRecoveryAttempt`）用 `replacement: null` 的编辑删掉失败尝试，不处理就会被重建的请求重新发出。语义照 Pi `buildSessionProjection`：`null` 省略目标，否则只替换 content（assistant/toolResult 的字符串转成一个 text part）；编辑条目本身保留在数组里（投影为空），供下面的判断定位。`runtime.stateFor` 和 `/acp export` 都先过它；增量投影缓存遇到新的 `context_edit` 就整体重投影。
- 宿主用量只在是实测值时使用（`measuredHostTokens`，`src/floor-stale.ts`）：`getContextUsage()` 只有锚定在一条有效 assistant usage（非 error/aborted、usage>0）且其后没有 `context_edit` 时才是 provider 实测；否则 Pi 的 `estimateProjectedContextTokens` 会按字符粗估自己的整段投影，也就是未折叠的原始历史（2026-10-21 一例：发送视图 54K，宿主报 641,881）。此时 context 钩子不设 hostFloor、不校准、不喂溢出守卫，`/acp` 面板和 `acp_status` 的仲裁也一样；面板里标着 host footer scale 的那一行仍照搬 Pi 的数字。turn 日志记 `hostIgnored=estimate`。
- 测试：`tests/lean-rewrite-guards.test.ts`、`tests/sent-view-meter.test.ts`、`tests/tokens.test.ts`、`tests/integration.test.ts` 末尾的紧急截断用例，`tests/floor-stale.test.ts`、`tests/incremental-projection.test.ts` 的 context_edit 用例。

### 系统提示

- `externalSystemPrompt`（`AdapterConfig`，只由宿主设置，`applyUserConfig` 不读 acp.json 里的同名键）：外壳仍运行上游 `before_agent_start` handler（active pack 戳、`setPrompts` 等副作用），只替换它返回的提示词；上游返回 undefined（宿主被拒）时外壳也不注入。用户在 acp.json 里写了 `promptSections.*` 时，记 `prompt-config-ignored` 并提示一次；内置 lean pack 自带的 promptSections 不提示。测试在 `tests/prompt-pack.test.ts`。

### 测试隔离

`npm test` 预加载 `tests/support/isolate-env.ts`，把 `HOME`、`USERPROFILE`、`ACP_LOG_FILE` 指向临时目录，跑完删除。上游原本没有隔离，大部分测试会写进真实的 `~/.pi/acp.log`。`tests/e2e-compress-config.test.ts` 的 `withConfigDir` 同时改 `HOME` 和 `USERPROFILE`（Windows 上 `os.homedir()` 读后者）。symlink 逃逸用例的目标改为临时目录所在盘的根目录，不再依赖 `HOME`。

### 状态持久化与分支
- sidecar 写入按文件串行，每次写用独立临时文件名（`src/state.ts`），写入内容在调用时就快照，文件反映调用顺序。`acquireLock` 释放时只在队尾仍是自己时才清槽位（`src/runtime.ts`）。compress、decompress、`acp_rule` 在读-改-存期间持有会话锁。
- 分支守卫（`src/branch-guard.ts`）：内核 `syncBlocks` 只要块覆盖的消息有一条在视图里就激活该块。`/tree` 回到块范围中间时，摘要会顶替仍在视图里的消息，泄漏该分支还没发生的内容。`runtime.stateFor`（仅 Pi 宿主）用 `sessionManager.getEntries()` 找出“部分消息在视图、部分消息是持久化但不在当前分支”的块，`withBranchGuard` 包装的 `processTurn` 本轮把它们当作 expanded 处理（原文显示），并在结果里恢复原 `expanded`，不写入 sidecar。不在会话文件里的缺失 id 维持内核原行为。
- 按消息 ref 自动解压到文件时，文件名用 `messageFileStem`：安全 ref 原样，含 `|` 等字符的原始 entry ref 改成净化前缀加短哈希。

### 移除子代理（Delegation）

子代理不属于上下文管理，整套删除：`acp_delegate`/`acp_delegate_wait`/`acp_delegate_cancel` 工具、fleet 面板和 `/acp-fleet`、`/acp-subagents` 与 pi-subagents 检测、`ACP_DELEGATE NOTIFICATIONS` 系统提示附录、`acp_status` 里的 delegate 用量，以及配置键 `delegate.*`、顶层 `displayUsage`、`delegatePrompt` 和 `PI_ACP_DELEGATE_*` 环境变量。旧 acp.json 里的这些键按未知键忽略，不报错。需要子代理时用独立的子代理扩展；它的会话照常由 ACP 管理。

### 移除 bash 默认超时和工具输出上限

这两项不属于上下文管理，移植 [keel-fold](https://github.com/SeniorHan/keel-fold) 的 `3189c29`、`8719091` 删除：`toolBashDefaultTimeout`（模型没给 timeout 时注入 60 秒）和 `toolOutputMaxBytes`（工具结果超 50,000 字节截头），连同 `/acp-config` 的两项。Pi 自己按 2000 行/50KB 截断 bash/read/grep 并把完整输出存文件，ACP 的上限比它略低，基本只在 50,000–51,200 字节之间触发，反而切掉 Pi 的截断说明；超时交给 bash 工具或 bash 扩展。旧 acp.json 里的这两个键静默忽略。保留：Pi 报告 bash 超时时附加的重跑提示（`detectBashTimeout`）和重复调用防护。

### Lean 外壳

- 工具面：直接暴露 `compress`（以 `model-only` exposure 注册，codemode 下也直接声明给模型；ACP 按工具名在会话里识别 compress 结果），把 `decompress`、`search_context`、`acp_status`、`acp_cache` 合并到 `acp_context`。自更新代码（`src/update.ts`）已删除，`autoUpdate` 配置被忽略。
- Pi 1.x 上把 ACP 规则写进 `systemPromptOptions.sections.acp_context`，不返回 `systemPrompt`。返回 `systemPrompt` 会变成 `forceSystemPrompt`，导致其它扩展的 `appendSystemPrompt` 被丢弃（上游 #630/#631）。其它扩展已经 force 过时，退回拼接的旧行为。
- 去掉 “Refs may be renumbered” 的错误说法（上游 #541）。
- 改写规则：覆盖 `acp_cache(...)` 和 “call/run acp_status …”；调用改写用非贪婪匹配（避免同一行两个调用被合并）。召回结果不改写（`rewriteRecallResult`）：decompress 的输出原样返回；search_context 只改写每条结果末尾的提示行——必须完全符合上游格式 `  → decompress({ blockId: "bN" })`（可带 `  (block containing message <原始 entry id>)`，id 形如 `088aaedb` 或 `4d9e965e#toolu_…|fc_…`，不是 mNNNNN），且后面是空行或文末（`SEARCH_HINT_LINE`）。预览是召回原文，一律不动。上游改 `src/search-tool.ts` 的 `formatResult` 或给这两个工具新增提示文字时，要同步这里的正则。
- 系统提示列出每个 op 的参数签名（`OPERATION_SIGNATURES`）。只写 “original args object” 时，模型常照搬 compress 的写法传 `startId/endId`、`ids/refs`，缺 `blockId`。参数校验失败时，报错里也给出正确签名。
- 系统提示保留“不要把解压当成压缩后的例行步骤”：块摘要显示在 compress 调用参数里，只在需要摘要里没有的细节时才 search/decompress。compress 折叠成功后，结果末尾再提示一次（`COMPRESS_DONE_HINT`，只在 `details.acpFolded` 存在时加）。
- 常驻提示只放调用前必须知道的规则：隐藏 ref、压缩边界、op 签名、摘要是历史元数据。调用后才用得上的说明已由对应消息给出，不再常驻：压缩时机和写法（nudge）、失效 ref 的恢复（compress 拒绝信息附当前可压缩范围并提示 acp_status）、解压写文件（decompress 结果带路径和 read 提示）、限流恢复（`THROTTLE_KICK_TEXT`）。
- 专用摘要模型的“只写 1-2 句 fallback”规则由提示钩子每轮按 compress 描述 getter 追加（`DEDICATED_PROMPT_LINE`）。不能只靠 compress 描述：Pi 1.3 在绑定扩展时（`_refreshToolRegistry` → `wrapToolDefinition`）就快照工具描述，pi-collapsed-tools 的 `{...base}` 也会快照 getter，而 `compressionModelId` 要到 session_start 的 `reloadConfig` 才载入，所以模型看到的始终是非专用描述。
- 参数兜底（`prepareArguments`，Pi 在 schema 校验前调用；纯函数、幂等、不改入参、不增加模型可见 token）。`acp_context`（`prepareFacadeArguments`）：`args` 是 JSON 字符串则解析成对象；顶层的 op 字段（按上游真实 schema 的 `properties` 取字段名，help 为 `tool`）归入 `args`，`args` 已有不同值时不覆盖；漏传 `op` 时，只有恰好一个操作独占的字段（`blockId`/`query`/`scope`/`view`/`sort`/`detail`/`full`/`toFile`/`inline`）且所有已识别字段都属于该操作才推断；`limit`、`tool` 被多个操作共享，help 从不推断；显式 op 原样保留，非法 op（如 `buildStatusReport`）原样交给校验报错。`compress`（`prepareCompressArguments`）：`content` 是 JSON 字符串、数组里有 JSON 字符串元素、或没给 `content` 而 `summary` 是范围数组/其 JSON 字符串时，解析后挪进 `content`（保留顶层 `topic` 等）；只有结果全是 `{startId,endId,summary}` 字符串对象时才改，行格式字符串、残缺 JSON 等原样留给上游 `normalizeRanges`。上游 compress 若有 `prepareArguments`，先跑它再跑本层。升级上游时检查：`decompress`/`search_context`/`acp_status`/`acp_cache` 的参数名是否出现新的共享字段（会让推断失效或改变）；`RangeSpec` 必填字段是否变化（`isRangeSpec`）；`compress` 的 `content` 联合类型和 `prepareArguments` 是否变化。
- 测试：`lean/tests/facade.test.mjs`，含工具面、1450 字符提示预算和参数兜底（用真实 schema 过 Pi 的 `validateToolArguments`）。

### 空闲压缩（Idle compact，`idleCompact`）

- 目的：用户离开后回来，第一条请求会把整段长上下文按无缓存价格重写一次。会话空闲 `idleMinutes`（默认 29，对应 30 分钟缓存）后，用 `pi.sendMessage(..., { triggerTurn: true })` 发一条 `acp-idle-check` 消息启动一轮，context 钩子在这轮强制附上常规 compress nudge（不受增长、使用率阈值和每轮去重限制），由主模型决定是否压缩。实现在 `src/idle-compact.ts`，默认关闭。
- 只有一个全局分钟数，不按模型推断 TTL：各家缓存时长差异大，无法替所有模型定义。缓存短于设定值时，检查轮本身读不到缓存。
- 计时照搬 pi-keepwarm：锚点是一次 run 里最后一个 provider 请求的开始时间（只认 `agent_start` 到 `agent_settled` 之间的请求，keepwarm 等空闲期请求不算活动）；`agent_settled` 后布防，`agent_start` 时撤销；`model_select`、`session_tree` 作废锚点，等下一次真实请求重新计时。子代理唤醒、throttle kick 等任何 run 都算活动，只有空闲检查自己的 run 不重新计周期，所以一次空闲最多检查一次。
- 跳过条件：非 TUI/RPC 模式、会话不空闲、定时器晚醒超过 1 分钟（`IDLE_LATE_MS`，电脑睡眠后）、throttle 重试待发、可压缩量低于 `minPressureBenefitTokens` 或没有可用范围（取上一次 context 事件的 nudge 决策）。跳过记 `idle-compact` 日志。
- 检查轮里 `tool_call` 只放行 ACP 工具（compress、acp_context 及其包装的 op），其它工具被拦截。用户输入（`input` 事件，非扩展来源）或子代理等扩展消息到达时解除限制，这一轮变成普通 run，结束后重新计时。
- 测试：`tests/idle-compact.test.ts`（mock 定时器；定时器回调里 `Date.now()` 是 tick 的终点，测试按触发点精确 tick）。

### 设置面板（/acp-config）

- `src/config-panel.ts`：pi-tui 的 `SettingsList`（摘要模型子菜单是 `SearchableList`：`Input` + `SelectList`，列 `modelRegistry.getAvailable()`，打字用 pi-tui 的 `fuzzyFilter` 过滤并重建列表；`SelectList.setFilter` 只做前缀匹配，搜不到 `cliproxyapi/claude-opus` 里的 `opus`），主题取宿主的 `getSettingsListTheme`。`PANEL_ITEMS` 的顺序就是面板顺序（按常用程度）；`dependsOn` 指向上游开关，上游为 `off` 时 `panelDisplay` 把该项显示为 `off` 并去掉 `values` 锁住（存储值不动），上游保存后在 `save` 里刷新下游——`SettingsList` 按引用持有 item，直接改对象即可。pi-tui 和其它运行时代码一样由 tsup 打进 `dist/`。
- 显示的是生效值（含项目 acp.json）；改动经 `updateGlobalAcpConfig` 读-改-写全局 `~/.pi/acp.json`（不认识的键原样保留，解析失败的文件不覆盖），再 `reloadConfig` 立即生效。写完回读生效值，与所选不同说明项目配置覆盖了该项，提示用户。摘要模型走 `runtime.setCompressionModelRef`，和 `/acp compact` 同一路径。
- 按模型的三项写到 `compress.providers.<provider>.models.<id>`；选 `inherit` 删除该键并清掉空对象。面板文案全部用英文（扩展面向所有用户），README_zh-CN 的设置表标注了对应中文。没有当前模型时隐藏这三项。
- 空闲开关和分钟数改动后调用 `IdleCompactHandle.rearm()` 按新值重排定时器。
- 测试：`tests/config-panel.test.ts`（含一次真实渲染和按键保存，测试里需先 `initTheme()`）。

## 修改流程

1. 改 `src/` 或 `lean/`。
2. 在仓库根目录运行 `npm run check`（typecheck + 全量测试 + build + 外壳 typecheck + 外壳测试）。单独用 `npx tsx --test` 跑某个文件时，加上 `--import ./tests/support/isolate-env.ts`，否则会写进真实的 `~/.pi/acp.log`。
   改了工具描述或注入的提示词后，运行 `npm run measure` 重测占用，并同步 README 对比表里的数字。它借用同级目录 `my-lean-pi-setup` 的 `measure-extension-worker.mjs`，在隔离的空白 Pi 会话里测量；设置 `PI_CODING_AGENT_MODULE` 可指定要测的 Pi 版本。
3. 把 `dist/` 的变化和源码一起提交。
4. 端到端验证：在临时目录里用 `pi --no-session --mode json -p ...` 读几个文件，再让模型 compress，确认结果里出现 `summaries written by ...`，`~/.pi/acp.log` 里没有 `compression-model-failed`。
5. 发版：版本号按 semver 独立编号，不跟上游（修复递增 patch，新功能递增 minor）。`npm version <x.y.z> --no-git-tag-version --ignore-scripts`，`npm run build`，提交后打 tag `v<x.y.z>` 并推送，用 `gh release create` 发 GitHub Release，再在同一提交上 `npm publish`。发布前用 `npm pack --dry-run` 确认包里有 `lean/index.ts`。中文 README 命名为 `README_zh-CN.md`：npm 会强制打包 `README.*`，可能拿它当包主页。

## 挑上游修复

`git fetch upstream`，看 `upstream/master` 和 [billion-context](https://github.com/ranxianglei/billion-context) 的 `fix` 提交，只挑和本仓库行为相关的，`git cherry-pick -x` 或手工移植，按上面的流程验证。冲突主要集中在 `src/compress-tool.ts` 的 `handleCompress` 和 `src/messages.ts`。只涉及 delegate/fleet/subagent 的上游提交直接跳过；混在一起的提交只移植非子代理部分。上游新增工具时，在 `lean/index.ts` 把低频工具加入 `LOW_FREQUENCY_TOOLS`，并检查新的模型可见文本是否需要补改写规则。

## 已知事项

- `compressionModelId` 填 `provider/id`。裸 id 在多个 provider 下重名时判为歧义。
- 注册表里有某个模型，不代表 provider 真能服务它。调用失败时该范围不压缩；在 `~/.pi/acp.log` 中搜 `compression-model-failed`。
- 不做“强制继承旧块 Open objectives”：2026-10-12 核查全部 15 个 refold、40 条旧目标，确认丢失 0 条，另有 8 条本来就不是用户目标（助手建议、读到的资料），强制继承会把它们一直传下去；b24 “漏掉”的 3 条属于这类。改为摘要规则：问卷答案归用户、三类待办分开、未核实限定保留（见上）。注意：样本小，原文中段被截断或内核紧急截断时，新目标仍可能到不了专用模型。
- 新规则下摘要变长：A/B 中 b17（并入 3 个旧块）平均从约 9.3K 字符增到 15K 字符，输出最多用到上限（≈6.7K tokens）的 75%。上限由 `compress` 调用参数 `summaryMaxChars`（默认 20000）/3 决定，不是 `acp.json` 配置项；若频繁出现 `hit its output limit`，需要在规则里引导主模型传更大的 `summaryMaxChars`，或改 `src/compress-tool.ts` 的默认值。
- 不要和原版 `billion-context-pi` 同时启用（工具和钩子会注册两次）。
- 命名：2026-10-12 之前叫 Lean2（子目录 `lean2/`、版本 `0.1.83-pr241-lean2.N`），之后改名为 Lean，版本从 `0.1.83-lean.6` 续，到 `0.1.83-lean.10`；从 `0.2.0`（2026-10-17）起独立编号，上游只按需移植。更早的 Lean v1（`0.1.69-lean.1`，基于 npm 包的外壳）保留在 `legacy-v1` 分支。

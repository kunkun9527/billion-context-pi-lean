# billion-context-pi-lean

<!-- token-benchmark:summary:start -->
> **Token 基准：Lean 486，上游 `billion-context-pi@0.1.83` 8,670，减少 94.4%。**
<!-- token-benchmark:summary:end -->
> [查看我的完整 Pi 配置](https://github.com/kunkun9527/my-lean-pi-setup)

[English](README.md)

给 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) 用的上下文管理扩展，让长会话能一直做下去：上下文快满时，模型把做完的部分折叠成摘要块，原文随时可以取回。

本仓库是 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) **v0.1.83** 的分支，专注于运行稳定性和降低 token 消耗。它保留上游的压缩引擎（ACP），主要改动是：**摘要可以交给便宜模型写**，**上下文管理本身少花 token**，以及**你离开时趁提示缓存还没过期先压缩长会话**。上游已转向 [`billion-context`](https://github.com/ranxianglei/billion-context)；本分支停在 0.1.83，按需手工挑选上游修复，与上游没有隶属关系。

## 工作方式

ACP 不会自己动手压缩。已经做完的旧内容积累多了，它会在下一次请求里附一段简短的**压缩提醒**（nudge），列出可以折叠的消息范围。主模型挑范围、调用 `compress`；**摘要模型**写摘要（不另外指定时就是主模型自己），每段范围换成对应的摘要块。原文仍留在会话里，随时可以取回。

模型能用两个工具：

- `compress`：把做完的消息范围折叠成摘要块。
- `acp_context`：包含 `decompress`、`search_context`、`acp_status`、`acp_cache` 和 `help`，用来取回原文或查找内容，例如 `{ "op": "search_context", "args": { "query": "authentication" } }`。

模型传错参数时，校验前会先自动修正而不是报错：`args` 或 `content` 传成 JSON 字符串、op 的字段写在顶层、漏传 `op`（只按 `blockId` 这类无歧义字段推断），以及把范围数组写进 `summary` 而没给 `content`。

打开**空闲压缩**（Idle compact）后，你离开时、提示缓存还热着，ACP 也会把同样的压缩提醒发一次，回来时上下文已经变短。压缩提醒什么时候出现由[设置](#设置项)决定；另外上下文到窗口 95% 时，ACP 会兜底截断大的工具输出。

## 与上游 0.1.83 的主要区别

| | 上游 0.1.83 | 本分支 |
|---|---|---|
| 谁写摘要 | 主模型，通常是贵的那个 | 可指定**专用摘要模型**，比如便宜模型；主模型只负责选范围 |
| 压缩规则 | 每次压缩提醒都发给主模型（约 1,460 token；`promptPack: "lean"` 时约 720） | 只发给摘要模型，不再占用主模型的上下文；主模型的压缩提醒里只有一段约 220 token 的选范围说明\* |
| 摘要质量 | 通用压缩规则，只检查长度 | 另外：用户的要求和工具显示的内容分开记；待办分成用户目标、建议、未核实风险三类。调用失败或不合格的摘要不会折叠，这段留待下次再压缩 |
| 离开一阵再回来 | 第一条请求按无缓存价格重写整段长上下文 | **[空闲压缩](#空闲压缩idle-compact)**：缓存过期前给模型一次压缩机会，回来后发出的请求更短 |
| 修改设置 | 手动编辑 `acp.json` | **[`/acp-config`](#配置) 设置面板**：在 TUI 里选值，立即生效、不用重启；`acp.json` 照常可用 |
| 工具和常驻提示词 | 5 个上下文工具 + 3 个子代理工具，约 8,700 token（`promptPack: "lean"` 时约 4,900） | `compress` + `acp_context`，486 token（[对比](#上下文占用对比)）。常驻提示词只保留调用前必须知道的规则，其余说明随压缩提醒、报错和工具结果给出 |
| 系统提示词 | 返回整份系统提示词，在 Pi 1.x 上会丢掉之后加载的扩展追加的提示词 | 作为独立段落注入，其他扩展的内容保留 |
| 子代理委派、自动更新 | 内置 | 已移除。子代理请用专门的扩展，它们的会话仍由 ACP 管理 |
| bash 默认超时、工具输出上限 | 内置（`toolBashDefaultTimeout`、`toolOutputMaxBytes`） | 已移除：不属于上下文管理。Pi 自己会截断 bash/read/grep 的输出；超时交给 bash 工具或 bash 扩展 |

\* 按压缩提醒中规则文本的长度，以 `ceil(字符数 / 4)` 估算，不是计费 token。

<details>
<summary>本分支修好的上游小问题</summary>

- 紧急截断算出来了，却没有作用到实际请求上。
- 紧急截断可能截掉最新一条用户消息。
- token 计数沿用旧值，没有算上新增的消息。
- `compress` 调用里的思考内容没有计入 token。
- 并发保存状态可能失败（共用临时文件导致 `ENOENT`），释放会话锁时后来的调用者可能插队。
- 用 `/tree` 回到某个块的中间时，它的摘要可能带出当前分支还没走到的决定。
- 在 Windows 上，消息 ref 含 `|` 时解压到文件会失败。
- 测试会写进真实的 `~/.pi`。
- 请求失败后 Pi 会改为粗估整段未折叠的原始历史，ACP 把它当成下限，显示 120–170% 并误发紧急压缩提醒，直到下一次成功回复。
- 忽略了 Pi 的 `context_edit`，Pi 在失败后删掉的尝试会被重新发出。

详见 [CHANGELOG.md](CHANGELOG.md)、[MAINTENANCE.md](MAINTENANCE.md)。

</details>

## 上下文占用对比

只启用本扩展时，模型每次请求都会看到的初始化内容如下：

| 版本 | 工具与提示词构成 | 合计 |
| --- | --- | ---: |
| Lean `billion-context-pi-lean@0.2.3` | `compress` (231) + `acp_context` (87) + 提示词 (168) | **486** |
| 上游 `billion-context-pi@0.1.83`，开 `promptPack: "lean"` | `compress` (389) + `decompress` (271) + `search_context` (90) + `acp_status` (227) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + 提示词 (1,819) | **4,877** |
| 上游 `billion-context-pi@0.1.83` | `compress` (549) + `decompress` (546) + `search_context` (210) + `acp_status` (339) + `acp_cache` (204) + `acp_delegate` (1,452) + `acp_delegate_wait` (342) + `acp_delegate_cancel` (83) + 提示词 (4,945) | **8,670** |

比上游默认配置少 **8,184 token（94.4%）**，比上游开 `lean` 提示词包少 4,391 token（90.0%）。其中 3 个 `acp_delegate*` 工具（共 1,877 token）属于子代理委派，本分支已删除这项功能；不算它们的话，分别少 92.8% 和 83.8%。

压缩提醒不在上表内，只在上下文快满时出现。配置专用摘要模型后，每次压缩提醒里的规则从约 1,460 token 降到约 220（[配置方法](#设置项)）。

在 Pi 1.3.0 上用 `npm run measure` 测得，每个版本各用一个临时进程，工作目录和配置都是空的。不计内置工具、skill、上下文文件、会话历史、用户消息、无关扩展、运行时 UI 和斜杠命令；计入 `before_agent_start` 追加的内容。Token 按 `ceil(字符数 / 4)` 固定估算，不是服务商分词器的计费数。

## 安装

```bash
pi install npm:billion-context-pi-lean
```

要固定版本，在末尾加 `@<版本号>`，版本见 [Releases](https://github.com/kunkun9527/billion-context-pi-lean/releases)。也可以从 git 安装：`pi install git:github.com/kunkun9527/billion-context-pi-lean`。

- 专用摘要模型需要 Pi 1.x 及以上。
- 不要和 `billion-context-pi` 或 `billion-context` 同时启用，工具和钩子会注册两次。
- 启用本扩展期间，Pi 自带的压缩会关闭。

## 配置

在 Pi 里输入 `/acp-config` 打开设置面板。上下键选设置项，Enter 或空格修改，Esc 关闭。改动立即生效，不用重启。

### 设置项

面板里按下表顺序列出，常用的在前。面板界面是英文的，括号里是中文意思。

| 设置 | 作用 | 默认 |
|---|---|---|
| Summary model（摘要模型） | 谁来写摘要。`main model`：主模型自己写。`session`：用当前模型单独调用一次，复用它的缓存前缀。也可以选 Pi 能用的任意模型（按 Enter 列出，可打字过滤），比如便宜的模型。这个模型调用失败时，这段不压缩，下次再试。 | `main model` |
| Idle compact（空闲压缩） | 你离开时，趁提示缓存还没过期压缩一次（[工作方式](#空闲压缩idle-compact)）。 | `off` |
| Idle minutes（空闲分钟数） | 会话空闲多久后才压缩。设得比所用模型的缓存时长略短：30 分钟缓存就用 29。 | 29 |
| Context threshold（上下文阈值） | 上下文占到模型窗口的这个比例以上，压缩提醒不再等 Nudge interval：只要能腾出的空间达到 Minimum benefit 就提醒。调低让上下文常保小；调高允许它更满。它不是硬上限。 | 75% |
| Nudge interval（提醒间隔） | 上下文没到 Context threshold 时，要等可压缩的旧内容攒到大约这么多 token 才提醒一次。调大：提醒少，每次压得多；调小：频繁小压缩，上下文更精简。 | 50K |
| Minimum benefit（最小收益） | 能腾出的空间少于这个值时不提醒，也不做空闲压缩：只为几千 token 去重写、打断缓存不划算。 | 5K 与窗口 1% 中较大者 |
| Debug log（调试日志） | 在 `~/.pi/acp.log` 里额外记录详细事件，排查问题用。错误和主要事件始终会记。 | `off` |

Context threshold、Nudge interval、Minimum benefit 跟模型的窗口和价格有关，所以面板只为**当前模型**设置它们；要改别的模型，先切换过去。选 `inherit`（继承）会去掉这个模型自己的值，改用 `acp.json` 里 provider 级或全局的值，都没有就用默认值。

不论这些怎么设，上下文到窗口 95% 时，ACP 都会兜底截断大的工具输出。

### 空闲压缩（Idle compact）

长会话里离开到提示缓存过期再回来，第一条请求会按无缓存价格重写整段上下文。打开 Idle compact 后，会话空闲达到 Idle minutes 时，ACP 启动一轮，把压缩提醒交给主模型，由它决定要不要压缩。

- “有活动”指真实的模型请求：你发的消息，也包括子代理唤醒会话，所以后台长任务不会被当成空闲。
- 每段空闲最多一轮。能腾出的空间不到 Minimum benefit、不在 TUI 或 RPC 模式、定时器晚触发超过 1 分钟（电脑睡眠）时跳过。
- 这一轮里只能用 ACP 工具。期间你输入消息或子代理结果到达，它就变成普通轮次。
- Idle minutes 对所有模型生效。缓存更短（比如 5 分钟）时，这一轮本身要按无缓存价读一次长上下文。

### 手动编辑 acp.json

面板把设置存进 `~/.pi/acp.json`，文件里的其它设置原样保留。只有面板做不到的事才需要自己改文件：

- **按项目设置**：`<项目>/.pi/acp.json` 优先于全局文件。面板显示实际生效的值，被项目文件覆盖时会提示。
- **按 provider 设置**：三项压缩时机设置除了按模型，也能对整个 provider 或全局设置（[写法](CONFIGURATION.zh-CN.md#compressproviders--按-provider--按-model-覆盖)）。
- **面板没有的选项**，比如 `compress.emergencyThresholdPercent`。完整列表见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md)，以下几项除外：`autoUpdate` 和 `ACP_AUTO_UPDATE` 已移除（用 `pi install` 更新）；已移除的委派配置（`delegate.*`、`displayUsage`、`delegatePrompt`）会被忽略；`promptSections.*` 会被忽略并提示一次，因为本分支注入自己的提示词。

面板设置对应的键：Summary model 是 `compressionModelId`，Idle compact 是 `idleCompact.enabled`，Idle minutes 是 `idleCompact.idleMinutes`，Debug log 是 `debug`。

`/acp compact <provider/model>` 也能在命令行设置摘要模型（`/acp compact` 查看当前设置，`reset` 改回主模型）。

## 开发

```bash
npm ci
npm run check   # 类型检查、测试、构建和外壳检查
npm run measure # 对比上游的工具和提示词占用（需要同级目录 ../my-lean-pi-setup）
```

Pi 安装 git 包时不会构建，所以 `dist/` 要提交，并和源码改动放在同一个提交里。维护说明见 [MAINTENANCE.md](MAINTENANCE.md)。

## 协议与致谢

MIT。基于 ranxianglei 及贡献者的 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)（MIT），包括上游 PR #241 的专用摘要模型。

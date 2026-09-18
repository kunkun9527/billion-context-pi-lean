# billion-context-pi-lean-Notsub

[English](README.md)

基于 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) 的精简封装。在完整保留上下文压缩引擎的同时，大幅剔除系统提示词与工具 Schema 中的冗余文本，显著降低上下文初始开销。

## 核心特性

* 完整上下文引擎：保留上游的对话历史压缩、分层摘要、主动提示（Nudge）、溢出恢复、重试机制与工具保护能力。
* 优化工具布局：高频使用的 `compress` 工具直接对外暴露，其余 `decompress`、`search_context` 与 `acp_status` 操作整合为按需调用的 `acp_context` 入口。
* 独立压缩模型池：可通过 `/acp-models` 配置一组按顺位排序的“摘要模型”。`compress` 只需选择已消费的历史范围，摘要由模型池根据真实历史生成，失败时逐级降级并在必要时回退当前主模型。
* 纯粹专注：主动移除了内置的 Subagent（子代理）功能 —— 包括 `acp_delegate*` 系列工具、`/acp-subagents` 命令及 delegate 用量噪音行 —— 同时去除了自动更新逻辑；如需多 Agent 协作，建议搭配独立的 Subagent 扩展使用。上游依赖版本锁定为 `billion-context-pi@0.1.52`，确保运行稳定可靠。

## 精简优化成效

在关闭 Delegation 的情况下，与原版 `billion-context-pi@0.1.52` 本地对比：固定的 ACP 系统提示词与工具元数据字符量从约 22,645 字符大幅缩减至 2,859 字符，常驻静态文本减少约 87%。实际 Token 节省情况会因模型分词器及 Prompt 缓存机制而略有差异。

## 安装

```bash
pi install git:github.com/miko-mepro/billion-context-pi-lean-Notsub
```

也可以通过本地克隆进行安装：

```bash
git clone https://github.com/miko-mepro/billion-context-pi-lean-Notsub.git
cd billion-context-pi-lean-Notsub
npm install
pi install ./
```

请勿与其它 `billion-context-pi` 扩展同时加载，以防重复注册 ACP 工具与生命周期 Hooks。

## 使用方法

模型可见工具包括：

```text
compress
acp_context
```

`acp_context` 支持 `decompress`、`search_context`、`acp_status` 和 `help`。

```json
{
  "op": "search_context",
  "args": {
    "query": "authentication"
  }
}
```

仅在确需查看完整上游 Schema 时调用 `help`。

### 压缩模型池（`/acp-models`）

在交互式 Pi 中运行 `/acp-models` 配置摘要模型：

* 界面为单面板：外边框与标题、状态栏（可用 / 已启用 / 未保存 / 已保留的不可用配置数量）、固定搜索栏、分区列表、反馈区，以及随终端宽度自动折行的键位提示。列表常规最多 12 行并按终端高度收缩，标题、提示与反馈优先保留；窗口过小时只显示一句放大提示，`Esc` 仍可退出。
* 只展示“注册表中存在且已配置认证”的模型，格式为 `模型 [provider]`。已保存但当前不可用的模型（注册表缺失 / 未配置认证 / 认证判定异常）不再以标记形式出现在列表中，而是直接隐藏：它们无法被光标选中，但会保留在配置文件里，认证恢复后按原顺位重新出现；状态栏会提示当前保留了几个这样的条目。
* 键位：`空格` 选中当前项进入排序模式（再按一次取消；池外模型会先提示按回车启用），`↑`/`↓` 浏览或在压缩池内调整顺位（不会跨过分区，移动后光标跟随该模型），`回车` 启用或停用，输入字符按模型名与 provider 搜索（搜索状态下禁止排序，输入即退出排序模式），`Backspace`/`Ctrl+U` 删除或清空搜索，`Ctrl+S` 保存，`Esc` 放弃。启用的模型始终排在列表顶部，新启用的模型追加到队列末尾。
* 保存直接在界面内完成：`Ctrl+S` 后显示“保存中”，期间忽略所有按键（包括 `Esc`），只有原子替换成功才会关闭界面；写入失败会留在原界面并保留搜索、光标与草稿，可重试或按 `Esc` 放弃。
* 配置保存在 Pi 的 agent 配置目录（可通过 `PI_CODING_AGENT_DIR` 覆盖）中的 `compress-models.json`，仅记录 `{ provider, modelId }`，不写入任何密钥；保存使用“临时文件 + 原子替换”，配置损坏时会提示且不会被覆盖。文件内容始终为：已启用队列在前，被保留的不可用条目按其原有相对顺序追加在后。

执行 `compress` 时：

* `summary` 现在可以省略；若仍传入，只会作为草稿提示，最终摘要始终由模型池根据真实历史生成。
* 模型池按顺位逐个尝试，全部不可用或失败后回退到调用开始时的主模型；空池直接使用主模型。
* 单个候选请求默认超时 120 秒；用户取消立即停止，不会当作模型故障继续降级；候选上下文容量不足、返回空摘要或超长摘要都会降级到下一个候选。
* 所有范围必须全部成功才会提交一次压缩；任何失败或取消都不会留下部分压缩状态。模型池标签只显示在工具界面中，摘要正文、原文副本与降级日志不会重复进入模型上下文。

## 初始化上下文占用对比

单独启用本扩展时，注入到模型初始上下文中的 Token 占用实测如下：

| 项目 | Lean 精简版 | 原版 `billion-context-pi@0.1.52` |
| --- | ---: | ---: |
| `compress` | 238 | 549 |
| 上下文检索与操作 | `acp_context`: 111 | `decompress` + `search_context` + `acp_status`: 1,095 |
| 系统提示词增量 | 424 | 4,417 |
| **合计** | **773** | **6,061** |

相比固定版本的上游扩展，初始开销减少了 **5,288 tokens（87.2%）**。

测试环境为 Pi 0.84.4 与 `pi-context-view@0.4.3` 独立会话，排除了 Pi 内置工具、Skills、上下文文件与无关扩展。Context View 按 `ceil(字符数 / 4)` 估算。未计入不会发送给模型的纯运行时 UI 与 Slash 命令。

## 本地开发

```bash
npm ci
npm run check
```

## 开源协议与致谢

MIT 协议。本包装层基于采用 MIT 协议的 [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)。
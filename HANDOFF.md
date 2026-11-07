# 当前状态

本次任务：修复重折叠日志恢复，并完成共享计量、会话生命周期清理、出站改写顺序三项整理。实现与维护说明见 [MAINTENANCE.md](MAINTENANCE.md)；用户可见变更见 [CHANGELOG.md](CHANGELOG.md) 的 v0.3.0。用户已授权发布 npm 与 GitHub Release，明确确认版本为 0.3.0（不是 3.0.0）；发布范围包括此前未发布的论文启发提交 `0b4d80a` 及分析脚本归档 `4b9bc2c`。

- 基准提交：`4b9bc2c24a857c18832cbfbe5d198a1a850f1512`。
- 交付版本为 0.3.0，包与锁文件同步，源码与重建的 `dist/` 同一发布提交。发布状态以 [GitHub v0.3.0](https://github.com/kunkun9527/billion-context-pi-lean/releases/tag/v0.3.0) 与 `npm view billion-context-pi-lean@0.3.0 version dist.integrity` 的查询结果为准。
- 保留 Lean 外壳及工具面；未改提示词预算，未生成 HTML。

## 已验证

- 恢复链路：先复现单独/混合重折叠的摘要恢复问题，再修复成功范围记录与 inline restore 时序回放；补充原生和 `acp_context` 日志两种形态。最终相关命令：
  `node --import tsx --import ./tests/support/isolate-env.ts --test tests/compress-model.test.ts tests/state-rebuild.test.ts tests/decompress-tool.test.ts tests/compress-tool.test.ts`
  结果：84 通过、0 失败；`npm run typecheck` 通过。
- 共享计量：9 个相关测试文件共 144 项通过。覆盖学习窗口先于输出预留、thinking 固定开销，以及展示/预演不消费一次性 overflow 状态；probe 克隆状态并禁用 clip replay。
- 生命周期及出站：8 个相关测试文件共 98 项通过；覆盖会话隔离、重复释放、进行中的锁，以及临时 nudge 不关闭未完成 compress 轮次。

## 旧版行为审计与新增回归

- 对照基准源码运行 5 组固定时钟/相同配置的真实 context 输入：普通消息、未完成 compress、thinking-only 退化尾部、自定义消息、图片；出站消息精确一致，原日志未改写。其余高风险顺序见 `tests/outbound.test.ts`。
- Spec 审查返回 1 个中等问题：跨块 refold 的成功范围遗漏。复现时确认：纯相邻块 refold 使用调用方摘要；混合批次的新范围超过 `minCompressRange` 后可成功更新旧块并新增块，但恢复记录原本只有新块（1 条而非 3 条）。现按实际变化的块记录，保留旧版 live 行为；原生/Lean 包装及单独/混合回放均通过。跳过的重叠范围也不再误记。
- 本轮新增 14 项回归：上述相邻块/混合恢复、重复重叠范围、fresh/stale/context_edit/aborted/无 anchor 的用量信任、Anthropic 预留豁免、展示后首次发送消费 overflow、custom user/完整摘要恢复、启动保留 prefix/学习窗口与关闭不清空保存状态。
- 定向命令：`npm run typecheck`；`node --import tsx --import ./tests/support/isolate-env.ts --test tests/tokens.test.ts tests/outbound.test.ts tests/runtime-lifecycle.test.ts tests/floor-stale.test.ts tests/compress-model.test.ts tests/state-rebuild.test.ts`。结果：类型检查通过、98 项测试通过、0 失败；`git diff --check` 通过。

## 最终验证与审查

- 0.3.0 发布前再次运行 `npm run check && git diff --check`：771 项源码测试、27 项 Lean 测试均通过，类型检查与构建通过（日志 `M:/Temp/pi-bg-lean/a23ba5a0/output.log`）。实际 npm tarball 的 55 个文件逐一与已验证工作区比对，包含 Lean 入口、bundle、声明及 schema；SHA-512 与打包元数据一致。
- 本轮最终 `npm run check && git diff --check` 通过：771 项源码测试、27 项 Lean 测试，均 0 失败、0 跳过；源码/Lean 类型检查与 `dist/` 构建通过。日志 `M:/Temp/pi-bg-lean/472303fe/output.log`。自动 Spec 审查已完成，唯一发现经复现后已修复；没有新增对外工具或提示词。

## 限制与未验证

- 旧日志若从未记录专用模型写出的重折叠摘要，不能凭空补回缺失文本；本次保证新记录可以恢复。
- 没有在用户真实会话里主动删除 sidecar 或调用付费模型；恢复回归采用隔离临时会话与假模型。
- 文档核对：`AGENTS.md` 原写专用调用失败即用回退摘要，与代码及维护说明不符，已修正文档；`src/index.ts` 的 `DEDICATED_CALLER_RULES` 和 `src/compress-tool.ts` 的部分旧提示/注释仍称失败回退，本轮按“不改工具面与提示词预算”的范围保留。实际失败不折叠、配置不兼容时回退的契约有既有测试保护。

## 建议技能

- `code-review`：需要额外 Standards 审查时使用；本任务自动仅审 Spec。
- `handoff`：继续任务后按本文件现有结构更新状态。

## 单一步骤

用户更新到 0.3.0 后，在测试会话重载扩展并运行 `/acp` 做真实宿主冒烟；工具注册及计量面板无异常即通过。线上发布收据以 GitHub Release 和 npm 元数据为准。

// billion-context-pi-lean-Notsub: keep compress direct and route low-frequency ACP tools locally.
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAcpExtension } from "billion-context-pi";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
// 压缩模型顺位池：配置、/acp-models 界面、只读历史快照与摘要降级编排。
import {
  DEFAULT_SUMMARY_MAX_CHARS,
  PoolEditor,
  buildPoolPlan,
  clearCompressModelsDraft,
  compressModelsConfigPath,
  createHistorySnapshot,
  createPoolEditorComponent,
  emptyCompressModelsConfig,
  extractRangeText,
  formatCompressModelLabel,
  generateRangeSummary,
  loadCompressModelsConfig,
  readAcpStateSnapshot,
  rememberCompressModelsDraft,
  resolvePoolCandidates,
  saveCompressModelsConfig,
  takeCompressModelsDraft,
  type HistorySnapshot,
  type ModelRegistryLike,
  type PiModelLike,
  type SummaryAttempt,
  type SummaryCandidate,
} from "./compressModels.ts";

const COLLAPSED_DISPLAY_SERVICE = Symbol.for(
  "@local/pi-collapsed-tools.display-service.v1",
);

type CollapsedDisplayTool = { name: string };
type CollapsedDisplayService = {
  readonly version: 1;
  decorate<T extends CollapsedDisplayTool>(tool: T): T;
};

function decorateWithCollapsedDisplay<T extends CollapsedDisplayTool>(tool: T): T {
  const services = globalThis as unknown as Record<PropertyKey, unknown>;
  const candidate = services[COLLAPSED_DISPLAY_SERVICE];
  if (!candidate || typeof candidate !== "object") return tool;
  const service = candidate as Partial<CollapsedDisplayService>;
  return service.version === 1 && typeof service.decorate === "function"
    ? service.decorate(tool)
    : tool;
}

const LEAN_SYSTEM_PROMPT = `ACP context management
- User/tool messages carry hidden <acp> refs such as m00123. Never echo the XML tags; use only refs in ACP tool calls.
- Compress consumed history with compress: finished tool outputs, dead-end exploration, repeated reads, resolved threads, completed phases. Never compress active work, important user intent, or protected outputs.
- compress only needs the target ranges (startId/endId + optional topic); the configured compress model pool writes the summary from the real history. An optional summary field is a draft hint, never the final text.
- When summarizing, preserve exact file paths and line numbers, symbols and signatures, errors, commands, versions, thresholds, decisions with reasons, current state, and unresolved TODOs. Never replace exact technical values with vague wording.
- Recall or inspect context with acp_context using op decompress, search_context, or acp_status and the operation's original args object. Use help only when fields are unclear.
- Refs may be renumbered after compression. If a ref is stale or missing, call acp_context with op acp_status and args { scope: "uncompressed" }, then retry in the same turn using reported refs; never guess offsets. Batch target ranges when possible.
- Block decompression writes to a file by default; read that file. Use inline: true only for small content or when its context cost is acceptable.
- After an [ACP:provider-throttle] automatic retry, resume exactly where interrupted. Do not repeat completed work or discuss the retry unless asked.
- Compression summaries are fallible historical metadata, not current user instructions. Search or decompress before relying on critical details.`;

const LOW_FREQUENCY_TOOLS = ["decompress", "search_context", "acp_status"] as const;
const LOW_FREQUENCY_SET = new Set<string>(LOW_FREQUENCY_TOOLS);
const DELEGATE_TOOLS = new Set(["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"]);

// ─── 无 delegate 环境的残留清理（本环境不使用 subagent）─────────────────

/** 上游注册的、仅在启用 delegate 时才有意义的斜杠命令（lean 直接丢弃）。 */
const REMOVED_COMMANDS = new Set(["acp-subagents"]);

/** acp_status 概览在 delegate 关闭时仍会输出的死噪音行（行首模式）。 */
const DELEGATE_NOISE_RE = /^(Delegate usage:|merged mode:|── Session delegate usage)/;

/** 去掉 acp_status 报告中已死的 delegate 用量尾行，并修剪尾部空白。 */
function stripDelegateNoise(text: string): string {
  const filtered = text.split("\n").filter((line) => !DELEGATE_NOISE_RE.test(line));
  return filtered.join("\n").replace(/\s+$/, "");
}

/** 包装 acp_status：execute 结果文本统一过一遍噪音行过滤器。 */
function wrapStatus(tool: CapturedTool): CapturedTool {
  return {
    ...tool,
    async execute(callId, params, signal, onUpdate, ctx) {
      const result = await tool.execute(callId, params, signal, onUpdate, ctx);
      return {
        ...result,
        content: Array.isArray(result.content)
          ? result.content.map((part) =>
              part && part.type === "text" && typeof part.text === "string"
                ? { ...part, text: stripDelegateNoise(part.text) }
                : part,
            )
          : result.content,
      };
    },
  };
}

type Operation = (typeof LOW_FREQUENCY_TOOLS)[number];
type FacadeOperation = Operation | "help";
type CapturedTool = ToolDefinition<any, any, any>;
type UpstreamExtension = (pi: ExtensionAPI) => void;
type FacadeArgs = Record<string, unknown>;

const FACADE_PARAMETERS = Type.Object({
  op: Type.Unsafe<FacadeOperation>({
    type: "string",
    enum: [...LOW_FREQUENCY_TOOLS, "help"],
  }),
  args: Type.Optional(Type.Unsafe<FacadeArgs>({
    type: "object",
    additionalProperties: true,
  })),
});

const COMPRESS_FIELD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  startId: "Inclusive first mNNNNN or bN ref.",
  endId: "Inclusive last mNNNNN or bN ref.",
  summary: "Optional draft hint; the compress model pool writes the final summary.",
  topic: "Short label; a per-range label overrides the top-level fallback.",
  summaryMaxChars: "Optional summary length limit override.",
};

function compactCompressSchemaDescriptions(
  value: unknown,
  propertyName?: string,
  seen = new Set<object>(),
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  delete record.description;
  const concise = propertyName ? COMPRESS_FIELD_DESCRIPTIONS[propertyName] : undefined;
  if (concise) record.description = concise;

  for (const [key, child] of Object.entries(record)) {
    if (key === "properties" && child !== null && typeof child === "object") {
      for (const [name, schema] of Object.entries(child as Record<string, unknown>)) {
        compactCompressSchemaDescriptions(schema, name, seen);
      }
      continue;
    }
    compactCompressSchemaDescriptions(child, undefined, seen);
  }
}

/**
 * 把 compress 暴露 schema 中的 summary 从必填改为可选：
 * 主模型只负责选择已消费的范围，摘要由压缩模型池根据真实历史生成。
 * 只影响模型看到的 schema，上游 execute 仍会收到我们补全后的 summary。
 */
function relaxCompressSummaryRequirement(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.required) && record.required.includes("summary")) {
    const properties = record.properties;
    if (properties && typeof properties === "object" && "summary" in (properties as Record<string, unknown>)) {
      record.required = record.required.filter((name) => name !== "summary");
    }
  }
  for (const child of Object.values(record)) relaxCompressSummaryRequirement(child, seen);
}

function appendSystemPrompt(base: unknown): string {
  const text = Array.isArray(base) ? base.join("\n") : typeof base === "string" ? base : "";
  return `${text}\n\n${LEAN_SYSTEM_PROMPT}`;
}

function rewriteText(text: string): string {
  return text
    .replace(
      /\b(search_context|decompress|acp_status)\((\{[^\r\n]*\})\)/g,
      (_, op: string, args: string) => `acp_context({ op: "${op}", args: ${args} })`,
    )
    .replace(
      /\brun acp_status\b/gi,
      'call acp_context({ op: "acp_status", args: {} })',
    )
    .replace(
      /\buse search_context or decompress\b/gi,
      'use acp_context with op "search_context" or "decompress"',
    )
    .replace(
      /\buse search_context\b/gi,
      'use acp_context with op "search_context"',
    );
}

function rewriteModelFacingText(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return rewriteText(value);
  if (value === null || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached) return cached;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(rewriteModelFacingText(item, seen));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = rewriteModelFacingText(item, seen);
  }
  return copy;
}

function validationError(tool: CapturedTool, args: FacadeArgs): string | undefined {
  if (!tool.parameters || Check(tool.parameters, args)) return undefined;
  const first = Errors(tool.parameters, args)[0];
  const location = first?.instancePath || "/";
  const reason = first?.message || "arguments do not match the upstream schema";
  return `${location}: ${reason}`;
}

function helpResult(args: FacadeArgs, tools: Map<string, CapturedTool>) {
  const requested = typeof args.tool === "string" ? args.tool : "";
  if (!requested) {
    return {
      content: [{
        type: "text" as const,
        text: "Operations: search_context({query, limit?}), decompress({blockId, full?, toFile?, inline?}), acp_status({scope?, view?, tool?, sort?, limit?}). For a full schema, use op help with args {tool: operationName}.",
      }],
      details: { operation: "help" },
    };
  }
  if (!LOW_FREQUENCY_SET.has(requested)) {
    throw new Error(`acp_context help operation is unknown: ${requested}`);
  }
  const tool = tools.get(requested);
  if (!tool) throw new Error(`acp_context could not find upstream tool: ${requested}`);
  return {
    content: [{
      type: "text" as const,
      text: [
        requested,
        tool.description,
        "Pass args matching this schema:",
        JSON.stringify(tool.parameters, null, 2),
      ].filter(Boolean).join("\n\n"),
    }],
    details: { operation: requested },
  };
}

// ─── 压缩模型池接入（/acp-models + compress 包装层）─────────────────────

type PoolSnapshotEntry = { snapshot: HistorySnapshot; model?: PiModelLike };

/** 每个扩展实例一份的会话快照表：只读保存 ACP 实际渲染进上下文的消息。 */
type PoolRuntime = {
  snapshotFor(sessionId: string): PoolSnapshotEntry | undefined;
  setSnapshot(sessionId: string, entry: PoolSnapshotEntry): void;
};

function createPoolRuntime(): PoolRuntime {
  const snapshots = new Map<string, PoolSnapshotEntry>();
  return {
    snapshotFor: (sessionId) => snapshots.get(sessionId),
    setSnapshot: (sessionId, entry) => {
      snapshots.set(sessionId, entry);
    },
  };
}

/** 捕获 context 变换的输出：这就是模型本轮真正看到的 ACP 上下文。 */
function captureHistorySnapshot(pool: PoolRuntime, ctx: any, messages: unknown): void {
  if (!Array.isArray(messages)) return;
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  pool.setSnapshot(sessionId, { snapshot: createHistorySnapshot(messages), model: ctx?.model ?? undefined });
}

/** 模型可见的简短回执（不包含内部对话、原文副本或降级日志）。 */
function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

type CompressRangePlan = { startId: string; endId: string; topic?: string; hint?: string };

/** 解析 compress 参数：只要求 startId/endId；summary 降级为草稿提示（兼容旧调用）。 */
function parseCompressRanges(params: any):
  | { ok: true; ranges: CompressRangePlan[]; topic?: string; summaryMaxChars?: number }
  | { ok: false; reason: string } {
  const raw = params?.content;
  let items: unknown[] = [];
  if (typeof raw === "string") {
    // 非严格工具提供者可能把数组序列化成字符串（与上游保持同样的兼容）。
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed;
      else return { ok: false, reason: "content 字符串不是 JSON 数组" };
    } catch {
      return { ok: false, reason: "content 字符串不是合法 JSON" };
    }
  } else if (Array.isArray(raw)) {
    items = raw;
  } else {
    return { ok: false, reason: "缺少 content 范围数组" };
  }

  const ranges: CompressRangePlan[] = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") return { ok: false, reason: `content[${index}] 不是对象` };
    const entry = item as Record<string, unknown>;
    const startId = typeof entry.startId === "string" ? entry.startId.trim() : "";
    const endId = typeof entry.endId === "string" ? entry.endId.trim() : "";
    if (!startId || !endId) return { ok: false, reason: `content[${index}] 缺少 startId/endId` };
    ranges.push({
      startId,
      endId,
      topic: typeof entry.topic === "string" && entry.topic.trim() ? entry.topic.trim() : undefined,
      hint: typeof entry.summary === "string" && entry.summary.trim() ? entry.summary.trim() : undefined,
    });
  }
  if (ranges.length === 0) return { ok: false, reason: "content 为空" };
  return {
    ok: true,
    ranges,
    topic: typeof params?.topic === "string" && params.topic.trim() ? params.topic.trim() : undefined,
    summaryMaxChars: typeof params?.summaryMaxChars === "number" ? params.summaryMaxChars : undefined,
  };
}

/** 工具界面上的「模型池」标签：只用 details 渲染，不进入模型上下文。 */
function compressModelsTag(details: unknown): string | undefined {
  const info = (details as { compressModels?: unknown } | undefined)?.compressModels;
  if (!info || typeof info !== "object") return undefined;
  const record = info as Record<string, unknown>;
  const used = Array.isArray(record.used) ? record.used.filter((v): v is string => typeof v === "string") : [];
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  const failed = attempts.filter(
    (item) => item && typeof item === "object" && (item as SummaryAttempt).ok === false,
  );
  const label = used.length > 0 ? [...new Set(used)].join(", ") : "未使用（无候选）";
  return failed.length > 0 ? `模型池：${label} · 降级 ${failed.length} 次` : `模型池：${label}`;
}

/** 上游没有 renderResult 时的兑底渲染：折叠时只显示首行，展开时保留全部行。 */
function defaultCompressLines(
  result: { content?: unknown } | undefined,
  width: number,
  expanded: boolean,
): string[] {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  const text = texts.join("\n").replace(/\s+$/, "");
  const lines = text.length > 0 ? text.split("\n") : ["compress"];
  const shown = expanded ? lines : lines.slice(0, 1);
  return shown.map((line) => (line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line));
}

/** 包装 compress 渲染：保留上游渲染（如有），追加一行模型池标签。 */
function wrapCompressRender(tool: CapturedTool): CapturedTool["renderResult"] {
  const upstream = tool.renderResult;
  return (result, options, theme, context) => {
    const base = upstream?.(result, options, theme, context);
    const tag = compressModelsTag(result?.details);
    const expanded = options?.expanded !== false;
    return {
      render: (width: number) => {
        const lines = base ? base.render(width) : defaultCompressLines(result, width, expanded);
        return tag ? [...lines, `  ${tag}`] : lines;
      },
      invalidate: () => base?.invalidate?.(),
    };
  };
}

/** compress 主流程：主模型选范围 → 快照取原文 → 顺位池生成摘要 → 调用原引擎。 */
async function runCompressWithModelPool(
  tool: CapturedTool,
  pool: PoolRuntime,
  callId: string,
  params: any,
  signal: AbortSignal | undefined,
  onUpdate: ((update: unknown) => void) | undefined,
  ctx: any,
): Promise<{ content: unknown; details?: unknown }> {
  const parsed = parseCompressRanges(params);
  if (!parsed.ok) return textResult(`compress 未执行：${parsed.reason}。(历史未修改)`);

  const sessionId = ctx?.sessionManager?.getSessionId?.();
  const entry = typeof sessionId === "string" ? pool.snapshotFor(sessionId) : undefined;
  if (!entry) {
    return textResult("compress 未执行：本轮还没有 ACP 上下文快照，请在同一轮稍后重试。(历史未修改)");
  }
  const snapshot = entry.snapshot;

  const registry = ctx?.modelRegistry as ModelRegistryLike | undefined;
  if (!registry || typeof registry.complete !== "function") {
    return textResult("compress 未执行：模型注册表不可用。(历史未修改)");
  }

  // 每次调用开始固定配置、目标历史与主模型快照，避免中途变更导致调用链漂移。
  const loaded = await loadCompressModelsConfig();
  const config = loaded.status === "corrupt" ? emptyCompressModelsConfig() : loaded.config;
  const candidates: SummaryCandidate[] = resolvePoolCandidates(config, registry).map((candidate) => ({
    ref: candidate.ref,
    label: candidate.label,
    model: candidate.model,
  }));

  const mainModel = (entry.model ?? ctx?.model) as PiModelLike | undefined;
  const fallback: SummaryCandidate | undefined =
    mainModel && typeof mainModel.id === "string" && typeof mainModel.provider === "string"
      ? {
          ref: { provider: mainModel.provider, modelId: mainModel.id },
          label: formatCompressModelLabel(mainModel.provider, mainModel.id),
          model: mainModel,
        }
      : undefined;

  const maxChars =
    parsed.summaryMaxChars && parsed.summaryMaxChars > 0 ? parsed.summaryMaxChars : DEFAULT_SUMMARY_MAX_CHARS;

  // 只读读取 <session>.acp.json：bN 的当前摘要层级 + ref/rawId 权威映射。
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  const state =
    typeof sessionFile === "string" && sessionFile.length > 0
      ? await readAcpStateSnapshot(`${sessionFile}.acp.json`)
      : { blocks: new Map(), refToRawId: new Map(), rawIdToRef: new Map() };

  const summaries: string[] = [];
  const used: string[] = [];
  const attempts: SummaryAttempt[] = [];
  const poolNote =
    candidates.length === 0
      ? "（模型池为空，使用主模型）"
      : `（顺位：${candidates.map((candidate) => candidate.label).join(" → ")}）`;

  // 批量范围串行生成：任一范围失败都不提交，避免部分压缩。
  for (const range of parsed.ranges) {
    if (signal?.aborted) return textResult("compress 已取消。(历史未修改)");
    const extracted = extractRangeText(snapshot, range.startId, range.endId, {
      blocks: state.blocks,
      rawIdToRef: state.rawIdToRef,
    });
    if (!extracted.ok) return textResult(`compress 未执行：${extracted.reason}。(历史未修改)`);

    const outcome = await generateRangeSummary({
      range: {
        startId: range.startId,
        endId: range.endId,
        topic: range.topic ?? parsed.topic,
        hint: range.hint,
      },
      body: extracted.text,
      maxChars,
      candidates,
      fallback,
      complete: (model, context, options) => registry.complete(model, context, options),
      signal,
    });
    attempts.push(...outcome.attempts);
    if (!outcome.ok) {
      const reason = outcome.cancelled ? "已取消" : `摘要生成失败：${outcome.reason}`;
      return textResult(`compress ${reason}${poolNote}。(历史未修改)`, { compressModels: { attempts } });
    }
    summaries.push(outcome.summary);
    used.push(outcome.used);
  }

  // 提交前再次确认快照未被替换（分支切换或并发压缩会替换快照对象）。
  if (typeof sessionId === "string" && pool.snapshotFor(sessionId) !== entry) {
    return textResult("compress 已放弃：会话历史在摘要生成期间发生变化，请重试。(历史未修改)");
  }

  const filled = {
    ...(params as Record<string, unknown>),
    content: parsed.ranges.map((range, index) => ({
      startId: range.startId,
      endId: range.endId,
      ...(range.topic ?? parsed.topic ? { topic: range.topic ?? parsed.topic } : {}),
      summary: summaries[index],
    })),
  };
  const result = (await tool.execute(callId, filled as any, signal as any, onUpdate as any, ctx)) as {
    content: unknown;
    details?: unknown;
  };
  const existingDetails =
    result?.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
  return {
    ...result,
    details: {
      ...existingDetails,
      compressModels: {
        used,
        attempts,
        pool: candidates.map((candidate) => candidate.label),
        fallback: fallback?.label,
      },
    },
  };
}

function wrapCompress(tool: CapturedTool, pool: PoolRuntime): CapturedTool {
  return {
    ...tool,
    description: "Compress consumed conversation ranges by refs; the configured compress model pool writes each summary.",
    promptSnippet: "",
    promptGuidelines: [],
    renderResult: wrapCompressRender(tool),
    async execute(callId, params, signal, onUpdate, ctx) {
      const forwardUpdate = onUpdate
        ? (update: unknown) => onUpdate(rewriteModelFacingText(update) as any)
        : undefined;
      const result = await runCompressWithModelPool(tool, pool, callId, params, signal, forwardUpdate, ctx);
      return rewriteModelFacingText(result) as any;
    },
  };
}

// ─── /acp-models 命令 ──────────────────────────────────────────────────

/**
 * 打开模型池配置界面：只列出已配置认证的模型（界面上不再出现 ✓/×/? 标记）。
 * 保存改在界面内异步执行：Ctrl+S 先写临时文件再原子替换，成功才关闭；
 * 失败则留在界面保留搜索/光标/草稿，可重试或 Esc 放弃（不写入、不重排原配置）；
 * 已保存但当前不可用的条目会原样保留在配置里（界面只在状态栏提示数量）。
 */
async function runAcpModelsCommand(ctx: any): Promise<void> {
  const ui = ctx?.ui;
  const registry = ctx?.modelRegistry as ModelRegistryLike | undefined;
  if (!ui || typeof ui.custom !== "function" || !registry || typeof registry.getAll !== "function") {
    ui?.notify?.("压缩模型池配置需要交互模式：请在交互式 Pi 中运行 /acp-models。", "warning");
    return;
  }

  const configFile = compressModelsConfigPath();
  const loaded = await loadCompressModelsConfig(configFile);
  if (loaded.status === "corrupt") {
    // 明确提示且不打开编辑器，避免把损坏文件覆盖成空配置。
    ui.notify(`[模型池] 配置损坏：${loaded.error}。请修复或删除 ${configFile} 后重试。`, "error");
    return;
  }

  const draft = takeCompressModelsDraft();
  if (loaded.status === "missing") {
    ui.notify(`[模型池] 未找到 ${configFile}：默认使用当前主模型，保存后会创建该文件。`, "info");
  }
  if (draft) {
    ui.notify("[模型池] 已恢复上次未保存的草稿。", "info");
  }

  let models: PiModelLike[] = [];
  try {
    models = registry.getAll() as PiModelLike[];
  } catch {
    models = [];
  }
  // 打开界面时取一次可用性快照，编辑过程中不后台刷新，避免认证状态变化造成列表跳动。
  const plan = buildPoolPlan(models, draft ?? loaded.config, (model) => {
    try {
      return Boolean(registry.hasConfiguredAuth(model));
    } catch {
      return false;
    }
  });
  const editor = new PoolEditor(plan.rows, plan.hidden);

  const choice = await ui.custom(
    (
      tui: { requestRender?: () => void; terminal?: { rows?: number } },
      theme: unknown,
      _keybindings: unknown,
      done: (result: "save" | "cancel") => void,
    ) =>
      createPoolEditorComponent({
        editor,
        theme: theme as {
          fg?: (color: string, text: string) => string;
          bg?: (color: string, text: string) => string;
        },
        requestRender: () => tui?.requestRender?.(),
        // 终端高度决定列表行数：标题/搜索/提示/反馈优先，列表最多 12 行。
        height: () => {
          const rows = tui?.terminal?.rows;
          return typeof rows === "number" && rows > 0 ? rows : 24;
        },
        // 界面内异步保存：只返回失败原因，关闭与提示由组件和本命令统一处理。
        onSave: async () => {
          const saved = await saveCompressModelsConfig(configFile, editor.toConfig());
          if (saved.ok) return null;
          // 写盘失败：草稿留在进程内，即使随后 Esc 退出也能在下次打开时恢复（不写入、不重排原配置）。
          rememberCompressModelsDraft(editor.toConfig());
          return saved.error;
        },
        onDone: done,
      }),
  );

  if (choice !== "save") {
    ui.notify("[模型池] 已放弃本次修改。", "info");
    return;
  }
  clearCompressModelsDraft(); // 已落盘，进程内草稿不再需要
  const enabledCount = editor.queue.length;
  const hiddenCount = editor.hidden.length;
  const kept = hiddenCount > 0 ? `；另保留 ${hiddenCount} 个当前不可用的配置。` : "。";
  ui.notify(
    enabledCount === 0
      ? `[模型池] 已清空顺位：摘要将由当前主模型生成${hiddenCount > 0 ? kept : "。"}`
      : `[模型池] 已保存 ${enabledCount} 个模型的顺位${kept}`,
    "info",
  );
}

function registerAcpModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("acp-models", {
    description: "Configure the compress model pool (ranked summary models)",
    handler: async (_args: string, ctx: any) => {
      await runAcpModelsCommand(ctx);
    },
  });
}

function facadeTool(tools: Map<string, CapturedTool>): ToolDefinition<typeof FACADE_PARAMETERS, unknown, unknown> {
  return {
    name: "acp_context",
    label: "ACP Context",
    description: 'Search, restore, or inspect ACP context. Pass original operation args; if unsure call { op: "help", args: { tool: "search_context" } } (replace tool as needed).',
    promptSnippet: "",
    promptGuidelines: [],
    parameters: FACADE_PARAMETERS,
    async execute(callId, params, signal, onUpdate, ctx) {
      if (params.op === "help") return helpResult(params.args ?? {}, tools);
      const tool = tools.get(params.op);
      if (!tool) throw new Error(`acp_context could not find upstream tool: ${params.op}`);
      const args = params.args ?? {};
      const invalid = validationError(tool, args);
      if (invalid) {
        throw new Error(
          `acp_context ${params.op} args invalid at ${invalid}. Use op help with args {"tool":"${params.op}"} for the full schema.`,
        );
      }
      const forwardUpdate = onUpdate
        ? (update: unknown) => onUpdate(rewriteModelFacingText(update) as any)
        : undefined;
      const result = await tool.execute(callId, args, signal, forwardUpdate, ctx);
      return rewriteModelFacingText(result) as any;
    },
  };
}

export function createLeanAcpExtension(
  upstream: UpstreamExtension = createAcpExtension({ delegate: false, autoUpdate: false }),
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    const tools = new Map<string, CapturedTool>();
    const pool = createPoolRuntime();
    let promptHookRegistered = false;
    const leanPi = new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerTool") {
          return (tool: CapturedTool) => {
            if (DELEGATE_TOOLS.has(tool.name)) return;
            if (LOW_FREQUENCY_SET.has(tool.name)) {
              // acp_status 在收进 facade 分发表前包上 delegate 噪音过滤：
              // 模型只能通过 acp_context 执行 Map 里的这份，包装即全局生效。
              tools.set(tool.name, tool.name === "acp_status" ? wrapStatus(tool) : tool);
              return;
            }
            if (tool.name === "compress") {
              compactCompressSchemaDescriptions(tool.parameters);
              // 主模型只负责选范围：把 summary 从必填改成可选，摘要交给模型池生成。
              relaxCompressSummaryRequirement(tool.parameters);
              target.registerTool(decorateWithCollapsedDisplay(wrapCompress(tool, pool)));
              return;
            }
            target.registerTool(decorateWithCollapsedDisplay(tool));
          };
        }
        if (property === "registerCommand") {
          // 拦截上游命令注册：丢弃仅服务于 delegate 的 /acp-subagents，
          // 其余命令（/acp、/acp-status 等）原样放行。
          return (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
            if (REMOVED_COMMANDS.has(name)) return;
            target.registerCommand(name, options);
          };
        }
        if (property === "on") {
          return (eventName: string, handler: (...args: unknown[]) => unknown) => {
            if (eventName === "context") {
              // 只读快照适配器：包一层上游 context 转换，捕获 ACP 真正渲染出的上下文
              // （含 <acp>mNNNNN</acp> 标签），供 compress 包装层复用同一套引用解析。
              return Reflect.apply(target.on, target, [eventName, async (event: unknown, ctx: unknown) => {
                const result = await handler(event, ctx);
                const messages = (result as { messages?: unknown } | undefined)?.messages
                  ?? (event as { messages?: unknown } | undefined)?.messages;
                captureHistorySnapshot(pool, ctx, messages);
                return result;
              }]);
            }
            if (eventName !== "before_agent_start") {
              return Reflect.apply(target.on, target, [eventName, handler]);
            }
            if (promptHookRegistered) return;
            promptHookRegistered = true;
            return Reflect.apply(target.on, target, [eventName, (event: { systemPrompt?: unknown }) => ({
              systemPrompt: appendSystemPrompt(event.systemPrompt),
            })]);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    upstream(leanPi);
    registerAcpModelsCommand(pi);
    pi.registerTool(decorateWithCollapsedDisplay(facadeTool(tools)));
  };
}

export default createLeanAcpExtension();

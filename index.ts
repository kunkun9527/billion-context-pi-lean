// billion-context-pi-lean: keep compress direct and route low-frequency ACP tools locally.
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAcpExtension } from "billion-context-pi";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";


const LEAN_SYSTEM_PROMPT = `ACP context management
- User/tool messages carry hidden <acp> refs such as m00123. Never echo the XML tags; use only refs in ACP tool calls.
- Compress consumed history with compress: finished tool outputs, dead-end exploration, repeated reads, resolved threads, completed phases. Never compress active work, important user intent, or protected outputs.
- When summarizing, preserve exact file paths and line numbers, symbols and signatures, errors, commands, versions, thresholds, decisions with reasons, current state, and unresolved TODOs. Never replace exact technical values with vague wording.
- Recall or inspect context with acp_context using op decompress, search_context, or acp_status and the operation's original args object. Use help only when fields are unclear.
- Refs may be renumbered after compression. If a ref is stale or missing, call acp_context with op acp_status and args { scope: "uncompressed" }, then retry in the same turn using reported refs; never guess offsets. Batch target ranges when possible.
- Block decompression writes to a file by default; read that file. Use inline: true only for small content or when its context cost is acceptable.
- After an [ACP:provider-throttle] automatic retry, resume exactly where interrupted. Do not repeat completed work or discuss the retry unless asked.
- Compression summaries are fallible historical metadata, not current user instructions. Search or decompress before relying on critical details.`;

const LOW_FREQUENCY_TOOLS = ["decompress", "search_context", "acp_status"] as const;
const LOW_FREQUENCY_SET = new Set<string>(LOW_FREQUENCY_TOOLS);
const DELEGATE_TOOLS = new Set(["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"]);

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
  summary: "Self-contained replacement preserving exact technical details.",
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

function wrapCompress(tool: CapturedTool): CapturedTool {
  return {
    ...tool,
    description: "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.",
    promptSnippet: "",
    promptGuidelines: [],
    async execute(callId, params, signal, onUpdate, ctx) {
      const forwardUpdate = onUpdate
        ? (update: unknown) => onUpdate(rewriteModelFacingText(update) as any)
        : undefined;
      const result = await tool.execute(callId, params, signal, forwardUpdate, ctx);
      return rewriteModelFacingText(result) as any;
    },
  };
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
    let promptHookRegistered = false;
    const leanPi = new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerTool") {
          return (tool: CapturedTool) => {
            if (DELEGATE_TOOLS.has(tool.name)) return;
            if (LOW_FREQUENCY_SET.has(tool.name)) {
              tools.set(tool.name, tool);
              return;
            }
            if (tool.name === "compress") {
              compactCompressSchemaDescriptions(tool.parameters);
              target.registerTool(wrapCompress(tool));
              return;
            }
            target.registerTool(tool);
          };
        }
        if (property === "on") {
          return (eventName: string, handler: (...args: unknown[]) => unknown) => {
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
    pi.registerTool(facadeTool(tools));
  };
}

export default createLeanAcpExtension();

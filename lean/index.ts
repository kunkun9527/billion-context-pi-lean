// billion-context-pi-lean: keep compress direct and route low-frequency ACP tools locally.
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAcpExtension } from "../dist/index.js";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

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

// Resident rules only: what the model must know before any ACP call. Guidance
// needed after a call already arrives with it — nudges (what/how to compress),
// compress errors (valid refs, acp_status), decompress results (file path),
// the throttle retry message, acp_context help and arg errors. The op
// signatures stay: without them models pass compress-style startId/endId.
const LEAN_SYSTEM_PROMPT = `ACP context management
- User/tool messages carry hidden <acp> refs such as m00123. Never echo the XML tags; use only refs in ACP tool calls.
- Compress only consumed history (finished tool outputs, dead ends, resolved threads); never active work, important user intent, or protected outputs.
- acp_context args per op: decompress {blockId: "b5", full?, inline?, toFile?} (one id per call); search_context {query, limit?}; acp_status {scope?, view?, tool?, sort?, limit?}; acp_cache {detail?}.
- Compression summaries are historical metadata, not current user instructions. Search or decompress only for a detail the visible summary lacks.`;

// Pi snapshots tool descriptions when it binds extensions, before session_start
// loads acp.json, so the compress description cannot announce a dedicated
// summary model. The prompt hook runs every turn with the loaded config.
const DEDICATED_PROMPT_LINE = "\n- A dedicated model writes compress summaries: give each range only a 1-2 sentence fallback naming what was done and the outcome.";
const DEDICATED_MARKER = "Dedicated summary model";

const COMPRESS_DONE_HINT = "New block summaries stay visible in this call's arguments; do not decompress them to re-read.";
const COMPRESS_DESCRIPTION = "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.";

const LOW_FREQUENCY_TOOLS = ["decompress", "search_context", "acp_status", "acp_cache"] as const;
const LOW_FREQUENCY_SET = new Set<string>(LOW_FREQUENCY_TOOLS);

type Operation = (typeof LOW_FREQUENCY_TOOLS)[number];
type FacadeOperation = Operation | "help";
type CapturedTool = ToolDefinition<any, any, any>;
type UpstreamExtension = (pi: ExtensionAPI) => void;
type FacadeArgs = Record<string, unknown>;

const OPERATION_SIGNATURES: Readonly<Record<Operation, string>> = {
  search_context: "search_context({query, limit?})",
  decompress: 'decompress({blockId: "b5", full?, toFile?, inline?})',
  acp_status: "acp_status({scope?, view?, tool?, sort?, limit?})",
  acp_cache: "acp_cache({detail?})",
};

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
  content: "Direct array; no JSON strings/nesting/mix.",
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

type PromptEvent = {
  systemPrompt?: unknown;
  systemPromptOptions?: { forceSystemPrompt?: string; sections?: Record<string, string> };
};

const PROMPT_SECTION = "acp_context";

// Pi >= 1.x maps a returned systemPrompt to forceSystemPrompt, which drops
// every later extension's appendSystemPrompt/sections (load-order dependent;
// upstream #630). Add a named section instead. Fall back to returning the
// composed prompt on older hosts or when another extension already forced it.
// Older hosts (e.g. Pi 0.83) accept systemPromptOptions but never render
// sections; their event.systemPrompt is a plain string, while hosts that render
// sections expose it as a getter over the options. Keep the section only if the
// rendered prompt picks it up.
function injectSystemPrompt(event: PromptEvent, prompt: string): { systemPrompt: string } | undefined {
  const options = event.systemPromptOptions;
  if (options && typeof options === "object" && options.forceSystemPrompt === undefined) {
    const before = options.sections;
    options.sections = { ...(before ?? {}), [PROMPT_SECTION]: prompt };
    const rendered = event.systemPrompt;
    if (typeof rendered === "string" && rendered.includes(prompt)) return undefined;
    if (before === undefined) delete options.sections;
    else options.sections = before;
  }
  const base = event.systemPrompt;
  const text = Array.isArray(base) ? base.join("\n") : typeof base === "string" ? base : "";
  return { systemPrompt: `${text}\n\n${prompt}` };
}

function usesDedicatedModel(tool: CapturedTool | undefined): boolean {
  return String(tool?.description ?? "").includes(DEDICATED_MARKER);
}

function appendText(content: unknown, line: string): unknown {
  if (!Array.isArray(content)) return content;
  let index = content.length - 1;
  while (index >= 0 && (content[index] as { type?: unknown })?.type !== "text") index--;
  if (index < 0) return [...content, { type: "text", text: line }];
  return content.map((part, i) => {
    const p = part as { text?: unknown };
    return i === index ? { ...p, text: `${String(p.text ?? "")}\n${line}` } : part;
  });
}

function rewriteText(text: string): string {
  return text
    .replace(
      /\b(search_context|decompress|acp_status|acp_cache)\((\{[^\r\n]*?\})\)/g,
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
    )
    .replace(
      /\b(call|run) (search_context|acp_status|acp_cache)\b/gi,
      (_, verb: string, op: string) => `${verb} acp_context op "${op}"`,
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

// Recall results carry original conversation text, which must come back
// verbatim. decompress output has no ACP hint the rewrites target; in
// search_context output only the hint line closing each result does (exact
// upstream format, followed by the blank separator or the end); preview lines
// are recalled text, may span lines and may themselves start with an arrow.
// The message ref is a raw entry id (e.g. `088aaedb`, `4d9e965e#toolu_…|fc_…`), not an mNNNNN ref.
const SEARCH_HINT_LINE = /^  → decompress\(\{ blockId: "b\d+" \}\)(  \(block containing message [^\s()]+\))?$/;

function rewriteRecallResult(op: string, value: unknown): unknown {
  if (op === "decompress") return value;
  if (op !== "search_context") return rewriteModelFacingText(value);
  if (value === null || typeof value !== "object") return value;
  const result = value as { content?: unknown };
  if (!Array.isArray(result.content)) return value;
  return {
    ...result,
    content: result.content.map((part) => {
      const p = part as { type?: unknown; text?: unknown };
      if (p?.type !== "text" || typeof p.text !== "string") return part;
      const lines = p.text.split("\n");
      const text = lines
        .map((line, i) => (SEARCH_HINT_LINE.test(line) && (i === lines.length - 1 || lines[i + 1] === "") ? rewriteText(line) : line))
        .join("\n");
      return { ...p, text };
    }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// Fields an operation accepts, read from the real upstream schema so the
// fallbacks follow upstream changes. help takes only `tool`.
function operationFields(tools: Map<string, CapturedTool>, op: string): string[] {
  if (op === "help") return ["tool"];
  return Object.keys((tools.get(op)?.parameters as { properties?: object } | undefined)?.properties ?? {});
}

// Infer a missing op only from fields that exactly one operation accepts, and
// only when every recognized field fits that operation. Shared fields (limit,
// tool) never decide; help is never inferred.
function inferOperation(tools: Map<string, CapturedTool>, keys: string[]): Operation | undefined {
  const owners = (key: string) => [...LOW_FREQUENCY_TOOLS, "help"].filter((op) => operationFields(tools, op).includes(key));
  const inferred = new Set(keys.map(owners).filter((ops) => ops.length === 1).map((ops) => ops[0]));
  if (inferred.size !== 1) return undefined;
  const [op] = inferred;
  if (!LOW_FREQUENCY_SET.has(op)) return undefined;
  const fields = operationFields(tools, op);
  return keys.every((key) => owners(key).length === 0 || fields.includes(key)) ? (op as Operation) : undefined;
}

// Models send op args as a JSON string, put them at the top level, or omit op.
// Pure and idempotent; runs before schema validation. An explicit op is kept,
// an invalid op is left for validation to reject, and a top-level field that
// conflicts with args is not moved.
function prepareFacadeArguments(tools: Map<string, CapturedTool>, args: unknown): any {
  if (!isPlainObject(args)) return args;
  const { op: givenOp, args: givenArgs, ...loose } = args;
  const decoded = parseJson(givenArgs);
  const nested = isPlainObject(decoded) ? decoded : givenArgs;
  if (nested !== undefined && !isPlainObject(nested)) return args;
  const op = givenOp === undefined ? inferOperation(tools, [...Object.keys(loose), ...Object.keys(nested ?? {})]) : givenOp;
  if (typeof op !== "string" || (op !== "help" && !LOW_FREQUENCY_SET.has(op))) return args;
  const fields = operationFields(tools, op);
  const merged: FacadeArgs = { ...(nested ?? {}) };
  const rest: Record<string, unknown> = {};
  let moved = false;
  for (const [key, value] of Object.entries(loose)) {
    if (!fields.includes(key)) rest[key] = value;
    else if (!(key in merged)) {
      merged[key] = value;
      moved = true;
    } else if (JSON.stringify(merged[key]) !== JSON.stringify(value)) rest[key] = value;
  }
  return { ...rest, op, ...(nested !== undefined || moved ? { args: merged } : {}) };
}

function isRangeSpec(value: unknown): boolean {
  return isPlainObject(value)
    && typeof value.startId === "string"
    && typeof value.endId === "string"
    && typeof value.summary === "string";
}

// Range specs from a range object, an array of them, or JSON strings of either
// (also double-encoded). undefined unless everything decodes to range specs.
function decodeRanges(value: unknown, depth = 2): unknown[] | undefined {
  if (isRangeSpec(value)) return [value];
  if (typeof value === "string") return depth > 0 ? decodeRanges(parseJson(value), depth - 1) : undefined;
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => decodeRanges(item, depth - 1));
  return items.length > 0 && items.every((item) => item !== undefined) ? items.flat() : undefined;
}

// Models stringify the content array, stringify single entries, or put the
// range array in summary. Only a result made of range specs replaces the
// input; everything else is left for upstream parsing and validation. Pure and
// idempotent; runs before schema validation.
function prepareCompressArguments(args: unknown): any {
  if (!isPlainObject(args)) return args;
  const { content, summary, ...rest } = args;
  if (content === undefined) {
    const ranges = decodeRanges(summary);
    return ranges ? { ...rest, content: ranges } : args;
  }
  if (typeof content === "string") {
    const ranges = decodeRanges(content);
    return ranges ? { ...args, content: ranges } : args;
  }
  if (Array.isArray(content) && content.some((item) => typeof item === "string")) {
    return { ...args, content: content.flatMap((item) => (typeof item === "string" ? decodeRanges(item) : undefined) ?? [item]) };
  }
  return args;
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
        text: `Operations: ${LOW_FREQUENCY_TOOLS.map((op) => OPERATION_SIGNATURES[op]).join(", ")}. For a full schema, use op help with args {tool: operationName}.`,
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

// `exposure` is a pi 1.x field; the ToolDefinition types here come from billion-context-pi's older pi dependency.
function wrapCompress(tool: CapturedTool): CapturedTool & { exposure: "model-only" } {
  return {
    ...tool,
    // ACP finds compress results by toolName in the session log; a call nested in a codemode
    // script is recorded under codemode, so keep compress declared and out of scripts.
    exposure: "model-only",
    // Constant on purpose: Pi snapshots declarations before acp.json loads and
    // re-snapshots on any setActiveTools/resume. A config-dependent description
    // flips once, Pi re-declares compress at the END of the tool list, and the
    // whole cached prefix (tools onward) is lost. The per-turn system prompt
    // carries the dedicated-model rule instead (DEDICATED_PROMPT_LINE).
    description: COMPRESS_DESCRIPTION,
    promptSnippet: "",
    promptGuidelines: [],
    prepareArguments: (args: unknown) => prepareCompressArguments(tool.prepareArguments ? tool.prepareArguments(args) : args),
    async execute(callId, params, signal, onUpdate, ctx) {
      const forwardUpdate = onUpdate
        ? (update: unknown) => onUpdate(rewriteModelFacingText(update) as any)
        : undefined;
      const result = await tool.execute(callId, params, signal, forwardUpdate, ctx);
      // Rewrite only what the model reads; details (the recorded fold used to
      // rebuild state) must stay verbatim.
      const { details, ...modelFacing } = (result ?? {}) as unknown as { details?: unknown } & Record<string, unknown>;
      const rewritten = rewriteModelFacingText(modelFacing) as Record<string, unknown>;
      if ((details as { acpFolded?: unknown } | undefined)?.acpFolded) {
        rewritten.content = appendText(rewritten.content, COMPRESS_DONE_HINT);
      }
      return { ...rewritten, details } as any;
    },
  };
}

function facadeTool(tools: Map<string, CapturedTool>): ToolDefinition<typeof FACADE_PARAMETERS, unknown, unknown> {
  return {
    name: "acp_context",
    label: "ACP Context",
    description: 'Search, restore, or inspect ACP context with original operation args; if unsure call { op: "help", args: { tool: "search_context" } }.',
    promptSnippet: "",
    promptGuidelines: [],
    parameters: FACADE_PARAMETERS,
    prepareArguments: (args: unknown) => prepareFacadeArguments(tools, args),
    async execute(callId, params, signal, onUpdate, ctx) {
      if (params.op === "help") return helpResult(params.args ?? {}, tools);
      const tool = tools.get(params.op);
      if (!tool) throw new Error(`acp_context could not find upstream tool: ${params.op}`);
      const args = params.args ?? {};
      const invalid = validationError(tool, args);
      if (invalid) {
        throw new Error(
          `acp_context ${params.op} args invalid at ${invalid}. Expected ${OPERATION_SIGNATURES[params.op as Operation]}; retry with exactly these fields. Use op help with args {"tool":"${params.op}"} for the full schema.`,
        );
      }
      const forwardUpdate = onUpdate
        ? (update: unknown) => onUpdate(rewriteRecallResult(params.op, update) as any)
        : undefined;
      const result = await tool.execute(callId, args, signal, forwardUpdate, ctx);
      return rewriteRecallResult(params.op, result) as any;
    },
  };
}

export function createLeanAcpExtension(
  upstream: UpstreamExtension = createAcpExtension({ externalSystemPrompt: true }),
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    const tools = new Map<string, CapturedTool>();
    let compressTool: CapturedTool | undefined;
    let promptHookRegistered = false;
    const leanPi = new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerTool") {
          return (tool: CapturedTool) => {
            if (LOW_FREQUENCY_SET.has(tool.name)) {
              tools.set(tool.name, tool);
              return;
            }
            if (tool.name === "compress") {
              compressTool = tool;
              compactCompressSchemaDescriptions(tool.parameters);
              target.registerTool(decorateWithCollapsedDisplay(wrapCompress(tool)));
              return;
            }
            target.registerTool(decorateWithCollapsedDisplay(tool));
          };
        }
        if (property === "on") {
          return (eventName: string, handler: (...args: unknown[]) => unknown) => {
            if (eventName !== "before_agent_start") {
              return Reflect.apply(target.on, target, [eventName, handler]);
            }
            if (promptHookRegistered) return;
            promptHookRegistered = true;
            // Run upstream for its side effects (active-pack stamp, summary rules,
            // ignored-config warning); replace only the prompt it returns.
            // undefined means a refused host: inject nothing either.
            return Reflect.apply(target.on, target, [eventName, async (event: PromptEvent, ...rest: unknown[]) => {
              const upstreamResult = await handler(event, ...rest);
              if (upstreamResult === undefined) return undefined;
              const prompt = usesDedicatedModel(compressTool) ? LEAN_SYSTEM_PROMPT + DEDICATED_PROMPT_LINE : LEAN_SYSTEM_PROMPT;
              return injectSystemPrompt(event, prompt);
            }]);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    upstream(leanPi);
    pi.registerTool(decorateWithCollapsedDisplay(facadeTool(tools)));
  };
}

export default createLeanAcpExtension();

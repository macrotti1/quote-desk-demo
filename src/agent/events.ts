// Maps SDK messages to desk event bodies (spec 5.10) and scrubs text that leaves the process (spec 5.9).
// The mapper reads message bodies as plain records, so a shape the installed types don't promise can't
// crash a run: a field that isn't there maps to an empty value or the message is skipped.
import { homedir, tmpdir, userInfo } from "node:os";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CATALOG_SERVER, CATALOG_TOOLS, STRUCTURED_OUTPUT_TOOL, TOOL_RESULT_SCHEMAS } from "../contracts.ts";
import type { CatalogToolName, DeskEventBody, ToolResult } from "../contracts.ts";

export const TOOL_RESULT_TEXT_MAX = 2000;
const CATALOG_PREFIX = `mcp__${CATALOG_SERVER}__`;

/** The catalog tool a full SDK name stands for, or null for any other tool. */
export function catalogToolOf(fullName: string): CatalogToolName | null {
  if (!fullName.startsWith(CATALOG_PREFIX)) return null;
  const short = fullName.slice(CATALOG_PREFIX.length);
  return CATALOG_TOOLS.find((t) => t === short) ?? null;
}

/** Catalog tools by short name ("check_stock"), any other tool verbatim. */
export function displayToolName(fullName: string): string {
  return catalogToolOf(fullName) ?? fullName;
}

// ---- scrubbing

/** key: a secret to remove verbatim (the run passes its ANTHROPIC_API_KEY); ignored when shorter than 8. */
export type ScrubTargets = { home: string; tmp: string; user: string | null; key?: string | null };

/** The shape of an Anthropic API key. Any match becomes "<key>", whether or not it's this machine's key. */
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}/g;
const KEY_MIN = 8;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The spellings of a path, longest first: native, forward slashes, JSON-escaped (two backslashes), JSON inside
 * JSON (four backslashes), URL-encoded (native and forward), and for a Windows drive path the MSYS form
 * (drive Q, folders x and y, becomes /q/x/y).
 */
function spellings(p: string): string[] {
  const parts = p.split("\\");
  const native = p;
  const forward = parts.join("/");
  const escaped = parts.join("\\\\");
  const escapedTwice = parts.join("\\\\\\\\");
  const all = [native, forward, escaped, escapedTwice, encodeURIComponent(native), encodeURIComponent(forward)];
  const drive = /^([A-Za-z]):\//.exec(forward);
  if (drive !== null) all.push(`/${drive[1]?.toLowerCase()}${forward.slice(2)}`);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/**
 * A scrubber for the given targets. The literal key goes first, then any key shape, then the temp dir (on
 * Windows it sits inside the home dir), the home dir and the user name. Paths are matched case-insensitively;
 * the user name only as a whole word (a URL-encoded separator before it counts as a word edge), and only when
 * it has 3 or more characters.
 */
export function createScrubber(t: ScrubTargets): (s: string) => string {
  const rules: { re: RegExp; to: string }[] = [];
  if (typeof t.key === "string" && t.key.length >= KEY_MIN) {
    rules.push({ re: new RegExp(escapeRegExp(t.key), "g"), to: "<key>" });
  }
  rules.push({ re: KEY_SHAPE, to: "<key>" });
  for (const [path, to] of [[t.tmp, "<tmp>"], [t.home, "~"]] as const) {
    if (path.length < 3) continue; // a root like "/" would eat every slash
    for (const s of spellings(path)) rules.push({ re: new RegExp(escapeRegExp(s), "gi"), to });
  }
  if (t.user !== null && t.user.length >= 3) {
    const edge = "(?:(?<=%5C)|(?<=%2F)|(?<![A-Za-z0-9_]))";
    rules.push({ re: new RegExp(`${edge}${escapeRegExp(t.user)}(?![A-Za-z0-9_])`, "gi"), to: "<user>" });
  }
  return (s: string): string => {
    let out = s;
    for (const r of rules) out = out.replace(r.re, r.to);
    return out;
  };
}

function osUserName(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

let defaultScrubber: ((s: string) => string) | null = null;

/**
 * Replaces this machine's home dir with "~", its temp dir with "<tmp>", the OS user name with "<user>" and any
 * API key shape with "<key>".
 */
export function scrubText(s: string): string {
  defaultScrubber ??= createScrubber({ home: homedir(), tmp: tmpdir(), user: osUserName() });
  return defaultScrubber(s);
}

/**
 * scrubText plus the literal value of the given key (when it has 8 or more characters). runQuote builds one per
 * run from its base env's ANTHROPIC_API_KEY; the value lives only inside the returned closure.
 */
export function createRunScrubber(key: string | undefined): (s: string) => string {
  return createScrubber({ home: homedir(), tmp: tmpdir(), user: osUserName(), key: key ?? null });
}

/** scrubText on every string inside a JSON-like value. Object keys stay as they are. */
export function scrubDeep(value: unknown, scrub: (s: string) => string = scrubText): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, scrub);
    return out;
  }
  return value;
}

// ---- small readers for untyped message bodies

type Rec = Record<string, unknown>;
function rec(x: unknown): Rec | null {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Rec) : null;
}
function str(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}
function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}
function records(x: unknown): Rec[] {
  return Array.isArray(x) ? x.map(rec).filter((r): r is Rec => r !== null) : [];
}

/** A tool_result block's content: the string itself, or its text blocks joined by newlines. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return records(content).filter((b) => b["type"] === "text").map((b) => str(b["text"]) ?? "").join("\n");
}

function parseToolData(tool: CatalogToolName, text: string): ToolResult | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null; // an MCP SDK validation error, a hook denial or a timeout notice
  }
  const parsed = TOOL_RESULT_SCHEMAS[tool].safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** scrubDeep keeps every key and non-string value, so the result still has the ToolResult shape. */
function scrubData(data: ToolResult | null, scrub: (s: string) => string): ToolResult | null {
  return data === null ? null : (scrubDeep(data, scrub) as ToolResult);
}

// ---- the mapper

export type EventMapper = {
  /** The event bodies one SDK message becomes, often none. */
  map(msg: SDKMessage): DeskEventBody[];
  /** The last non-empty assistant error code seen, for example "overloaded". */
  lastAssistantError(): string | null;
};

export type EventMapperOptions = { now?: () => number; scrub?: (s: string) => string };

export function createEventMapper(o: EventMapperOptions = {}): EventMapper {
  const now = o.now ?? (() => performance.now());
  const scrub = o.scrub ?? scrubText;
  const calls = new Map<string, { tool: string; catalogTool: CatalogToolName | null; startedAt: number }>();
  const skipped = new Set<string>();
  let lastError: string | null = null;

  function system(m: Rec): DeskEventBody[] {
    switch (m["subtype"]) {
      case "init":
        return [{
          type: "session_init",
          model: str(m["model"]) ?? "",
          permissionMode: str(m["permissionMode"]) ?? "",
          tools: strings(m["tools"]),
          // The probe saw a third key, source; the event keeps name and status only.
          mcpServers: records(m["mcp_servers"]).map((s) => ({ name: str(s["name"]) ?? "", status: str(s["status"]) ?? "" })),
          skills: strings(m["skills"]),
          plugins: Array.isArray(m["plugins"])
            ? m["plugins"].map((p) => str(p) ?? str(rec(p)?.["name"]) ?? "").filter((n) => n !== "")
            : [],
          apiKeySource: str(m["apiKeySource"]) ?? "",
          claudeCodeVersion: str(m["claude_code_version"]) ?? "",
        }];
      case "model_refusal_fallback":
        return [{
          type: "model_refusal", fallback: true,
          originalModel: str(m["original_model"]) ?? "",
          fallbackModel: str(m["fallback_model"]),
          scope: str(m["scope"]) ?? "session",
          category: str(m["api_refusal_category"]),
        }];
      case "model_refusal_no_fallback":
        return [{
          type: "model_refusal", fallback: false,
          originalModel: str(m["original_model"]) ?? "",
          fallbackModel: null, scope: null,
          category: str(m["api_refusal_category"]),
        }];
      default:
        return []; // thinking_tokens and every other subtype
    }
  }

  function assistant(m: Rec): DeskEventBody[] {
    const error = str(m["error"]);
    if (error !== null && error !== "") lastError = error;
    const out: DeskEventBody[] = [];
    for (const block of records(rec(m["message"])?.["content"])) {
      if (block["type"] === "text") {
        const text = str(block["text"]) ?? "";
        if (text.trim() !== "") out.push({ type: "assistant_text", text: scrub(text) });
      } else if (block["type"] === "tool_use") {
        const id = str(block["id"]);
        const name = str(block["name"]);
        if (id === null || name === null) continue;
        if (name === STRUCTURED_OUTPUT_TOOL) {
          skipped.add(id);
          continue;
        }
        const tool = displayToolName(name);
        calls.set(id, { tool, catalogTool: catalogToolOf(name), startedAt: now() });
        out.push({ type: "tool_call", toolUseId: id, tool, input: scrubDeep(block["input"] ?? null, scrub) });
      }
      // thinking blocks and anything else are skipped
    }
    return out;
  }

  function user(m: Rec): DeskEventBody[] {
    const out: DeskEventBody[] = [];
    for (const block of records(rec(m["message"])?.["content"])) {
      if (block["type"] !== "tool_result") continue;
      const id = str(block["tool_use_id"]);
      if (id === null || skipped.has(id)) continue;
      const call = calls.get(id);
      if (call === undefined) continue; // a result whose call was never recorded
      calls.delete(id);
      // Parse the full content, then cut the text kept in the event, so a long Ok result still parses.
      const full = toolResultText(block["content"]);
      out.push({
        type: "tool_result",
        toolUseId: id,
        tool: call.tool,
        isError: block["is_error"] === true,
        // A ToolError message can echo the model's input, so the parsed strings are scrubbed too.
        data: call.catalogTool === null ? null : scrubData(parseToolData(call.catalogTool, full), scrub),
        text: scrub(full).slice(0, TOOL_RESULT_TEXT_MAX),
        ms: Math.max(0, Math.round(now() - call.startedAt)),
      });
    }
    return out;
  }

  return {
    map(msg: SDKMessage): DeskEventBody[] {
      const m = rec(msg);
      if (m === null) return [];
      switch (m["type"]) {
        case "system": return system(m);
        case "assistant": return assistant(m);
        case "user": return user(m);
        default: return []; // result maps to nothing; every other type is ignored
      }
    },
    lastAssistantError: () => lastError,
  };
}

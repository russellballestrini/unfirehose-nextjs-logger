/**
 * unfirehose/1.0 extension for pi coding agent (@mariozechner/pi-coding-agent)
 *
 * Hooks pi's lifecycle events and writes unfirehose/1.0 JSONL to a path
 * that unfirehose knows to ingest. Pi's native session file still exists
 * (pi needs it for /tree, compaction, branching), but unfirehose reads
 * from this extension's output — one source of truth per consumer.
 *
 * Install:
 *   cp pi-unfirehose.ts ~/.pi/agent/extensions/unfirehose.ts
 *   # or symlink:
 *   ln -s /path/to/pi-unfirehose.ts ~/.pi/agent/extensions/unfirehose.ts
 *
 * Configuration (optional, in ~/.pi/agent/settings.json):
 *   { "unfirehose": { "outputDir": "~/.pi/projects" } }
 *
 * Output:
 *   ~/.pi/projects/{project-slug}/{session-uuid}.jsonl
 *
 * @see https://www.npmjs.com/package/@unturf/unfirehose-schema
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join, sep } from "path";
import { homedir } from "os";
import { randomUUID, createHash } from "crypto";

// ── types (inlined to avoid import dependencies) ────────────────────

interface UnfirehoseObject {
  $schema: "unfirehose/1.0";
  type: string;
  [key: string]: unknown;
}

interface ContentBlock {
  type: "text" | "reasoning" | "tool-call" | "tool-result" | "image";
  [key: string]: unknown;
}

// pi types (subset we use — avoids depending on pi internals)
interface PiTextContent {
  type: "text";
  text: string;
}
interface PiThinkingContent {
  type: "thinking";
  thinking: string;
}
interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
type PiContent = PiTextContent | PiThinkingContent | PiToolCall | PiImageContent;

interface PiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface PiAssistantMessage {
  role: "assistant";
  content: PiContent[];
  provider: string;
  model: string;
  usage: PiUsage;
  stopReason: string;
  timestamp: number;
}

interface PiUserMessage {
  role: "user";
  content: string | PiContent[];
  timestamp: number;
}

interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | PiImageContent)[];
  isError: boolean;
  timestamp: number;
}

type PiMessage = PiAssistantMessage | PiUserMessage | PiToolResultMessage;

// ── canonical tool name mapping ─────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "ListDir",
  glob: "Glob",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
};

function canonicalToolName(piName: string): string {
  return TOOL_NAME_MAP[piName] ?? piName;
}

// ── provider mapping ────────────────────────────────────────────────

function canonicalProvider(
  piProvider: string
): "anthropic" | "google" | "openai" | "local" {
  const p = piProvider.toLowerCase();
  if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
  if (p.includes("google") || p.includes("gemini")) return "google";
  if (p.includes("openai") || p.includes("gpt")) return "openai";
  return "local";
}

// ── stop reason mapping ─────────────────────────────────────────────

function canonicalStopReason(
  piStop: string
): "end_turn" | "tool_calls" | "length" | "content_filter" | "error" {
  switch (piStop) {
    case "end_turn":
    case "stop":
      return "end_turn";
    case "tool_use":
    case "tool_calls":
      return "tool_calls";
    case "max_tokens":
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "end_turn";
  }
}

// ── content block transform ─────────────────────────────────────────

function transformContent(piContent: PiContent[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const c of piContent) {
    switch (c.type) {
      case "text":
        blocks.push({ type: "text", text: c.text });
        break;
      case "thinking":
        blocks.push({ type: "reasoning", text: c.thinking });
        break;
      case "toolCall":
        blocks.push({
          type: "tool-call",
          toolCallId: c.id,
          toolName: canonicalToolName(c.name),
          input: c.arguments,
        });
        break;
      case "image":
        blocks.push({ type: "image", mediaType: c.mimeType, data: c.data });
        break;
    }
  }
  return blocks;
}

function userContent(
  raw: string | PiContent[]
): ContentBlock[] {
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  return transformContent(raw);
}

// ── usage transform ─────────────────────────────────────────────────

function transformUsage(u: PiUsage) {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.inputTokens + u.outputTokens,
    inputTokenDetails:
      u.cacheReadInputTokens || u.cacheCreationInputTokens
        ? {
            cacheReadTokens: u.cacheReadInputTokens,
            cacheWriteTokens: u.cacheCreationInputTokens,
          }
        : undefined,
  };
}

// ── project slug from cwd ───────────────────────────────────────────

function projectSlug(cwd: string): string {
  return cwd.replace(new RegExp(`^${homedir()}`), "~").replace(/\//g, "-").replace(/^-/, "");
}

// ── timestamp helpers ───────────────────────────────────────────────

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function isoNow(): string {
  return new Date().toISOString();
}

// ── UUIDv7 (time-ordered) ───────────────────────────────────────────

function uuidv7(): string {
  const now = Date.now();
  const uuid = randomUUID().replace(/-/g, "");
  // replace first 12 hex chars with 48-bit timestamp, set version 7
  const ts = now.toString(16).padStart(12, "0");
  const v7 =
    ts.slice(0, 8) +
    "-" +
    ts.slice(8, 12) +
    "-7" +
    uuid.slice(13, 16) +
    "-" +
    uuid.slice(16, 20) +
    "-" +
    uuid.slice(20, 32);
  return v7;
}

// ── session state ───────────────────────────────────────────────────

let sessionId: string;
let sessionPath: string;
let outputDir: string;
let messageCounter: number;
let lastParentId: string | null;

// ── unfirehose-chain-v1 (inlined, like the types) ───────────────────
// Every line ends with a fixed 75-byte `,"hash":"<64 hex>"}` tail: SHA-256
// over exactly the bytes before it, which carry `prevHash` inside them.
// The closed record carries `sessionRoot`: the merkle-v1 root (leaf 0x00,
// node 0x03, odd layer self-duplicates) over every line's hash before it.
// The same rule uncloseai-cli, arborist and agnt write and the ingester
// verifies; docs/sessions.md § Chain. Byte-level, so nothing canonical.

const CHAIN_FIELDS = {
  hashVersion: "unfirehose-chain-v1",
  merkleVersion: "merkle-v1",
  encodingVersion: "jsonl-bytes-v1",
  rootSemantics: "SEQUENCE",
};
let prevHash: string | null = null;
let lineHashes: string[] = [];

const sha = (...parts: Buffer[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

function chainLine(obj: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (k !== "hash" && k !== "prevHash") body[k] = v;
  body.prevHash = prevHash;
  const preimage = JSON.stringify(body);
  const hash = sha(Buffer.from(preimage, "utf8")).toString("hex");
  prevHash = hash;
  lineHashes.push(hash);
  return preimage.slice(0, -1) + ',"hash":"' + hash + '"}';
}

function sessionRoot(hashes: string[]): string {
  let layer: Buffer[] = hashes.map((h) => sha(Buffer.from([0x00]), Buffer.from(h, "hex")));
  if (layer.length === 0) return "00".repeat(32);
  while (layer.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(sha(Buffer.from([0x03]), layer[i], i + 1 < layer.length ? layer[i + 1] : layer[i]));
    }
    layer = next;
  }
  return layer[0].toString("hex");
}

function append(obj: UnfirehoseObject) {
  appendFileSync(sessionPath, chainLine(obj as Record<string, unknown>) + "\n");
}

function msgId(): string {
  return `msg_${String(++messageCounter).padStart(4, "0")}`;
}

// ── the extension ───────────────────────────────────────────────────

export default function (pi: any) {
  // ── session start ───────────────────────────────────────────────
  pi.on(
    "session_start",
    async (event: { cwd: string; sessionId: string }, ctx: any) => {
      sessionId = uuidv7();
      messageCounter = 0;
      lastParentId = null;

      // resolve output dir
      const home = homedir();
      outputDir =
        ctx?.settings?.unfirehose?.outputDir?.replace("~", home) ??
        join(home, ".pi", "projects");

      const slug = projectSlug(event.cwd);
      const dir = join(outputDir, slug);
      mkdirSync(dir, { recursive: true });
      sessionPath = join(dir, `${sessionId}.jsonl`);

      // detect pi version from package if available
      let harnessVersion: string | undefined;
      try {
        const pkg = require("@mariozechner/pi-coding-agent/package.json");
        harnessVersion = pkg.version;
      } catch {
        // not resolvable, ok
      }

      // write session envelope
      const session: UnfirehoseObject = {
        $schema: "unfirehose/1.0",
        type: "session",
        id: sessionId,
        projectId: slug,
        status: "active",
        createdAt: isoNow(),
        cwd: event.cwd,
        harness: "pi",
        harnessVersion,
        ...CHAIN_FIELDS,
      };
      prevHash = null;
      lineHashes = [];
      writeFileSync(sessionPath, chainLine(session as Record<string, unknown>) + "\n");
    }
  );

  // ── message end (captures user, assistant, tool results) ────────
  pi.on(
    "message_end",
    async (
      event: { message: PiMessage; entryId: string },
      _ctx: any
    ) => {
      if (!sessionPath) return;
      const msg = event.message;
      const id = msgId();

      if (msg.role === "user") {
        const line: UnfirehoseObject = {
          $schema: "unfirehose/1.0",
          type: "message",
          id,
          sessionId,
          parentId: lastParentId,
          role: "user",
          timestamp: isoFromMs(msg.timestamp),
          content: userContent(msg.content),
          harness: "pi",
        };
        append(line);
        lastParentId = id;
      } else if (msg.role === "assistant") {
        const line: UnfirehoseObject = {
          $schema: "unfirehose/1.0",
          type: "message",
          id,
          sessionId,
          parentId: lastParentId,
          role: "assistant",
          timestamp: isoFromMs(msg.timestamp),
          model: msg.model,
          provider: canonicalProvider(msg.provider),
          content: transformContent(msg.content),
          usage: transformUsage(msg.usage),
          stopReason: canonicalStopReason(msg.stopReason),
          harness: "pi",
        };
        append(line);
        lastParentId = id;
      } else if (msg.role === "toolResult") {
        // tool results become user messages with tool-result content blocks
        const resultContent: ContentBlock[] = [];
        for (const c of msg.content) {
          if (c.type === "text") {
            resultContent.push({
              type: "tool-result",
              toolCallId: msg.toolCallId,
              toolName: canonicalToolName(msg.toolName),
              output: c.text,
              isError: msg.isError,
            });
          } else if (c.type === "image") {
            resultContent.push({
              type: "tool-result",
              toolCallId: msg.toolCallId,
              toolName: canonicalToolName(msg.toolName),
              output: `[image: ${c.mimeType}]`,
              isError: msg.isError,
            });
          }
        }
        const line: UnfirehoseObject = {
          $schema: "unfirehose/1.0",
          type: "message",
          id,
          sessionId,
          parentId: lastParentId,
          role: "user",
          timestamp: isoFromMs(msg.timestamp),
          content: resultContent,
          harness: "pi",
        };
        append(line);
        lastParentId = id;
      }
    }
  );

  // ── session shutdown ────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (!sessionPath) return;
    // The closed record: root over every line before it, then session_end.
    append({
      $schema: "unfirehose/1.0",
      type: "session",
      id: sessionId,
      status: "closed",
      closedAt: isoNow(),
      updatedAt: isoNow(),
      sessionRoot: sessionRoot(lineHashes),
      ...CHAIN_FIELDS,
    } as UnfirehoseObject);
    const line: UnfirehoseObject = {
      $schema: "unfirehose/1.0",
      type: "message",
      id: msgId(),
      sessionId,
      parentId: lastParentId,
      role: "system",
      timestamp: isoNow(),
      content: [{ type: "text", text: "Session ended" }],
      subtype: "session_end",
      harness: "pi",
    };
    append(line);
  });

  // ── model change tracking ───────────────────────────────────────
  pi.on(
    "model_select",
    async (event: { provider: string; modelId: string }) => {
      if (!sessionPath) return;
      const line: UnfirehoseObject = {
        $schema: "unfirehose/1.0",
        type: "message",
        id: msgId(),
        sessionId,
        parentId: lastParentId,
        role: "system",
        timestamp: isoNow(),
        content: [
          {
            type: "text",
            text: `Model changed to ${event.modelId} (${event.provider})`,
          },
        ],
        subtype: "model_change",
        harness: "pi",
      };
      append(line);
    }
  );
}

import { parseToolArgs } from './uncloseai-adapter';
import path from 'path';
import { homedir } from 'os';
import { claudePaths } from './claude-paths';
import { harnessPaths } from './harness-paths';
import { ingestedHarnesses, type HarnessFormat } from './harness-registry';
import { HARNESS_ROOTS } from './harness-roots';
import { normalizeClaudeCodeEntry } from './claude-code-adapter';
import { normalizeUncloseaiEntry } from './uncloseai-adapter';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Harness registry. One entry per supported harness — each describes:
 *   - sessionFile(slug, uuid): the on-disk JSONL path
 *   - normalize(raw): raw line → canonical unfirehose/1.0 message, or null to skip
 *
 * Native unfirehose/1.0 harnesses (agnt, arborist, aborist, …) use the passthrough
 * normalizer. Foreign-schema harnesses (claude-code, uncloseai-cli) carry their own
 * inbound adapter. Everything downstream consumes unfirehose/1.0.
 */
export interface HarnessAdapter {
  name: string;
  sessionFile(slug: string, sessionId: string): string;
  normalize(raw: any): UfMessage | null;
}

/**
 * Canonical unfirehose/1.0 message shape — what the viewer pipeline emits.
 * Block types: text, reasoning, tool-call, tool-result, image, file.
 */
export interface UfMessage {
  $schema?: 'unfirehose/1.0';
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'tool';
  id?: string | null;
  parentId?: string | null;
  sessionId?: string;
  timestamp?: string | null;
  content: any[];
  model?: string | null;
  usage?: any;
  subtype?: string | null;
  durationMs?: number | null;
  sidechain?: boolean;
  harness?: string;
  harnessVersion?: string;
  cwd?: string;
}

function passthroughNative(raw: any): UfMessage | null {
  if (raw?.type !== 'message') return null;
  if (!raw.role || !['user', 'assistant', 'system', 'tool'].includes(raw.role)) return null;
  return raw as UfMessage;
}

/**
 * uncloseai-cli writes its own pre-1.0 event shape (session_start, assistant, tool_call,
 * session_end). Inbound adapter converts to unfirehose/1.0.
 */
function normalizeUncloseaiCli(raw: any): UfMessage | null {
  switch (raw?.type) {
    case 'session_start':
      return {
        $schema: 'unfirehose/1.0',
        type: 'message',
        role: 'user',
        timestamp: raw.timestamp ?? null,
        content: [{ type: 'text', text: raw.prompt ?? '' }],
      };
    case 'assistant':
      return {
        $schema: 'unfirehose/1.0',
        type: 'message',
        role: 'assistant',
        timestamp: raw.timestamp ?? null,
        model: raw.model ?? 'hermes-3-8b',
        content: [{ type: 'text', text: raw.content ?? '' }],
      };
    case 'tool_call': {
      const input = parseToolArgs(raw.args);
      return {
        $schema: 'unfirehose/1.0',
        type: 'message',
        role: 'assistant',
        timestamp: raw.timestamp ?? null,
        model: raw.model ?? 'hermes-3-8b',
        content: [{
          type: 'tool-call',
          toolCallId: `uncloseai-${raw.tool}-${raw.timestamp ?? Date.now()}`,
          toolName: raw.tool ?? 'unknown',
          input,
        }],
      };
    }
    case 'tool_result':
      return {
        $schema: 'unfirehose/1.0',
        type: 'message',
        role: 'tool',
        timestamp: raw.timestamp ?? null,
        content: [{
          type: 'tool-result',
          toolCallId: raw.toolCallId ?? `uncloseai-${raw.tool}-${raw.timestamp ?? Date.now()}`,
          toolName: raw.tool ?? 'unknown',
          output: raw.output ?? raw.result ?? '',
          isError: raw.isError ?? false,
        }],
      };
    case 'session_end':
      return {
        $schema: 'unfirehose/1.0',
        type: 'message',
        role: 'system',
        timestamp: raw.timestamp ?? null,
        subtype: 'session_end',
        content: [],
      };
    default:
      // Already unfirehose/1.0? Pass through.
      return passthroughNative(raw);
  }
}

const NORMALIZE: Record<HarnessFormat, (raw: any) => UfMessage | null> = {
  'claude-code': (raw) => normalizeClaudeCodeEntry(raw) as UfMessage | null,
  unfirehose: passthroughNative,
  'uncloseai-cli': normalizeUncloseaiCli,
};

function adapterFor(id: string, format: HarnessFormat): HarnessAdapter {
  // Claude Code nests subagents under their parent session; every other
  // harness is {root}/{slug}/{session}.jsonl.
  const sessionFile = id === 'claude-code'
    ? (slug: string, sid: string) => claudePaths.sessionFile(slug, sid)
    : (slug: string, sid: string) => harnessPaths(HARNESS_ROOTS[id]()).sessionFile(slug, sid);
  return { name: id, sessionFile, normalize: NORMALIZE[format] };
}

// Every ingested harness in the registry, plus the older ids some of them
// also wrote under (uncloseai-cli's pre-1.0 lines).
const HARNESSES: Record<string, HarnessAdapter> = Object.fromEntries(
  ingestedHarnesses().flatMap((h) => [
    [h.id, adapterFor(h.id, h.format!)],
    ...Object.entries(h.altFormats ?? {}).map(([alt, fmt]) => [alt, { ...adapterFor(h.id, fmt), name: alt }]),
  ]),
);


function genericNativeAdapter(harness: string): HarnessAdapter {
  return {
    name: harness,
    sessionFile: (slug, id) =>
      path.join(homedir(), `.${harness}`, 'unfirehose', slug, `${id}.jsonl`),
    normalize: passthroughNative,
  };
}

/**
 * Resolve a project name to its harness adapter.
 *
 * Project name format:
 *   - "{harness}:{slug}"   — native pattern used by agnt, arborist, fetch, uncloseai, …
 *   - plain encoded name   — legacy claude-code (no colon prefix)
 */
export function harnessFor(projectName: string): { adapter: HarnessAdapter; slug: string } {
  const colonIdx = projectName.indexOf(':');
  if (colonIdx < 0) {
    return { adapter: HARNESSES['claude-code'], slug: projectName };
  }
  const harness = projectName.slice(0, colonIdx);
  const slug = projectName.slice(colonIdx + 1);
  const adapter = HARNESSES[harness] ?? genericNativeAdapter(harness);
  return { adapter, slug };
}

export function resolveSessionFile(projectName: string, sessionId: string): string {
  const { adapter, slug } = harnessFor(projectName);
  return adapter.sessionFile(slug, sessionId);
}

export function parseProjectName(projectName: string): { harness: string; slug: string } {
  const { adapter, slug } = harnessFor(projectName);
  return { harness: adapter.name, slug };
}

// Re-export the canonical normalizer for callers that already have raw entries.
export { normalizeUncloseaiEntry };

/**
 * Every harness unfirehose knows, in one place.
 *
 * Five lists named harnesses and they drifted: session-paths (what ingest
 * reads), harness-detect (what the wizard, Settings and doctor show),
 * harness-models (what the boot panel can launch), harness-procs (what a
 * mesh probe recognises in `ps`), and the 19 adapter docs under
 * @unturf/unfirehose-schema. Each of those is now derived from this table,
 * and a test holds the table to the docs.
 *
 * Pure data — no node modules — so client components (the boot panel's
 * picker) import it as freely as the doctor does. Where an ingested harness
 * writes on disk lives server-side, in harness-roots.ts; `nativeDir` is a
 * path relative to the home directory for the same reason.
 *
 * `id` is the name sessions carry in `sessions.harness` and projects carry
 * as their `<id>:` prefix. `launch.key` is the boot panel's older key for
 * the same tool, kept because saved settings and running tmux sessions
 * already use it.
 */

/** How a harness's session lines read, i.e. which reader ingests them. */
export type HarnessFormat =
  /** Claude Code's own transcript lines (also what Fetch writes). */
  | 'claude-code'
  /** unfirehose/1.0 messages, as native adopters write them. */
  | 'unfirehose'
  /** uncloseai-cli's pre-1.0 event lines (session_start, assistant, tool_call…). */
  | 'uncloseai-cli'
  /** Codex CLI rollouts: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl, appended (codex-adapter.ts). */
  | 'codex-rollout'
  /** Gemini CLI chat recordings: ~/.gemini/tmp/<project>/chats/session-*.jsonl (or legacy .json) (gemini-adapter.ts). */
  | 'gemini-chat'
  /** Continue sessions: ~/.continue/sessions/<id>.json, rewritten whole (continue-adapter.ts). */
  | 'continue-session'
  /** Aider's markdown chat log, <repo root>/.aider.chat.history.md, appended (aider-adapter.ts). */
  | 'aider-history';

/**
 * Formats that are not `{root}/{slug}/{session}.jsonl` of message lines.
 * Each has its own source walker (db/ingest-foreign.ts), and the session
 * viewer reads its sessions back from our database rather than the disk.
 */
export const FOREIGN_FORMATS: ReadonlySet<HarnessFormat> = new Set<HarnessFormat>([
  'codex-rollout', 'gemini-chat', 'continue-session', 'aider-history',
]);

export interface HarnessDef {
  id: string;
  label: string;
  /** Adapter doc, relative to @unturf/unfirehose-schema's docs/. */
  doc: string;
  /**
   * Present exactly when we ingest it: how its lines read. Where it writes
   * is `HARNESS_ROOTS[id]` in harness-roots.ts, or, for a harness with a
   * `repoFile`, that file in each of our projects' roots.
   */
  format?: HarnessFormat;
  /** Where the tool keeps its own data, relative to home, for one documented but not ingested yet. */
  nativeDir?: string;
  /**
   * The file it writes inside each repository it runs in, for a harness
   * with no directory of its own to read (Aider). Such a harness has no
   * entry in HARNESS_ROOTS: ingest and detection look for this file in the
   * roots of projects we already ingest, and nowhere else (db/project-roots.ts).
   */
  repoFile?: string;
  /** The command that starts it writing, for a first run. */
  start?: string;
  /** The boot panel's launcher entry; `rank` keeps its existing order. */
  launch?: { key: string; cmd: string; rank: number; modelFlag?: string; label?: string };
  /** Executable or script basenames that mean this harness is running. */
  procNames?: string[];
  /** Older ids whose lines this harness also wrote, and how they read. */
  altFormats?: Record<string, HarnessFormat>;
}

export const HARNESS_REGISTRY: readonly HarnessDef[] = [
  {
    id: 'claude-code', label: 'Claude Code', doc: 'harnesses/claude-code.md',
    format: 'claude-code', start: 'cd ~/your/repo && claude',
    launch: { key: 'claude', cmd: 'claude', rank: 0, modelFlag: '--model' }, procNames: ['claude'],
  },
  {
    id: 'fetch', label: 'Fetch', doc: 'harnesses/fetch.md',
    // Fetch writes Claude Code's transcript format.
    format: 'claude-code',
    launch: { key: 'fetch', cmd: 'fetch', rank: 10 },
  },
  {
    id: 'uncloseai', label: 'uncloseai-cli', doc: 'harnesses/uncloseai-cli.md',
    format: 'unfirehose',
    launch: { key: 'uncloseai', cmd: 'unclose', rank: 1, modelFlag: '--model' },
    procNames: ['unclose', 'uncloseai-cli', 'uncloseai_cli.py', 'crossbench'],
    altFormats: { 'uncloseai-cli': 'uncloseai-cli' },
  },
  {
    id: 'agnt', label: 'agnt', doc: 'harnesses/agnt.md',
    format: 'unfirehose',
    launch: { key: 'agnt', cmd: 'agnt', rank: 6 }, procNames: ['agnt'],
  },
  {
    id: 'codex', label: 'OpenAI Codex', doc: 'harnesses/openai-codex.md',
    // Read straight from $CODEX_HOME/sessions. scripts/codex-bridge.mts,
    // which used to copy rollouts into ~/.codex/unfirehose, is retired.
    format: 'codex-rollout', start: 'cd ~/your/repo && codex',
    launch: { key: 'codex', cmd: 'codex', rank: 3, modelFlag: '--model', label: 'Codex CLI' }, procNames: ['codex'],
  },
  {
    id: 'gemini-cli', label: 'Gemini CLI', doc: 'harnesses/gemini-cli.md',
    format: 'gemini-chat', start: 'cd ~/your/repo && gemini',
    launch: { key: 'gemini', cmd: 'gemini', rank: 2, modelFlag: '--model' }, procNames: ['gemini'],
  },
  {
    id: 'opencode', label: 'OpenCode', doc: 'harnesses/opencode.md',
    nativeDir: '.opencode',
    launch: { key: 'open-code', cmd: 'opencode', rank: 4, label: 'Open Code' }, procNames: ['opencode'],
  },
  {
    id: 'aider', label: 'Aider', doc: 'harnesses/aider.md',
    // Aider keeps no home directory: it appends to a markdown log in the
    // repository root it runs in.
    format: 'aider-history', repoFile: '.aider.chat.history.md', start: 'cd ~/your/repo && aider',
    launch: { key: 'aider', cmd: 'aider', rank: 5, modelFlag: '--model' }, procNames: ['aider'],
  },
  {
    id: 'cursor', label: 'Cursor', doc: 'harnesses/cursor.md',
    nativeDir: '.cursor',
    launch: { key: 'cursor', cmd: 'cursor', rank: 7 }, procNames: ['cursor'],
  },
  {
    id: 'continue', label: 'Continue', doc: 'harnesses/continue-dev.md',
    format: 'continue-session',
    launch: { key: 'continue', cmd: 'continue', rank: 8 },
  },
  {
    id: 'ollama', label: 'Ollama', doc: 'harnesses/ollama.md',
    launch: { key: 'ollama', cmd: 'ollama', rank: 9, modelFlag: '' },
  },
  { id: 'arborist', label: 'arborist', doc: 'harnesses/arborist.md' },
  { id: 'hermes', label: 'Hermes Agent', doc: 'harnesses/hermes-agent.md', nativeDir: '.hermes/sessions' },
  { id: 'pi', label: 'Pi', doc: 'harnesses/pi.md', nativeDir: '.pi/agent/sessions' },
  { id: 'pi-coding-agent', label: 'Pi coding agent', doc: 'harnesses/pi-coding-agent.md' },
  { id: 'llama-cpp', label: 'llama.cpp', doc: 'harnesses/llama-cpp.md' },
  { id: 'vllm', label: 'vLLM', doc: 'harnesses/vllm.md' },
  { id: 'open-webui', label: 'Open WebUI', doc: 'harnesses/open-webui.md', nativeDir: '.open-webui' },
  { id: 'text-generation-webui', label: 'text-generation-webui', doc: 'harnesses/text-generation-webui.md' },
];

export function harnessById(id: string): HarnessDef | undefined {
  return HARNESS_REGISTRY.find((h) => h.id === id);
}

/** The harnesses ingest reads, in registry order. */
export function ingestedHarnesses(): HarnessDef[] {
  return HARNESS_REGISTRY.filter((h) => h.format);
}

/** Ingested harnesses that write inside each repository rather than under one root of their own. */
export function repoFileHarnesses(): HarnessDef[] {
  return ingestedHarnesses().filter((h) => h.repoFile);
}

/**
 * Directory names under `~/.<name>/unfirehose` that are ours or have their
 * own reader, not native harnesses. `codex` is here because
 * ~/.codex/unfirehose is what the retired codex bridge wrote: the same
 * rollouts we now read from $CODEX_HOME/sessions, so reading both would
 * count them twice.
 */
export const NOT_NATIVE_DIRS = new Set(['unfirehose', 'claude', 'fetch', 'codex']);

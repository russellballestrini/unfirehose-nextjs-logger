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
  | 'uncloseai-cli';

export interface HarnessDef {
  id: string;
  label: string;
  /** Adapter doc, relative to @unturf/unfirehose-schema's docs/. */
  doc: string;
  /**
   * Present exactly when we ingest it: how its lines read. Where it writes
   * is `HARNESS_ROOTS[id]` in harness-roots.ts.
   */
  format?: HarnessFormat;
  /** Where the tool keeps its own data, relative to home, for one documented but not ingested yet. */
  nativeDir?: string;
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
    // Today through scripts/codex-bridge.mts, which writes native
    // unfirehose/1.0 from $CODEX_HOME/sessions (see harness-roots.ts).
    format: 'unfirehose', nativeDir: '.codex/sessions',
    launch: { key: 'codex', cmd: 'codex', rank: 3, modelFlag: '--model', label: 'Codex CLI' }, procNames: ['codex'],
  },
  {
    id: 'gemini-cli', label: 'Gemini CLI', doc: 'harnesses/gemini-cli.md',
    nativeDir: '.gemini/tmp',
    launch: { key: 'gemini', cmd: 'gemini', rank: 2, modelFlag: '--model' }, procNames: ['gemini'],
  },
  {
    id: 'opencode', label: 'OpenCode', doc: 'harnesses/opencode.md',
    nativeDir: '.opencode',
    launch: { key: 'open-code', cmd: 'opencode', rank: 4, label: 'Open Code' }, procNames: ['opencode'],
  },
  {
    id: 'aider', label: 'Aider', doc: 'harnesses/aider.md',
    launch: { key: 'aider', cmd: 'aider', rank: 5, modelFlag: '--model' }, procNames: ['aider'],
  },
  {
    id: 'cursor', label: 'Cursor', doc: 'harnesses/cursor.md',
    nativeDir: '.cursor',
    launch: { key: 'cursor', cmd: 'cursor', rank: 7 }, procNames: ['cursor'],
  },
  {
    id: 'continue', label: 'Continue', doc: 'harnesses/continue-dev.md',
    nativeDir: '.continue/sessions',
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

/** Directory names under `~/.<name>/unfirehose` that are ours or have their own reader, not native harnesses. */
export const NOT_NATIVE_DIRS = new Set(['unfirehose', 'claude', 'fetch']);

// Model discovery per harness.
//
// Dispatching work means picking WHERE it runs (target node) and WHAT runs it
// (harness). The third choice — which model — was missing, so every uncloseai
// dispatch silently took that harness's default. uncloseai-cli reaches 469
// models across local GPUs, OpenRouter, Nous and Grok; choosing among them is
// the whole point of the Prime Mission, since a task that a local Qwen can do
// should not spend Claude tokens.
//
// Each harness enumerates its own models its own way, so this file holds one
// adapter per harness: how to ask, and how to read the answer. Parsing lives
// here (pure, testable); running the command lives in the API route.

export interface HarnessModel {
  /** Model id to pass back to the harness, e.g. `qwen/qwen3.8-27b`. */
  id: string;
  /** 1-based index as the harness printed it, when it numbers its list. */
  index?: number;
  /** Providers that serve it, e.g. ['openrouter', 'nous']. */
  providers: string[];
  /** The harness's current default — what runs when no model is passed. */
  active: boolean;
  /** Served from our own hardware, so it costs electricity rather than money. */
  local: boolean;
}

/**
 * Provider labels that mean our own inference servers.
 *
 * uncloseai-cli names providers by endpoint key, and two of them are fox's
 * boxes: `qwen` (4090) and `hermes` (3090). Everything else — openrouter,
 * nous, grok — bills money. Measured 2026-08-25 across 469 models: 417
 * openrouter, 372 nous, 12 grok, 1 qwen, 1 hermes.
 *
 * This is what lets a dispatch UI say which choice is free.
 */
export const SELF_HOSTED_PROVIDERS = new Set(['qwen', 'hermes', 'ollama', 'local']);

export function isLocalProviderSet(providers: string[]): boolean {
  return providers.some((p) => SELF_HOSTED_PROVIDERS.has(p.toLowerCase()));
}

export interface HarnessModelAdapter {
  harness: string;
  /** Command + args that print the model list. */
  command: (bin: string) => string[];
  parse: (stdout: string) => HarnessModel[];
  /**
   * Flag used to pin a model when dispatching, as [flag, value].
   * Undefined means this harness takes no model argument.
   */
  modelFlag?: string;
}

/**
 * `unclose --list-models` prints one model per line:
 *
 *     1. ● Lorbus/Qwen3.6-27B-int4-AutoRound  [qwen+hermes]
 *     2. ○ grok-4.20-0309-non-reasoning  [grok]
 *    16. ○ stealth/ox-alpha  [openrouter+nous]
 *
 * ● marks the harness's CURRENT model, not a local one — upstream writes
 * `mark = '●' if m == UNCLOSE_MODEL else '○'`, so exactly one line carries it.
 * Whether a model is self-hosted comes from its providers instead.
 *
 * A `~` prefix on the id marks an alias (`~z-ai/glm-latest`) and is kept as
 * printed, because that is the string the harness accepts back.
 */
export function parseUncloseModels(stdout: string): HarnessModel[] {
  const out: HarnessModel[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\.\s+(●|○)\s+(\S+)(?:\s+\[([^\]]*)\])?\s*$/.exec(line);
    if (!m) continue;
    const [, idx, marker, id, provs] = m;
    const providers = (provs ?? '').split('+').map((s) => s.trim()).filter(Boolean);
    out.push({
      id,
      index: Number(idx),
      providers,
      active: marker === '●',
      local: isLocalProviderSet(providers),
    });
  }
  return out;
}

/** `ollama list` prints a header row then `NAME  ID  SIZE  MODIFIED`. */
export function parseOllamaModels(stdout: string): HarnessModel[] {
  const out: HarnessModel[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || /^NAME\s/i.test(line)) continue;
    const id = line.split(/\s+/)[0];
    if (!id) continue;
    out.push({ id, providers: ['ollama'], active: false, local: true });
  }
  return out;
}

export const HARNESS_MODEL_ADAPTERS: Record<string, HarnessModelAdapter> = {
  uncloseai: {
    harness: 'uncloseai',
    command: (bin) => [bin, '--list-models'],
    parse: parseUncloseModels,
    modelFlag: '--model',
  },
  ollama: {
    harness: 'ollama',
    command: (bin) => [bin, 'list'],
    parse: parseOllamaModels,
  },
};

/**
 * Claude Code takes `--model`, but has no command that enumerates what an
 * account may call, so this list is maintained here. Ids match the Anthropic
 * API and our PRICING keys.
 */
export const CLAUDE_MODELS: HarnessModel[] = [
  { id: 'claude-fable-5',   providers: ['anthropic'], active: false, local: false },
  { id: 'claude-opus-5',    providers: ['anthropic'], active: false, local: false },
  { id: 'claude-sonnet-5',  providers: ['anthropic'], active: false, local: false },
  { id: 'claude-haiku-4-5', providers: ['anthropic'], active: false, local: false },
];

/**
 * Every harness a dispatch surface can offer, and the command that starts it.
 *
 * One list, because there were three: the project page offered twelve, the
 * permacomputer bootstrap panel offered two, and the todos page offered none
 * and always ran claude. A harness you cannot pick is a harness you cannot use.
 *
 * `cmd` is the installed executable. uncloseai-cli is `unclose` — its console
 * scripts are `unclose` and `uncloseai-cli`, never `uncloseai`, which is what
 * the project page used to send and what therefore never started.
 */
export interface HarnessChoice {
  value: string;
  label: string;
  cmd: string;
}

export const HARNESSES: HarnessChoice[] = [
  { value: 'claude',    label: 'Claude Code',   cmd: 'claude' },
  { value: 'uncloseai', label: 'uncloseai-cli', cmd: 'unclose' },
  { value: 'gemini',    label: 'Gemini CLI',    cmd: 'gemini' },
  { value: 'codex',     label: 'Codex CLI',     cmd: 'codex' },
  { value: 'open-code', label: 'Open Code',     cmd: 'opencode' },
  { value: 'aider',     label: 'Aider',         cmd: 'aider' },
  { value: 'agnt',      label: 'agnt',          cmd: 'agnt' },
  { value: 'cursor',    label: 'Cursor',        cmd: 'cursor' },
  { value: 'continue',  label: 'Continue',      cmd: 'continue' },
  { value: 'ollama',    label: 'Ollama',        cmd: 'ollama' },
  { value: 'fetch',     label: 'Fetch',         cmd: 'fetch' },
  { value: 'custom',    label: 'Custom...',     cmd: '' },
];

/** Executable for a harness key, or the custom command when one is given. */
export function harnessCommand(harness: string, customCmd?: string): string {
  if (harness === 'custom') return (customCmd ?? '').trim() || 'claude';
  return HARNESSES.find((h) => h.value === harness)?.cmd ?? 'claude';
}

/** Harnesses that accept a model argument, and the flag they use. */
export const HARNESS_MODEL_FLAGS: Record<string, string> = {
  uncloseai: '--model',
  claude: '--model',
  gemini: '--model',
  codex: '--model',
  aider: '--model',
  ollama: '',   // model is a positional arg, not a flag
};

/**
 * How a harness is handed its task, and how it is asked to stay open.
 *
 * uncloseai-cli takes the prompt as a positional argument or, better for
 * anything multi-line, from a file with `-f`. Given NEITHER a prompt nor
 * `-i`, it prints help and exits 1 — so a dispatch that forgets the prompt
 * does not start an idle agent, it starts nothing at all, and the tmux
 * window dies with usage text in it.
 */
export interface HarnessInvocation {
  /** Flag that reads the prompt from a file, when the harness has one. */
  promptFileFlag?: string;
  /** Flag that keeps the harness in a REPL when no task was given. */
  interactiveFlag?: string;
}

export const HARNESS_INVOCATION: Record<string, HarnessInvocation> = {
  uncloseai: { promptFileFlag: '-f', interactiveFlag: '-i' },
};

/**
 * Append the task to a harness command.
 *
 * `promptFile` is a path we have already written. With no prompt, a harness
 * that has an interactive flag gets it, so the window stays usable instead
 * of exiting on usage text.
 */
export function withPromptArg(
  parts: string[],
  harness: string,
  promptFile: string | null,
): string[] {
  const inv = HARNESS_INVOCATION[harness];
  if (!inv) return parts;
  if (promptFile && inv.promptFileFlag) return [...parts, inv.promptFileFlag, promptFile];
  if (!promptFile && inv.interactiveFlag) return [...parts, inv.interactiveFlag];
  return parts;
}

export function supportsModelSelection(harness: string): boolean {
  return harness in HARNESS_MODEL_FLAGS;
}

/**
 * Append a model selection to a harness command.
 * Returns the parts unchanged when the harness takes no model, or no model
 * was chosen — dispatching then keeps whatever default the harness has.
 */
export function withModelArg(
  parts: string[],
  harness: string,
  model: string | null | undefined,
): string[] {
  if (!model) return parts;
  if (!(harness in HARNESS_MODEL_FLAGS)) return parts;
  const flag = HARNESS_MODEL_FLAGS[harness];
  return flag ? [...parts, flag, model] : [...parts, model];
}

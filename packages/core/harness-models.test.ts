import { describe, it, expect } from 'vitest';
import {
  parseUncloseModels,
  parseOllamaModels,
  withModelArg,
  supportsModelSelection,
  isLocalProviderSet,
  HARNESS_MODEL_ADAPTERS,
} from './harness-models.js';

// Verbatim from `unclose --list-models` on 2026-08-25 (469 models total).
const UNCLOSE_OUT = [
  '    1. ● Lorbus/Qwen3.6-27B-int4-AutoRound  [qwen+hermes]',
  '    2. ○ grok-4.20-0309-non-reasoning  [grok]',
  '   14. ○ meta/muse-spark-1.2-contributor  [openrouter+nous]',
  '   16. ○ stealth/ox-alpha  [openrouter+nous]',
  '   19. ○ ~z-ai/glm-latest  [openrouter+nous]',
  '   22. ○ qwen/qwen3.8-27b  [openrouter+nous]',
  '',
].join('\n');

describe('parseUncloseModels', () => {
  const models = parseUncloseModels(UNCLOSE_OUT);

  it('reads every numbered line', () => {
    expect(models).toHaveLength(6);
    expect(models.map((m) => m.index)).toEqual([1, 2, 14, 16, 19, 22]);
  });

  it('keeps the id exactly as printed, alias prefix included', () => {
    // `~z-ai/glm-latest` is the string the harness accepts back; normalizing
    // it would produce a model id that does not resolve.
    expect(models.find((m) => m.index === 19)!.id).toBe('~z-ai/glm-latest');
  });

  it('splits providers on +', () => {
    expect(models[0].providers).toEqual(['qwen', 'hermes']);
    expect(models.find((m) => m.index === 16)!.providers).toEqual(['openrouter', 'nous']);
  });

  it('reads ● as the harness current model, not as local', () => {
    // Upstream: `mark = '●' if m == UNCLOSE_MODEL else '○'` — exactly one.
    expect(models.filter((m) => m.active)).toHaveLength(1);
    expect(models.find((m) => m.active)!.id).toBe('Lorbus/Qwen3.6-27B-int4-AutoRound');
  });

  it('derives local from providers, not from the marker', () => {
    expect(models[0].local).toBe(true);                                   // qwen+hermes
    expect(models.find((m) => m.index === 22)!.local).toBe(false);        // qwen/… but served by openrouter
    expect(models.find((m) => m.index === 2)!.local).toBe(false);         // grok
  });

  it('does not confuse a cloud-hosted Qwen with our own', () => {
    // `qwen/qwen3.8-27b [openrouter+nous]` is a hosted product; the provider
    // list is what distinguishes it from the Qwen on our 4090.
    const hosted = models.find((m) => m.id === 'qwen/qwen3.8-27b')!;
    expect(hosted.local).toBe(false);
  });

  it('ignores blank and non-matching lines', () => {
    expect(parseUncloseModels('\n\nsome banner text\n')).toEqual([]);
  });

  it('survives a model with no provider bracket', () => {
    const m = parseUncloseModels('   7. ○ some/model');
    expect(m).toHaveLength(1);
    expect(m[0].providers).toEqual([]);
  });
});

describe('isLocalProviderSet', () => {
  it('treats our own inference servers as local', () => {
    expect(isLocalProviderSet(['qwen'])).toBe(true);
    expect(isLocalProviderSet(['hermes'])).toBe(true);
    expect(isLocalProviderSet(['ollama'])).toBe(true);
  });
  it('treats billed providers as remote', () => {
    expect(isLocalProviderSet(['openrouter', 'nous'])).toBe(false);
    expect(isLocalProviderSet(['grok'])).toBe(false);
    expect(isLocalProviderSet([])).toBe(false);
  });
});

describe('parseOllamaModels', () => {
  it('skips the header and takes the first column', () => {
    const out = [
      'NAME                 ID           SIZE   MODIFIED',
      'qwen3:27b            abc123       17 GB  2 days ago',
      'llama3.1:8b          def456       4.7 GB 1 week ago',
    ].join('\n');
    expect(parseOllamaModels(out).map((m) => m.id)).toEqual(['qwen3:27b', 'llama3.1:8b']);
    expect(parseOllamaModels(out).every((m) => m.local)).toBe(true);
  });
});

describe('withModelArg', () => {
  it('pins a model on a harness that takes a flag', () => {
    expect(withModelArg(['unclose'], 'uncloseai', 'qwen/qwen3.8-27b'))
      .toEqual(['unclose', '--model', 'qwen/qwen3.8-27b']);
  });

  it('passes a positional model for ollama', () => {
    expect(withModelArg(['ollama', 'run'], 'ollama', 'qwen3:27b'))
      .toEqual(['ollama', 'run', 'qwen3:27b']);
  });

  it('leaves the command alone when no model was chosen', () => {
    expect(withModelArg(['unclose'], 'uncloseai', '')).toEqual(['unclose']);
    expect(withModelArg(['unclose'], 'uncloseai', null)).toEqual(['unclose']);
  });

  it('leaves the command alone for a harness that takes no model', () => {
    expect(withModelArg(['aider-alike'], 'unknown-harness', 'x')).toEqual(['aider-alike']);
  });

  it('reports which harnesses accept a model', () => {
    expect(supportsModelSelection('uncloseai')).toBe(true);
    expect(supportsModelSelection('claude')).toBe(true);
    expect(supportsModelSelection('cursor')).toBe(false);
  });
});

describe('adapters', () => {
  it('asks uncloseai for its list with the binary it was given', () => {
    expect(HARNESS_MODEL_ADAPTERS.uncloseai.command('uncloseai-cli'))
      .toEqual(['uncloseai-cli', '--list-models']);
  });
});

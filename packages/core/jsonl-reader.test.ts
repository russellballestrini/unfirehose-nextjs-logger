import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

// Mock createReadStream to return a Readable from string content
let mockFileContent = '';
vi.mock('fs', () => ({
  createReadStream: () => Readable.from([mockFileContent]),
}));

const { streamJsonl, collectJsonl, createJsonlReadableStream } = await import('./jsonl-reader');

function setFileContent(lines: (object | string)[]) {
  mockFileContent = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
}

beforeEach(() => {
  mockFileContent = '';
});

describe('streamJsonl', () => {
  it('yields parsed JSON objects from valid JSONL lines', async () => {
    setFileContent([
      { type: 'user', message: 'hello' },
      { type: 'assistant', message: 'hi' },
    ]);
    const results = [];
    for await (const entry of streamJsonl('/fake/path.jsonl')) {
      results.push(entry);
    }
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ type: 'user', message: 'hello' });
  });

  it('skips empty lines', async () => {
    mockFileContent = '{"type":"user"}\n\n\n{"type":"assistant"}\n';
    const results = [];
    for await (const entry of streamJsonl('/fake/path.jsonl')) {
      results.push(entry);
    }
    expect(results).toHaveLength(2);
  });

  it('skips malformed JSON lines without throwing', async () => {
    mockFileContent = '{"valid":true}\nnot json\n{"also":"valid"}';
    const results = [];
    for await (const entry of streamJsonl('/fake/path.jsonl')) {
      results.push(entry);
    }
    expect(results).toHaveLength(2);
  });

  it('respects the offset option', async () => {
    setFileContent([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const results = [];
    for await (const entry of streamJsonl('/fake', { offset: 1 })) {
      results.push(entry);
    }
    expect(results).toHaveLength(2);
    expect((results[0] as { n: number }).n).toBe(2);
  });

  it('respects the limit option', async () => {
    setFileContent([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const results = [];
    for await (const entry of streamJsonl('/fake', { limit: 2 })) {
      results.push(entry);
    }
    expect(results).toHaveLength(2);
  });

  it('filters by types array', async () => {
    setFileContent([
      { type: 'user', text: 'hi' },
      { type: 'system', subtype: 'init' },
      { type: 'assistant', text: 'hello' },
    ]);
    const results = [];
    for await (const entry of streamJsonl('/fake', { types: ['user', 'assistant'] })) {
      results.push(entry);
    }
    expect(results).toHaveLength(2);
  });

  it('applies custom filter function', async () => {
    setFileContent([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const results = [];
    for await (const entry of streamJsonl('/fake', {
      filter: (line) => (line as { n: number }).n > 1,
    })) {
      results.push(entry);
    }
    expect(results).toHaveLength(2);
  });

  it('yields nothing for empty file content', async () => {
    mockFileContent = '';
    const results = [];
    for await (const entry of streamJsonl('/fake')) {
      results.push(entry);
    }
    expect(results).toHaveLength(0);
  });
});

describe('collectJsonl', () => {
  it('collects all entries into an array', async () => {
    setFileContent([{ a: 1 }, { b: 2 }]);
    const results = await collectJsonl('/fake');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ a: 1 });
  });

  it('returns empty array for empty file', async () => {
    mockFileContent = '';
    const results = await collectJsonl('/fake');
    expect(results).toHaveLength(0);
  });
});

describe('createJsonlReadableStream', () => {
  it('returns a ReadableStream that emits NDJSON', async () => {
    setFileContent([{ x: 1 }, { x: 2 }]);
    const stream = createJsonlReadableStream('/fake');
    const reader = stream.getReader();

    const decoder = new TextDecoder();
    const chunks: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const combined = chunks.join('');
    expect(combined).toContain('{"x":1}');
    expect(combined).toContain('{"x":2}');
  });
});

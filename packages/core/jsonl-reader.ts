import { createReadStream } from 'fs';
import { createInterface } from 'readline';

export interface StreamOptions {
  offset?: number;
  limit?: number;
  filter?: (line: Record<string, unknown>) => boolean;
  types?: string[];
}

export async function* streamJsonl<T = Record<string, unknown>>(
  filePath: string,
  options: StreamOptions = {}
): AsyncGenerator<T> {
  const { offset = 0, limit = Infinity, filter, types } = options;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let matched = 0;
  let emitted = 0;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line);

        if (types && !types.includes(parsed.type ?? '')) continue;
        if (filter && !filter(parsed)) continue;

        matched++;
        if (matched <= offset) continue;

        yield parsed as T;
        emitted++;

        if (emitted >= limit) {
          break;
        }
      } catch {
        // skip malformed lines
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function collectJsonl<T = Record<string, unknown>>(
  filePath: string,
  options: StreamOptions = {}
): Promise<T[]> {
  const results: T[] = [];
  for await (const entry of streamJsonl<T>(filePath, options)) {
    results.push(entry);
  }
  return results;
}

export function createJsonlReadableStream(
  filePath: string,
  options: StreamOptions = {}
): ReadableStream {
  const encoder = new TextEncoder();
  let generator: AsyncGenerator | null = null;

  return new ReadableStream({
    async start() {
      generator = streamJsonl(filePath, options);
    },
    async pull(controller) {
      if (!generator) {
        controller.close();
        return;
      }
      const { done, value } = await generator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
    },
    cancel() {
      generator?.return(undefined);
    },
  });
}

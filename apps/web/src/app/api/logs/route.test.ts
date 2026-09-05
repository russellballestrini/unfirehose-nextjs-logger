import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from '@unturf/unfirehose/test/db-helper';

/**
 * Every message we have, filtered.
 *
 * This is the query behind our all-logs page and the one CLAUDE.md tells
 * people to curl. Its filters were nine separate accumulations onto a
 * string, written twice — once for the rows and once for the count under
 * the pager. Two WHERE clauses that must produce identical results is a
 * defect waiting for the day somebody edits one; these tests are what make
 * the single clause safe to rely on.
 *
 * A real SQLite database, because what is under test is SQL. Mocking the
 * driver would assert the shape of a string nobody ever ran.
 */

const db = createTestDb();
try { db.exec('ALTER TABLE sessions ADD COLUMN display_name TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN is_sidechain INTEGER'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE messages ADD COLUMN is_sidechain INTEGER'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE messages ADD COLUMN subtype TEXT'); } catch { /* already exists */ }

vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const { GET } = await import('./route');

const get = async (query = '') => {
  const res = await GET(new NextRequest(new URL(`/api/logs${query}`, 'http://localhost:3000')));
  return { status: res.status, body: await res.json() };
};
/**
 * The previews that came back. A preview concatenates a message's blocks,
 * so these are matched by substring rather than by equality.
 */
const previews = async (query = '') => (await get(query)).body.entries.map((e: { preview: string }) => e.preview);
const has = async (query: string, text: string) => (await previews(query)).some((p: string) => p.includes(text));
const only = async (query: string, texts: string[]) => {
  const out = await previews(query);
  expect(out).toHaveLength(texts.length);
  for (const t of texts) expect(out.some((p: string) => p.includes(t)), t).toBe(true);
};

beforeAll(() => {
  const pid = seedProject(db, 'alpha', 'Alpha');
  const other = seedProject(db, 'beta', 'Beta');
  const sid = seedSession(db, pid, 'sess-1');
  const sid2 = seedSession(db, other, 'sess-2');

  const say = (session: number, type: string, ts: string, text: string, opts: Record<string, unknown> = {}) => {
    const mid = seedMessage(db, session, { type, timestamp: ts, ...opts });
    seedContentBlock(db, mid, { blockType: 'text', textContent: text });
    return mid;
  };

  say(sid, 'user', '2026-03-01T10:00:00Z', 'ask alpha');
  say(sid, 'assistant', '2026-03-02T10:00:00Z', 'answer alpha');
  say(sid, 'system', '2026-03-03T10:00:00Z', 'system alpha');
  say(sid2, 'user', '2026-03-04T10:00:00Z', 'ask beta');

  // A message carrying a reasoning block as well as its text.
  const thought = say(sid, 'assistant', '2026-03-05T10:00:00Z', 'considered answer');
  seedContentBlock(db, thought, { position: 1, blockType: 'reasoning', textContent: 'weighing it up' });

  // The pre-rename spelling, which legacy rows still carry.
  const legacy = say(sid, 'assistant', '2026-03-06T10:00:00Z', 'legacy answer');
  seedContentBlock(db, legacy, { position: 1, blockType: 'thinking', textContent: 'old spelling' });

  // A sealed reasoning block: signature only, no readable text. It must not
  // count as thinking, or every opus-4-7 message matches the filter.
  const sealed = say(sid, 'assistant', '2026-03-07T10:00:00Z', 'sealed answer');
  seedContentBlock(db, sealed, { position: 1, blockType: 'reasoning', textContent: '' });

  // A subagent's message.
  db.prepare('UPDATE messages SET is_sidechain = 1 WHERE id = ?')
    .run(say(sid, 'assistant', '2026-03-08T10:00:00Z', 'subagent answer'));

  say(sid, 'assistant', '2026-03-09T10:00:00Z', 'a 100% match');

  // One message whose text AND reasoning both match a single term. Joining
  // content_blocks multiplies a message by its blocks, so without DISTINCT
  // this row comes back twice and the count over-reports by one.
  const twice = say(sid, 'assistant', '2026-03-10T10:00:00Z', 'duplicable thought');
  seedContentBlock(db, twice, { position: 1, blockType: 'reasoning', textContent: 'duplicable reasoning' });
});

describe('what comes back by default', () => {
  it('returns every type, newest first', async () => {
    const { body } = await get();
    expect(body.entries.length).toBeGreaterThan(5);
    const times = body.entries.map((e: { timestamp: string }) => e.timestamp);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('names the project and session each row belongs to', async () => {
    const { body } = await get('?limit=1&project=alpha');
    expect(body.entries[0]).toMatchObject({ projectName: 'alpha', sessionUuid: 'sess-1', projectDisplay: 'Alpha' });
  });
});

describe('filtering', () => {
  it('narrows to one project', async () => {
    await only('?project=beta', ['ask beta']);
  });

  it('narrows to one session', async () => {
    await only('?session=sess-2', ['ask beta']);
  });

  it('narrows to one type', async () => {
    await only('?types=user', ['ask beta', 'ask alpha']);
  });

  it('narrows to several types at once', async () => {
    expect(await has('?types=user,system', 'system alpha')).toBe(true);
    expect(await has('?types=user,system', 'ask alpha')).toBe(true);
    expect(await has('?types=user,system', 'answer alpha')).toBe(false);
  });

  it('applies no type filter at all when every type is asked for', async () => {
    // The default. Listing all three in an IN clause would be the same
    // answer for more work, on the largest table we have.
    const all = await previews('?types=user,assistant,system');
    expect(all).toEqual(await previews());
  });

  it('filters from a date, inclusive', async () => {
    expect(await has('?from=2026-03-08T10:00:00Z', 'subagent answer')).toBe(true);
    expect(await has('?from=2026-03-08T10:00:00Z', 'sealed answer')).toBe(false);
  });

  it('treats a bare end date as the whole of that day', async () => {
    // `to=2026-03-02` must include 2026-03-02T10:00:00Z. Comparing against
    // the bare date excludes everything after midnight — which is the whole
    // day, so the last day of any range silently vanishes.
    expect(await has('?to=2026-03-02', 'answer alpha')).toBe(true);
    expect(await has('?to=2026-03-02', 'system alpha')).toBe(false);
  });

  it('combines filters rather than letting the last one win', async () => {
    await only('?project=alpha&types=user', ['ask alpha']);
  });
});

describe('sidechain', () => {
  it('shows both by default', async () => {
    expect(await has('', 'subagent answer')).toBe(true);
  });

  it('shows only subagent messages when asked', async () => {
    await only('?sidechain=true', ['subagent answer']);
    await only('?sidechain=1', ['subagent answer']);
  });

  it('shows only top-level messages when asked', async () => {
    for (const q of ['?sidechain=false', '?sidechain=0']) {
      expect(await has(q, 'subagent answer'), q).toBe(false);
      expect(await has(q, 'answer alpha'), q).toBe(true);
    }
  });

  it('accepts either case', async () => {
    await only('?sidechain=TRUE', ['subagent answer']);
  });

  it('shows both for a value it does not recognise', async () => {
    // An unknown value must not silently mean "top-level only" — that
    // hides subagent work without saying so.
    expect(await has('?sidechain=maybe', 'subagent answer')).toBe(true);
  });
});

describe('reasoning', () => {
  it('finds messages carrying a reasoning block', async () => {
    expect(await has('?has_thinking=true', 'considered answer')).toBe(true);
    expect(await has('?has_thinking=true', 'answer alpha')).toBe(false);
  });

  it('finds the pre-rename spelling too', async () => {
    // Legacy rows are never rewritten, and Claude Code reaps its transcripts
    // after thirty days, so re-ingesting them is not an option. Both
    // spellings match forever.
    expect(await has('?has_thinking=true', 'legacy answer')).toBe(true);
  });

  it('does not count a sealed block with no readable text', async () => {
    // opus-4-7 ships reasoning as a signature with an empty body. Counting
    // those makes the filter match nearly every assistant message.
    expect(await has('?has_thinking=true', 'sealed answer')).toBe(false);
  });
});

describe('search', () => {
  it('finds a message by its text', async () => {
    await only('?search=subagent', ['subagent answer']);
  });

  it('searches reasoning as well as text', async () => {
    await only('?search=weighing', ['considered answer']);
  });

  it('returns each message once however many blocks matched', async () => {
    // Joining content_blocks multiplies a message by its blocks. Without
    // DISTINCT, a message whose text and reasoning both match appears twice.
    const { body } = await get('?search=duplicable');
    const ids = body.entries.map((e: { id: number }) => e.id);
    expect(ids).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds nothing rather than everything for a term that is not there', async () => {
    expect(await previews('?search=zzzzz')).toEqual([]);
  });
});

describe('paging', () => {
  it('caps how much can be asked for at once', async () => {
    // The page offers 1000. Without a ceiling a hand-written request can
    // ask for the whole table and hold a worker while SQLite reads it.
    const { body } = await get('?limit=99999');
    expect(body.limit).toBe(500);
  });

  it('takes an offset', async () => {
    const first = await previews('?limit=2');
    const second = await previews('?limit=2&offset=2');
    expect(second[0]).not.toBe(first[0]);
    expect(first).toHaveLength(2);
  });

  it('counts the same set the rows came from', async () => {
    // The count and the rows were built from two hand-kept copies of one
    // clause. When they disagree the pager describes a different set of
    // messages than the ones on screen.
    const { body } = await get('?limit=1&types=user');
    expect(body.total).toBe(2);
  });

  it('counts a filtered set, not the whole table', async () => {
    const { body } = await get('?limit=1&project=beta');
    expect(body.total).toBe(1);
  });

  it('counts a search the same way it lists it', async () => {
    // Both the rows and the count go through the join, so both must count
    // one message once however many of its blocks matched.
    const { body } = await get('?limit=1&search=duplicable');
    expect(body.total).toBe(1);
  });

  it('does not pay for a count it does not need', async () => {
    // A first page that came back short is the whole answer; counting again
    // is a second full scan for a number we already have.
    const { body } = await get('?limit=500');
    expect(body.total).toBe(body.entries.length);
  });
});

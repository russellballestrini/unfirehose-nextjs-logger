import { describe, it, expect } from 'vitest';
import { createTestDb, seedProject, seedSession } from '@unturf/unfirehose/test/db-helper';
import { hasAny } from './ever';

describe('hasAny', () => {
  it('is false on a fresh database and true once a row lands', () => {
    const db = createTestDb();
    expect(hasAny(db, 'sessions')).toBe(false);
    seedSession(db, seedProject(db, 'p'), 's1');
    expect(hasAny(db, 'sessions')).toBe(true);
    // Another table is still a first run of its own.
    expect(hasAny(db, 'messages')).toBe(false);
  });

  it('reads a missing table as never rather than throwing', () => {
    const db = { prepare: () => { throw new Error('no such table'); } };
    expect(hasAny(db, 'mesh_snapshots')).toBe(false);
  });

  it('refuses a name outside its list, so nothing else reaches the SQL', () => {
    const db = { prepare: () => ({ get: () => ({ 1: 1 }) }) };
    expect(hasAny(db, 'sessions; DROP TABLE x' as never)).toBe(false);
  });
});

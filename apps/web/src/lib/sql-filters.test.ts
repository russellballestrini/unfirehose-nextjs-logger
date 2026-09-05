import { describe, it, expect } from 'vitest';
import { buildWhere, inClause, likeClause } from './sql-filters';

/**
 * Building a WHERE clause from query parameters.
 *
 * Five routes now share this. What matters most is the pairing: a clause
 * and the values that fill it are one entry, so a filter cannot be added to
 * the SQL and forgotten in the parameters. That mistake does not throw — it
 * binds the wrong value to the wrong placeholder and returns a plausible
 * wrong answer.
 */

describe('buildWhere', () => {
  it('returns the base alone when nothing applies', () => {
    expect(buildWhere('1=1', [])).toEqual({ where: '1=1', params: [] });
  });

  it('ANDs each clause onto the base', () => {
    const { where } = buildWhere('1=1', [['a = ?', 1], ['b = ?', 2]]);
    expect(where).toBe('1=1 AND a = ? AND b = ?');
  });

  it('keeps values in the order their placeholders appear', () => {
    // This is the whole point. Out of order, every parameter binds to the
    // wrong column and the query answers plausibly rather than failing.
    const { params } = buildWhere('1=1', [['a = ?', 'first'], ['b = ?', 'second'], ['c = ?', 'third']]);
    expect(params).toEqual(['first', 'second', 'third']);
  });

  it('carries several values for one clause', () => {
    const { where, params } = buildWhere('1=1', [['a BETWEEN ? AND ?', 1, 9]]);
    expect(where).toBe('1=1 AND a BETWEEN ? AND ?');
    expect(params).toEqual([1, 9]);
  });

  it('skips a filter whose value was not supplied', () => {
    // A query string that omits `project` must not filter by project.
    const { where, params } = buildWhere('1=1', [['a = ?', null], ['b = ?', 'yes'], ['c = ?', undefined]]);
    expect(where).toBe('1=1 AND b = ?');
    expect(params).toEqual(['yes']);
  });

  it('treats an empty string as not supplied', () => {
    // `?project=` is what a cleared filter box sends. Filtering on '' finds
    // nothing, which reads as "no results" rather than "no filter".
    expect(buildWhere('1=1', [['a = ?', '']])).toEqual({ where: '1=1', params: [] });
  });

  it('keeps a filter for zero and for false', () => {
    // Both are values somebody asked for. `?limit=0` and `?archived=false`
    // must not silently become no filter at all.
    const { where, params } = buildWhere('1=1', [['a = ?', 0], ['b = ?', false]]);
    expect(where).toBe('1=1 AND a = ? AND b = ?');
    expect(params).toEqual([0, false]);
  });

  it('drops a whole clause when any one of its values is missing', () => {
    // A half-filled clause would bind one value to two placeholders and
    // shift every parameter after it.
    const { where, params } = buildWhere('1=1', [['a BETWEEN ? AND ?', 1, null], ['b = ?', 2]]);
    expect(where).toBe('1=1 AND b = ?');
    expect(params).toEqual([2]);
  });

  it('takes a bare string as a clause with no parameters', () => {
    const { where, params } = buildWhere('1=1', ['a IS NOT NULL']);
    expect(where).toBe('1=1 AND a IS NOT NULL');
    expect(params).toEqual([]);
  });

  it('skips a lookup that found nothing', () => {
    // `TABLE[param]` for an unrecognised param. Falling through to no
    // filter is how an unknown value means "no opinion" without an else.
    const TABLE: Record<string, string | undefined> = { yes: 'a = 1' };
    expect(buildWhere('1=1', [TABLE.nope]).where).toBe('1=1');
    expect(buildWhere('1=1', [TABLE.yes]).where).toBe('1=1 AND a = 1');
  });

  it('honours a base that is not 1=1', () => {
    expect(buildWhere("status != 'deleted'", [['a = ?', 1]]).where)
      .toBe("status != 'deleted' AND a = ?");
  });
});

describe('inClause', () => {
  it('writes one placeholder per value', () => {
    expect(inClause('t.status', ['a', 'b', 'c'])).toEqual(['t.status IN (?,?,?)', 'a', 'b', 'c']);
  });

  it('handles a single value', () => {
    expect(inClause('t.status', ['a'])).toEqual(['t.status IN (?)', 'a']);
  });

  it('is absent for an empty list, rather than writing IN ()', () => {
    // `IN ()` is a syntax error in SQLite. An empty list means the caller
    // has nothing to narrow by, which is no filter.
    expect(inClause('t.status', [])).toBeNull();
    expect(buildWhere('1=1', [inClause('x', [])]).where).toBe('1=1');
  });
});

describe('likeClause', () => {
  it('wraps the term in wildcards', () => {
    expect(likeClause('t.content', 'auth')).toEqual([
      "t.content LIKE ? ESCAPE '\\'", '%auth%',
    ]);
  });

  it('is absent for an empty or whitespace-only term', () => {
    for (const term of ['', '   ', null, undefined]) {
      expect(likeClause('t.content', term)).toBeNull();
    }
  });

  it('trims the term, since a search box keeps trailing spaces', () => {
    expect(likeClause('c', '  auth  ')?.[1]).toBe('%auth%');
  });

  it('escapes a percent sign, so searching "100%" does not match everything', () => {
    // Unescaped, `%` inside the term is a wildcard: a search for 100%
    // matches every row, which reads as a broken filter rather than a
    // broken query.
    expect(likeClause('c', '100%')?.[1]).toBe('%100\\%%');
  });

  it('escapes an underscore, which matches any single character', () => {
    expect(likeClause('c', 'a_b')?.[1]).toBe('%a\\_b%');
  });

  it('escapes a backslash, so the escape character cannot be smuggled in', () => {
    expect(likeClause('c', 'a\\b')?.[1]).toBe('%a\\\\b%');
  });
});

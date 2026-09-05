/**
 * Building a WHERE clause from query parameters.
 *
 * Several of our routes accumulate filters the same way — a run of
 * `if (x) { where += ' AND col = ?'; params.push(x) }` — and the shape has
 * two problems beyond its length. The clause and its parameter are written
 * in separate statements, so a filter added to one and forgotten in the
 * other binds the wrong value to the wrong placeholder and returns a
 * plausible wrong answer rather than an error. And the set of filters a
 * route supports cannot be read anywhere: it has to be reconstructed by
 * following the accumulation down the function.
 *
 * Here a filter is one entry, clause and value side by side, and whether it
 * applies is decided by the value rather than by a branch at each site.
 * "A filter with nothing to filter on is not a filter" is stated once,
 * in `buildWhere`, instead of once per parameter.
 */

/**
 * One condition. A tuple carries placeholders and the values that fill
 * them; a bare string is a condition with none. Either is skipped when it
 * is absent, which is what a lookup that missed returns.
 */
export type Filter =
  | string
  | readonly [sql: string, ...values: unknown[]]
  | null
  | undefined;

/** A value a caller did not supply. Zero and false are values; these are not. */
const absent = (v: unknown) => v === undefined || v === null || v === '';

/**
 * Combine the filters that apply.
 *
 * An entry is skipped when it is absent, and a tuple is skipped when any of
 * its values is — `['p.name = ?', projectFilter]` reads as "filter by
 * project, when a project was named".
 *
 * The base is what a query with no filters means. `1=1` is the usual one:
 * it makes every condition an ` AND`, so no caller has to know whether it
 * is writing the first or the fifth.
 */
export function buildWhere(base: string, filters: Filter[]): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  let where = base;
  for (const f of filters) {
    if (absent(f)) continue;
    const [sql, ...values] = typeof f === 'string' ? [f] : f as readonly [string, ...unknown[]];
    if (values.some(absent)) continue;
    where += ` AND ${sql}`;
    params.push(...values);
  }
  return { where, params };
}

/** `col IN (?, ?, ?)` with its values. Absent when the list is empty. */
export function inClause(column: string, values: readonly unknown[]): Filter {
  return values.length === 0 ? null : [`${column} IN (${values.map(() => '?').join(',')})`, ...values];
}

/**
 * A LIKE over a search box.
 *
 * The wildcards go on here rather than at each call site, and `%` and `_`
 * inside the term are escaped: a search for "100%" without this matches
 * every row, which reads as a broken filter rather than a broken query.
 */
export function likeClause(column: string, term: string | null | undefined): Filter {
  const t = term?.trim();
  return t ? [`${column} LIKE ? ESCAPE '\\'`, `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`] : null;
}

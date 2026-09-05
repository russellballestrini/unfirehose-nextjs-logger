/**
 * Facts about sessions and todos, as SQL, written once.
 *
 * "A todo is open" appeared seventeen times across eight files, spelled
 * out as `status IN ('pending', 'in_progress')` each time. Adding a status
 * — blocked, say — would mean finding all seventeen, and the ones missed
 * would quietly answer a different question from the ones changed. The
 * same goes for how long a session has been idle, which two routes each
 * computed with their own copy of the same date arithmetic.
 *
 * These are fragments rather than whole queries on purpose: the routes
 * that use them select different columns and filter differently. What they
 * must agree on is what the words mean.
 */

/** The statuses a todo is in while it is still somebody's work. */
export const OPEN_TODO_STATUSES = ['pending', 'in_progress'] as const;

/** The statuses that mean nobody is working on it any more. */
export const CLOSED_TODO_STATUSES = ['completed', 'obsolete'] as const;

const quote = (values: readonly string[]) => `(${values.map((v) => `'${v}'`).join(', ')})`;

/** `IN ('pending', 'in_progress')` — drop in after a status column. */
export const OPEN_TODO_SQL = `IN ${quote(OPEN_TODO_STATUSES)}`;
export const CLOSED_TODO_SQL = `IN ${quote(CLOSED_TODO_STATUSES)}`;

/** True for a status already in hand, rather than in a query. */
export const isOpenTodo = (status: string): boolean =>
  (OPEN_TODO_STATUSES as readonly string[]).includes(status);

/**
 * Whole days since a session last did anything.
 *
 * last_message_at is null for a session that produced no messages, so it
 * falls back to updated_at — otherwise an empty session reads as infinitely
 * idle and is swept up by every staleness rule we have.
 */
export const INACTIVE_DAYS_SQL =
  "CAST(julianday('now') - julianday(COALESCE(s.last_message_at, s.updated_at)) AS INTEGER)";

/** How many messages a session holds. Correlated on `s`. */
export const MESSAGE_COUNT_SQL =
  '(SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id)';

/** How many of a session's todos are still open. Correlated on `s`. */
export const OPEN_TODO_COUNT_SQL =
  `(SELECT COUNT(*) FROM todos t WHERE t.session_id = s.id AND t.status ${OPEN_TODO_SQL})`;

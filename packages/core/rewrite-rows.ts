/**
 * What a rewrite looks like on the wire: the row `db/rewrite-watch.ts`
 * writes and `/api/sessions/rewrites` serves, and the summary beside it.
 *
 * Types only, so our live view's Rewrites tab (a client component) reads
 * the same shape as the ingester without importing its fs and sqlite.
 */

export type RewriteKind = 'rewritten' | 'truncated';

export interface RewriteRow {
  id: number;
  session_uuid: string;
  /** Null when the ingester could not tie the journal to a project or harness. */
  project: string | null;
  harness: string | null;
  seq: number;
  kind: RewriteKind;
  observed_at: string;
  file_lines: number;
  tail_distance: number;
  before_hash: string;
  after_hash: string | null;
  before_text: string;
  after_text: string | null;
  before_len: number;
  after_len: number | null;
  truncated: boolean;
  changed_keys: string[];
  content_changed: boolean;
  before_type: string | null;
  after_type: string | null;
}

export interface RewriteSummary {
  total: number;
  sessions: number;
  byHarness: Record<string, number>;
  maxTailDistance: number;
  contentChanged: number;
  metadataOnly: number;
  truncations: number;
  byChangedKey: Record<string, number>;
}

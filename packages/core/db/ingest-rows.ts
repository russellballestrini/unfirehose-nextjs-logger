// Row writers every ingest reader shares: sessions, messages, content
// blocks, usage minutes and providence Q&A pairs.
// Extracted from ingest.ts.
import { createHash } from 'crypto';
import type { getDb } from './schema';
import type { ClaudeApiRefusal } from '../claude-code-adapter';
import { recordHarnessRefusal } from './refusals';
import { sanitizePII } from '../pii';
import { generateSessionName } from '../session-name';
import { blockTextSql } from './block-cold';

// Block text may be cold (db/block-cold.ts).
const CB2_TEXT = blockTextSql('cb2');

/* eslint-disable @typescript-eslint/no-explicit-any */

export function getOrCreateSession(
  db: ReturnType<typeof getDb>,
  sessionUuid: string,
  projectId: number,
  meta: {
    gitBranch?: string;
    firstPrompt?: string;
    cliVersion?: string;
    createdAt?: string;
    isSidechain?: boolean;
    harness?: string;
    delegatedFrom?: string;
  }
): number {
  const existing = db
    .prepare('SELECT id FROM sessions WHERE session_uuid = ?')
    .get(sessionUuid) as { id: number } | undefined;
  if (existing) {
    // Backfill harness/delegated_from if not set
    if (meta.harness || meta.delegatedFrom) {
      db.prepare(
        'UPDATE sessions SET harness = COALESCE(harness, ?), delegated_from = COALESCE(delegated_from, ?) WHERE id = ?'
      ).run(meta.harness ?? null, meta.delegatedFrom ?? null, existing.id);
    }
    return existing.id;
  }

  // Sanitize PII from first prompt before storage
  const firstPrompt = meta.firstPrompt
    ? sanitizePII(meta.firstPrompt).sanitized
    : null;
  const displayName = generateSessionName(firstPrompt, sessionUuid);

  const result = db
    .prepare(
      `INSERT INTO sessions (session_uuid, project_id, git_branch, first_prompt, cli_version, created_at, is_sidechain, display_name, harness, delegated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionUuid,
      projectId,
      meta.gitBranch ?? null,
      firstPrompt,
      meta.cliVersion ?? null,
      meta.createdAt ?? null,
      meta.isSidechain ? 1 : 0,
      displayName,
      meta.harness ?? null,
      meta.delegatedFrom ?? null
    );
  return result.lastInsertRowid as number;
}

/**
 * Insert a message from unfirehose/1.0 format.
 * Expects: { type: "message", role, id, parentId, timestamp, subtype, durationMs, sidechain, model, usage }
 */
export function insertMessage(
  db: ReturnType<typeof getDb>,
  sessionId: number,
  entry: any
): number | null {
  const role = entry.role;
  if (!role || !['user', 'assistant', 'system'].includes(role)) return null;

  const usage = entry.usage;

  // Use INSERT OR IGNORE — the unique index on message_uuid handles dedup at DB level.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO messages (
        session_id, message_uuid, parent_uuid, type, subtype, timestamp,
        model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        duration_ms, is_sidechain, endpoint, provider, observed_cost_usd, tokens_approx
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      entry.id ?? null,
      entry.parentId ?? null,
      role,
      entry.subtype ?? null,
      entry.timestamp ?? null,
      entry.model ?? null,
      usage?.inputTokens ?? 0,
      usage?.outputTokens ?? 0,
      usage?.inputTokenDetails?.cacheReadTokens ?? 0,
      usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      entry.durationMs ?? null,
      entry.sidechain ? 1 : 0,
      entry.endpoint ?? null,
      entry.provider ?? null,
      // The gateway's own price for this call, when it quoted one. Undefined
      // stays NULL: unpriced is not free, and a computed estimate fills in
      // downstream rather than being frozen here as if it were an invoice.
      usage?.costUSD ?? null,
      // 1 when the counts came off a rounded display (Aider's "2.4k"); NULL
      // means they are what the harness reported.
      entry.tokensApprox ? 1 : null
    );

  // changes === 0 means the row was ignored (duplicate uuid)
  if (result.changes === 0) return null;
  const messageId = result.lastInsertRowid as number;

  // Claude Code reports a refused call on the message itself (see
  // classifyClaudeApiError). Record it here, at the one place every Claude
  // Code path inserts through, so a subagent's 529 counts the same as the
  // parent's. Anthropic is both provider and upstream: Claude Code calls
  // one API, so the route is known without the harness saying so.
  const refusal: ClaudeApiRefusal | null | undefined = entry.refusal;
  if (refusal) {
    recordHarnessRefusal(db, {
      sessionId,
      messageId,
      timestamp: entry.timestamp ?? null,
      kind: refusal.kind,
      provider: 'anthropic',
      upstream: 'anthropic',
      model: entry.model ?? null,
      httpStatus: refusal.status,
      detail: refusal.detail,
    });
  }
  return messageId;
}


/**
 * Insert content blocks from unfirehose/1.0 format.
 * Handles: text, reasoning, tool-call, tool-result, image
 */
export function insertContentBlocks(
  db: ReturnType<typeof getDb>,
  messageId: number,
  content: any[]
) {
  if (!Array.isArray(content)) return 0;

  const stmt = db.prepare(
    `INSERT INTO content_blocks (message_id, position, block_type, text_content, tool_name, tool_input, tool_use_id, is_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const piiStmt = db.prepare(
    `INSERT INTO pii_replacements (original_hash, token, pii_type, message_id) VALUES (?, ?, ?, ?)`
  );

  let count = 0;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block?.type) continue;

    let textContent: string | null = null;
    let toolName: string | null = null;
    let toolInput: string | null = null;
    let toolUseId: string | null = null;
    let isError = 0;

    switch (block.type) {
      case 'text':
        textContent = block.text ?? null;
        break;
      case 'reasoning':
        textContent = block.text ?? null;
        break;
      case 'tool-call':
        toolName = block.toolName ?? null;
        toolInput = block.input ? JSON.stringify(block.input) : null;
        toolUseId = block.toolCallId ?? null;
        break;
      case 'tool-result':
        textContent =
          typeof block.output === 'string'
            ? block.output
            : JSON.stringify(block.output);
        toolUseId = block.toolCallId ?? null;
        isError = block.isError ? 1 : 0;
        break;
      default:
        textContent = JSON.stringify(block);
        break;
    }

    // Sanitize PII from text content before storage
    if (textContent) {
      const { sanitized, replacements } = sanitizePII(textContent);
      if (replacements.length > 0) {
        textContent = sanitized;
        for (const r of replacements) {
          piiStmt.run(r.originalHash, r.token, r.piiType, messageId);
        }
      }
    }

    stmt.run(messageId, i, block.type, textContent, toolName, toolInput, toolUseId, isError);
    count++;
  }
  return count;
}

export function updateUsageMinutes(
  db: ReturnType<typeof getDb>,
  projectId: number,
  timestamp: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }
) {
  if (!timestamp) return;
  // Truncate to minute: "2026-03-03T14:30:45.123Z" -> "2026-03-03T14:30"
  const minute = timestamp.slice(0, 16);

  db.prepare(
    `INSERT INTO usage_minutes (minute, project_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(minute, project_id) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       message_count = message_count + 1`
  ).run(
    minute,
    projectId,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens
  );
}

// ── Providence extraction helpers ─────────────────────────────────────────────

/** SHA-256, first 16 hex chars — matches providence API cache_key format */
function sha256short(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Full SHA-256 hex — used for conversation_hash (same as ProvidenceCache Python SDK) */
function sha256full(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Extract Q&A pairs from a session and upsert into providence_cache.
 *
 * Pairs every user text message with the next assistant text response.
 * conversation_hash encodes all prior turns (full SHA-256 of [{role,content}...]).
 * document_root = sha256short(projectUri) — stable per project path.
 * Runs outside any transaction, after the session's batch insert completes.
 * Uses INSERT OR IGNORE so re-ingestion is idempotent; hit_count stays correct.
 */
export function extractProvidenceFromSession(
  db: ReturnType<typeof getDb>,
  sessionId: number,
  projectUri: string,     // project filesystem path, or project name as fallback
  sourceType: string,     // 'claude-code', 'uncloseai', harness name, etc.
): number {
  // Fetch all user/assistant messages with their text content for this session
  const rows = db.prepare(`
    SELECT m.id, m.type, m.model, m.duration_ms,
           (SELECT GROUP_CONCAT(${CB2_TEXT}, '\n\n')
            FROM content_blocks cb2
            WHERE cb2.message_id = m.id AND cb2.block_type = 'text'
              AND ${CB2_TEXT} IS NOT NULL AND ${CB2_TEXT} != ''
           ) AS text_content
    FROM messages m
    WHERE m.session_id = ? AND m.type IN ('user', 'assistant')
    ORDER BY m.timestamp ASC, m.id ASC
  `).all(sessionId) as Array<{
    id: number;
    type: string;
    model: string | null;
    duration_ms: number | null;
    text_content: string | null;
  }>;

  if (rows.length < 2) return 0;

  const documentRoot = sha256short(projectUri);
  const conversationSoFar: Array<{ role: string; content: string }> = [];
  let added = 0;

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO providence_cache (
      cache_key, document_root, document_uri, question_hash, question_text,
      model_id, conversation_hash,
      answer_text, merkle_proof,
      inference_ms, source_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
  `);

  const tx = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const text = row.text_content?.trim();
      if (!text) continue;

      if (row.type === 'user') {
        // Look ahead for the next assistant message
        const next = rows.slice(i + 1).find(r => r.type === 'assistant');
        const answerText = next?.text_content?.trim();

        if (answerText) {
          // conversation_hash = SHA-256 of all messages up to (and including) this user turn
          const convArray = [...conversationSoFar, { role: 'user', content: text }];
          const convHash = sha256full(JSON.stringify(convArray));
          const questionHash = sha256short(text);

          const keyMaterial = [
            documentRoot,
            questionHash,
            next?.model ?? '',
            '',  // model_revision
            '',  // quantization
            convHash,
            '',  // seed
          ].join(':');
          const cacheKey = sha256short(keyMaterial);

          const r = insertStmt.run(
            cacheKey,
            documentRoot,
            projectUri,
            questionHash,
            text,
            next?.model ?? '',
            convHash,
            answerText,
            next?.duration_ms ?? null,
            sourceType,
          );
          if (r.changes > 0) added++;
        }

        conversationSoFar.push({ role: 'user', content: text });
      } else if (row.type === 'assistant') {
        conversationSoFar.push({ role: 'assistant', content: text });
      }
    }
  });

  tx();
  return added;
}

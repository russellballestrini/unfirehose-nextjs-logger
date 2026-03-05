import { NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';
import { sanitizePII } from '@unfirehose/core/pii';

/**
 * POST /api/pii-backfill
 *
 * One-shot retroactive PII sanitization of existing content_blocks and session first_prompts.
 * Scans all text content, applies sanitizePII(), updates in-place, records replacements.
 * Safe to run multiple times (already-sanitized text won't match PII patterns).
 */
export async function POST() {
  try {
    const db = getDb();
    const BATCH = 1000;
    let totalBlocks = 0;
    let totalSessions = 0;
    let totalReplacements = 0;

    const updateBlock = db.prepare(
      'UPDATE content_blocks SET text_content = ? WHERE id = ?'
    );
    const insertPII = db.prepare(
      'INSERT INTO pii_replacements (original_hash, token, pii_type, message_id) VALUES (?, ?, ?, ?)'
    );

    // Scan content_blocks in batches
    let lastId = 0;
    while (true) {
      const rows = db.prepare(
        `SELECT cb.id, cb.message_id, cb.text_content FROM content_blocks cb
         WHERE cb.id > ? AND cb.text_content IS NOT NULL AND cb.text_content <> ''
         ORDER BY cb.id LIMIT ?`
      ).all(lastId, BATCH) as Array<{ id: number; message_id: number; text_content: string }>;

      if (rows.length === 0) break;

      const tx = db.transaction(() => {
        for (const row of rows) {
          const { sanitized, replacements } = sanitizePII(row.text_content);
          if (replacements.length > 0) {
            updateBlock.run(sanitized, row.id);
            for (const r of replacements) {
              insertPII.run(r.originalHash, r.token, r.piiType, row.message_id);
            }
            totalReplacements += replacements.length;
            totalBlocks++;
          }
        }
      });
      tx();

      lastId = rows[rows.length - 1].id;
    }

    // Scan session first_prompts
    const sessions = db.prepare(
      "SELECT id, first_prompt FROM sessions WHERE first_prompt IS NOT NULL AND first_prompt <> ''"
    ).all() as Array<{ id: number; first_prompt: string }>;

    const updateSession = db.prepare(
      'UPDATE sessions SET first_prompt = ? WHERE id = ?'
    );

    const sessionTx = db.transaction(() => {
      for (const sess of sessions) {
        const { sanitized, replacements } = sanitizePII(sess.first_prompt);
        if (replacements.length > 0) {
          updateSession.run(sanitized, sess.id);
          totalReplacements += replacements.length;
          totalSessions++;
        }
      }
    });
    sessionTx();

    return NextResponse.json({
      ok: true,
      blocksScanned: lastId,
      blocksModified: totalBlocks,
      sessionsModified: totalSessions,
      piiReplacementsAdded: totalReplacements,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'PII backfill failed', detail: String(err) },
      { status: 500 }
    );
  }
}

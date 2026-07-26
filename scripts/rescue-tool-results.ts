/**
 * Archive every tool-results spill file still on disk.
 *
 * Claude Code writes large tool outputs to
 * ~/.claude/projects/<project>/<session>/tool-results/<tool_use_id>.txt and
 * leaves only that path in the transcript. Those files are deleted on startup
 * once older than `cleanupPeriodDays` (30 days by default), which leaves an
 * archived message pointing at a payload that no longer exists.
 *
 * Regular ingest now archives spills as it walks each session, so this script
 * is only needed to sweep files that predate that change — or to force a pass
 * when ingest has been down. Idempotent: safe to re-run any time.
 *
 *   make rescue-tool-results
 */
import { readdirSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { getDb } from '@unturf/unfirehose/db/schema';
import { archiveToolResultsForSession } from '@unturf/unfirehose/db/ingest';

const PROJECTS = path.join(homedir(), '.claude', 'projects');

async function main() {
  if (!existsSync(PROJECTS)) {
    console.error(`no such directory: ${PROJECTS}`);
    process.exit(1);
  }

  const db = getDb();
  const result = { filesScanned: 0 };
  let sessionsWithSpills = 0;

  for (const project of readdirSync(PROJECTS)) {
    const projectDir = path.join(PROJECTS, project);
    if (!statSync(projectDir).isDirectory()) continue;

    for (const entry of readdirSync(projectDir)) {
      const sessionDir = path.join(projectDir, entry);
      if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) continue;
      if (!existsSync(path.join(sessionDir, 'tool-results'))) continue;

      sessionsWithSpills++;
      const before = result.filesScanned;
      await archiveToolResultsForSession(db, project, { sessionId: entry }, result);
      const added = result.filesScanned - before;
      if (added > 0) console.log(`  +${added}\t${project}/${entry}`);
    }
  }

  const row = db
    .prepare(
      'SELECT COUNT(*) c, COUNT(DISTINCT hash) blobs, COALESCE(SUM(size_bytes), 0) bytes FROM tool_results'
    )
    .get() as { c: number; blobs: number; bytes: number };

  console.log(`\nsessions with spills : ${sessionsWithSpills}`);
  console.log(`archived this run    : ${result.filesScanned}`);
  console.log(`rows in tool_results : ${row.c}`);
  console.log(`distinct blobs       : ${row.blobs}`);
  console.log(`archived total       : ${(row.bytes / 1048576).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

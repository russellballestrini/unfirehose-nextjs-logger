import { describe, it, expect, vi, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { createTestDb } from './test/db-helper';

vi.mock('./db/schema', () => ({ getDb: () => { throw new Error('our export reads the handle it is given'); } }));

const { seedDemo, DEMO_PROJECTS, DEMO_MODELS, DEMO_HARNESSES } = await import('./demo-seed');
const { getOrCreateSession, insertMessage } = await import('./db/ingest-rows');
const {
  exportTrainingSet, trainingExportLines, dryRunTrainingExport, emptyTrainingExportStats,
  parseTrainingExportQuery, resolveProjectId, SFT_EXAMPLE_JSON_SCHEMA,
} = await import('./training-export');
type Filters = import('./training-export').TrainingExportFilters;

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(SFT_EXAMPLE_JSON_SCHEMA);

function all(db: ReturnType<typeof createTestDb>, filters: Filters = {}) {
  const stats = emptyTrainingExportStats();
  const examples = [...exportTrainingSet(db, filters, stats)];
  return { examples, stats };
}

/** One session written row by row, blocks as raw SQL so nothing sanitizes them first. */
function addSession(
  db: ReturnType<typeof createTestDb>,
  projectId: number,
  uuid: string,
  lines: Array<{ role: 'user' | 'assistant'; model?: string; blocks: Array<Record<string, unknown>> }>,
  opts: { harness?: string; createdAt?: string } = {},
) {
  const sessionId = getOrCreateSession(db, uuid, projectId, { harness: opts.harness, createdAt: opts.createdAt ?? '2026-10-20T10:00:00.000Z' });
  const block = db.prepare(
    `INSERT INTO content_blocks (message_id, position, block_type, text_content, tool_name, tool_input, tool_use_id, is_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  lines.forEach((line, i) => {
    const id = insertMessage(db, sessionId, {
      role: line.role, id: `${uuid}-${i}`, timestamp: `2026-10-20T10:${String(i).padStart(2, '0')}:00.000Z`, model: line.model,
    })!;
    line.blocks.forEach((b, pos) => {
      block.run(id, pos, b.type, (b.text as string) ?? null, (b.name as string) ?? null,
        b.input ? JSON.stringify(b.input) : null, (b.id as string) ?? null, b.isError ? 1 : 0);
    });
  });
  return sessionId;
}

describe('training export from our demo database', () => {
  const db = createTestDb();
  let seeded: ReturnType<typeof seedDemo>;
  beforeAll(() => { seeded = seedDemo(db, { now: NOW }); });

  it('writes one valid SFT line per demo session', () => {
    const { examples, stats } = all(db);
    expect(examples).toHaveLength(seeded.sessions);
    expect(stats).toMatchObject({ sessionsScanned: seeded.sessions, examples: seeded.sessions });
    for (const ex of examples) {
      expect(validate(ex), JSON.stringify(validate.errors)).toBe(true);
      expect(ex.messages[0].role).toBe('user');
      expect(ex.messages[ex.messages.length - 1].role).toBe('assistant');
    }
  });

  it('pairs every tool call with its result, in OpenAI function-calling form', () => {
    const { examples, stats } = all(db);
    expect(stats.toolCalls).toBeGreaterThan(0);
    expect(stats.toolCalls).toBe(stats.toolResults);
    for (const ex of examples) {
      const called = ex.messages.flatMap((m) => (m.role === 'assistant' ? m.tool_calls ?? [] : []).map((c) => c.id));
      const answered = ex.messages.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []));
      expect(answered.sort()).toEqual(called.sort());
    }
    const call = examples.flatMap((e) => e.messages).find((m) => m.role === 'assistant' && m.tool_calls)!;
    if (call.role !== 'assistant') throw new Error('unreachable');
    expect(call.tool_calls![0]).toMatchObject({ type: 'function', function: { name: expect.any(String) } });
    expect(() => JSON.parse(call.tool_calls![0].function.arguments)).not.toThrow();
  });

  it('leaves reasoning out unless asked, and puts it in reasoning_content when asked', () => {
    const plain = all(db).examples.flatMap((e) => e.messages);
    expect(plain.some((m) => m.role === 'assistant' && m.reasoning_content)).toBe(false);
    const withReasoning = all(db, { reasoning: true }).examples;
    const first = withReasoning[0].messages.find((m) => m.role === 'assistant');
    expect(first && first.role === 'assistant' && first.reasoning_content).toMatch(/Start by reading/);
    for (const ex of withReasoning) expect(validate(ex)).toBe(true);
  });

  it('redacts the username in every home path and counts it', () => {
    const { examples, stats } = all(db);
    const text = examples.map((e) => JSON.stringify(e)).join('\n');
    expect(text).not.toContain('/home/demo/');
    expect(text).toContain('/home/__HOME_PATH_1__/git/');
    expect(stats.redactions.home_path).toBeGreaterThan(0);
    expect(stats.redactionsTotal).toBe(Object.values(stats.redactions).reduce((a, b) => a + b, 0));
  });

  it('filters by project, harness, model and date', () => {
    const byProject = all(db, { project: DEMO_PROJECTS[0].name }).examples;
    expect(byProject.length).toBeGreaterThan(0);
    expect(byProject.length).toBeLessThan(seeded.sessions);
    const projectSessions = (db.prepare('SELECT COUNT(*) n FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.name = ?')
      .get(DEMO_PROJECTS[0].name) as { n: number }).n;
    expect(byProject).toHaveLength(projectSessions);
    expect(all(db, { project: 'no-such-project' }).examples).toHaveLength(0);

    const agnt = all(db, { harness: 'agnt', metadata: true }).examples;
    expect(agnt).toHaveLength(seeded.sessions / DEMO_HARNESSES.length);
    expect(agnt.every((e) => e.metadata?.harness === 'agnt')).toBe(true);

    const byModel = all(db, { model: DEMO_MODELS[1], metadata: true }).examples;
    expect(byModel.length).toBeGreaterThan(0);
    expect(byModel.every((e) => e.metadata!.models.includes(DEMO_MODELS[1]))).toBe(true);

    const today = all(db, { from: '2026-10-23', to: '2026-10-23', metadata: true }).examples;
    expect(today.length).toBeGreaterThan(0);
    expect(today.every((e) => e.metadata!.startedAt!.startsWith('2026-10-23'))).toBe(true);
    expect(all(db, { from: '2026-11-01' }).examples).toHaveLength(0);
  });

  it('carries metadata only when asked, with a display name rather than an encoded path', () => {
    expect(all(db).examples.every((e) => e.metadata === undefined)).toBe(true);
    const [ex] = all(db, { metadata: true, limit: 1 }).examples;
    expect(ex.metadata).toMatchObject({ project: expect.stringMatching(/^demo-/), turns: 2 });
    expect(validate(ex)).toBe(true);
  });

  it('drops tools on request and keeps the prose', () => {
    const { examples, stats } = all(db, { tools: false });
    expect(stats.toolCalls).toBe(0);
    expect(examples.flatMap((e) => e.messages).some((m) => m.role === 'tool')).toBe(false);
    for (const ex of examples) expect(validate(ex)).toBe(true);
  });

  it('applies min and max turns, and limit', () => {
    expect(all(db, { minTurns: 3 }).stats.skipped.tooFewTurns).toBe(seeded.sessions);
    expect(all(db, { maxTurns: 1 }).stats.skipped.tooManyTurns).toBe(seeded.sessions);
    expect(all(db, { minTurns: 2, maxTurns: 2 }).examples).toHaveLength(seeded.sessions);
    expect(all(db, { limit: 3 }).examples).toHaveLength(3);
  });

  it('streams NDJSON and dry-runs to the same counts', () => {
    const lines = [...trainingExportLines(db)];
    expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
    const dry = dryRunTrainingExport(db);
    expect(dry.stats.examples).toBe(lines.length);
    expect(dry.bytes).toBe(lines.reduce((n, l) => n + Buffer.byteLength(l), 0));
    expect(dry.sample).toEqual(JSON.parse(lines[0]));
  });
});

describe('tool errors', () => {
  const db = createTestDb();
  const p = Number(db.prepare(`INSERT INTO projects (name, display_name) VALUES ('-home-x-git-err', 'err')`).run().lastInsertRowid);
  addSession(db, p, 'err-1', [
    { role: 'user', blocks: [{ type: 'text', text: 'first ask' }] },
    { role: 'assistant', model: 'm', blocks: [{ type: 'tool-call', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', blocks: [{ type: 'tool-result', id: 't1', text: 'ok' }] },
    { role: 'assistant', model: 'm', blocks: [{ type: 'text', text: 'listed' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'second ask' }] },
    { role: 'assistant', model: 'm', blocks: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } }] },
    { role: 'user', blocks: [{ type: 'tool_result', id: 't2', text: 'exit 1', isError: true }] },
    { role: 'assistant', model: 'm', blocks: [{ type: 'text', text: 'that failed' }] },
  ]);

  it('drops the errored turn by default and keeps the rest', () => {
    const { examples, stats } = all(db);
    expect(examples).toHaveLength(1);
    expect(examples[0].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(stats.turnsDroppedForToolErrors).toBe(1);
  });

  it('drops the whole session with toolErrors=session, and keeps it all with keep', () => {
    expect(all(db, { toolErrors: 'session' })).toMatchObject({ examples: [], stats: { skipped: { toolErrors: 1 } } });
    const kept = all(db, { toolErrors: 'keep' }).examples[0];
    expect(kept.messages).toHaveLength(8);
    expect(kept.messages[5]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 't2' }] });
    expect(validate(kept)).toBe(true);
  });

  it('leaves out a call nobody answered and a result answering nothing', () => {
    const db2 = createTestDb();
    const p2 = Number(db2.prepare(`INSERT INTO projects (name, display_name) VALUES ('x', 'x')`).run().lastInsertRowid);
    addSession(db2, p2, 'dangle', [
      { role: 'user', blocks: [{ type: 'text', text: 'go' }, { type: 'tool-result', id: 'ghost', text: 'from nowhere' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'calling' }, { type: 'tool-call', id: 'lost', name: 'Read', input: {} }] },
    ]);
    const [ex] = all(db2).examples;
    expect(ex.messages).toEqual([{ role: 'user', content: 'go' }, { role: 'assistant', content: 'calling' }]);
  });
});

describe('secrets never survive an export', () => {
  // Real-looking, built in pieces so no scanner mistakes our test for a leak.
  const SECRETS = {
    anthropic: 'sk-ant-api03-' + 'Qm9vZ2llV29vZ2llMTIzNDU2Nzg5MGFiY2RlZg' + '-xYz_AA',
    openai: 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6',
    github: 'ghp_' + 'R4nd0mL00k1ngT0k3nV4lu3F0rT3st1ng9',
    aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
    slack: 'xoxb-' + '123456789012-abcdefABCDEF',
    google: 'AIza' + 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY',
    unsandbox: 'unsb-sk-' + 'c0ffee12-3456-7890',
    jwt: 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    bearer: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5',
    dbPassword: 'hunter2-correct-horse',
    envToken: 'tok_9f8e7d6c5b4a3210',
    email: 'fox@unturf.example',
    otherEmail: 'someone.else@example.org',
    user: 'timehexon',
    keyBody: 'MIIEowIBAAKCAQEA7bq9',
  };
  const db = createTestDb();
  const p = Number(db.prepare(`INSERT INTO projects (name, display_name) VALUES ('-home-timehexon-git-secret', '-home-timehexon-git-secret')`).run().lastInsertRowid);
  addSession(db, p, 'leaky', [
    { role: 'user', blocks: [{ type: 'text', text:
      `my key is ${SECRETS.anthropic} and openai ${SECRETS.openai}; mail ${SECRETS.email}. ` +
      `Repo at /home/${SECRETS.user}/git/secret and C:\\Users\\${SECRETS.user}\\code` } ] },
    { role: 'assistant', model: 'm', blocks: [
      { type: 'reasoning', text: `The user pasted ${SECRETS.github}; never echo it.` },
      { type: 'text', text: `Do not paste ${SECRETS.aws} into chat, ${SECRETS.email}.` },
      { type: 'tool-call', id: 't1', name: 'Bash', input: {
        command: `curl -H "Authorization: Bearer ${SECRETS.bearer}" https://admin:${SECRETS.dbPassword}@db.example.com/x`,
        env: { GITHUB_TOKEN: SECRETS.github, SLACK: SECRETS.slack },
        cwd: `/home/${SECRETS.user}/.claude/projects/-home-${SECRETS.user}-git-secret`,
      } },
    ] },
    { role: 'user', blocks: [{ type: 'tool-result', id: 't1', text:
      `export API_KEY=${SECRETS.envToken}\nGOOGLE=${SECRETS.google}\nUNSANDBOX_SECRET_KEY=${SECRETS.unsandbox}\n` +
      `jwt ${SECRETS.jwt}\n"password": "${SECRETS.dbPassword}"\n` +
      `-----BEGIN RSA PRIVATE KEY-----\n${SECRETS.keyBody}\n-----END RSA PRIVATE KEY-----\n` +
      `contact ${SECRETS.otherEmail}` }] },
    { role: 'assistant', model: 'm', blocks: [{ type: 'text', text: 'Rotated.' }] },
  ]);

  it('redacts every one, keeps the line valid and counts by type', () => {
    const { examples, stats } = all(db, { reasoning: true, metadata: true });
    expect(examples).toHaveLength(1);
    const line = JSON.stringify(examples[0]);
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(line.includes(value), `${name} survived`).toBe(false);
    }
    expect(validate(examples[0])).toBe(true);
    expect(stats.redactions).toMatchObject({
      api_key: expect.any(Number), jwt: 1, bearer_token: 1, url_credentials: 1,
      secret_assignment: expect.any(Number), private_key: 1, email: 3, home_path: expect.any(Number),
    });
    // Redacted, not dropped: the sentence keeps its shape.
    expect(line).toContain('my key is __API_KEY_1__ and openai __API_KEY_2__');
    expect(line).toContain('/home/__HOME_PATH_1__/git/secret');
    // Tool arguments stay parseable JSON.
    const call = examples[0].messages[1];
    if (call.role !== 'assistant') throw new Error('expected assistant');
    expect(JSON.parse(call.tool_calls![0].function.arguments).env.GITHUB_TOKEN).toMatch(/^__/);
  });
});

describe('paging', () => {
  it('reads past one page of sessions', () => {
    const db = createTestDb();
    const p = Number(db.prepare(`INSERT INTO projects (name, display_name) VALUES ('many', 'many')`).run().lastInsertRowid);
    for (let i = 0; i < 450; i++) {
      addSession(db, p, `s-${i}`, [
        { role: 'user', blocks: [{ type: 'text', text: `ask ${i}` }] },
        { role: 'assistant', blocks: [{ type: 'text', text: `answer ${i}` }] },
      ]);
    }
    const ex = all(db).examples;
    expect(ex).toHaveLength(450);
    expect(ex[449].messages[0]).toEqual({ role: 'user', content: 'ask 449' });
  });

  it('is lazy: taking one example reads one page, not our database', () => {
    const db = createTestDb();
    const p = Number(db.prepare(`INSERT INTO projects (name, display_name) VALUES ('lazy', 'lazy')`).run().lastInsertRowid);
    for (let i = 0; i < 5; i++) {
      addSession(db, p, `l-${i}`, [
        { role: 'user', blocks: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'a' }] },
      ]);
    }
    const stats = emptyTrainingExportStats();
    const gen = exportTrainingSet(db, {}, stats);
    gen.next();
    expect(stats.sessionsScanned).toBe(1);
    gen.return(undefined);
  });
});

describe('resolveProjectId', () => {
  it('finds a project by name or alias', () => {
    const db = createTestDb();
    const id = Number(db.prepare(`INSERT INTO projects (name, display_name) VALUES ('-home-a-git-new', 'new')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO project_aliases (project_id, encoded_name) VALUES (?, '-home-a-git-old')`).run(id);
    expect(resolveProjectId(db, '-home-a-git-new')).toBe(id);
    expect(resolveProjectId(db, '-home-a-git-old')).toBe(id);
    expect(resolveProjectId(db, 'nope')).toBeNull();
  });
});

describe('parseTrainingExportQuery', () => {
  const parse = (q: string) => parseTrainingExportQuery(new URLSearchParams(q));
  it('reads every filter', () => {
    expect(parse('project=p&model=m&harness=agnt&from=2026-10-01&to=2026-10-23&toolErrors=session&minTurns=2&maxTurns=40&reasoning=1&tools=0&metadata=true&toolResultMaxChars=4000&limit=10'))
      .toEqual({ project: 'p', model: 'm', harness: 'agnt', from: '2026-10-01', to: '2026-10-23', toolErrors: 'session',
        minTurns: 2, maxTurns: 40, reasoning: true, tools: false, metadata: true, toolResultMaxChars: 4000, limit: 10 });
    expect(parse('')).toEqual({});
  });
  it('refuses what cannot mean anything', () => {
    expect(parse('from=yesterday')).toHaveProperty('error');
    expect(parse('toolErrors=maybe')).toHaveProperty('error');
    expect(parse('minTurns=-1')).toHaveProperty('error');
  });
});

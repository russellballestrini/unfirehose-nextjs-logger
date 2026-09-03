import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseStatuspageFeed, inferIndicator, robotsAllows, resolveStatusTargets,
  pollStatusTarget, _resetRobotsCache, DEFAULT_STATUS_TARGETS,
} from './status-pages';

// Trimmed from status.claude.com/history.atom, 2026-09-03 14:49Z.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <title>Claude Status - Incident History</title>
  <entry>
    <id>tag:status.claude.com,2005:Incident/31343579</id>
    <updated>2026-09-03T14:49:48Z</updated>
    <link rel="alternate" type="text/html" href="https://status.claude.com/incidents/461yvfrzpwtt"/>
    <title>Elevated errors for multiple models</title>
    <content type="html">&lt;p&gt;&lt;small&gt;Sep 3, 14:49 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Update&lt;/strong&gt; - We are continuing to work on a fix.&lt;/p&gt;&lt;p&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are investigating.&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:status.claude.com,2005:Incident/31343296</id>
    <updated>2026-09-03T12:56:26Z</updated>
    <link rel="alternate" type="text/html" href="https://status.claude.com/incidents/288w7p4hk1l1"/>
    <title>Elevated errors for Claude Sonnet 5</title>
    <content type="html">&lt;p&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - This incident has been resolved.&lt;/p&gt;&lt;p&gt;&lt;strong&gt;Monitoring&lt;/strong&gt; - A fix is in.&lt;/p&gt;</content>
  </entry>
</feed>`;

describe('parseStatuspageFeed', () => {
  it('reads each incident with its newest status', () => {
    const inc = parseStatuspageFeed(FEED);
    expect(inc).toHaveLength(2);
    expect(inc[0]).toMatchObject({ title: 'Elevated errors for multiple models', status: 'Update', open: true, link: 'https://status.claude.com/incidents/461yvfrzpwtt' });
    expect(inc[1]).toMatchObject({ title: 'Elevated errors for Claude Sonnet 5', status: 'Resolved', open: false });
  });
});

// Trimmed from status.openai.com/history.atom (incident.io), 2026-09-03 15:17Z.
const OPENAI_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
    <title>OpenAI status</title>
    <generator>incident.io</generator>
    <entry>
        <title type="html"><![CDATA[Elevated errors across ChatGPT and Codex]]></title>
        <id>https://status.openai.com//incidents/01M1KWEDH417T2CF44YYHZDFCR</id>
        <link href="https://status.openai.com//incidents/01M1KWEDH417T2CF44YYHZDFCR"/>
        <updated>2026-09-03T14:58:23.907Z</updated>
        <summary type="html"><![CDATA[<b>Status: Investigating</b><br/><br/>We are investigating.<br/><br/><b>Affected components</b><ul><li>Search (Degraded performance)</li></ul>]]></summary>
        <content type="html"><![CDATA[<b>Status: Investigating</b><br/><br/>We are investigating.]]></content>
    </entry>
    <entry>
        <title type="html"><![CDATA[Increased latency on the Responses API]]></title>
        <id>https://status.openai.com//incidents/01M1K0</id>
        <link href="https://status.openai.com//incidents/01M1K0"/>
        <updated>2026-09-02T10:00:00.000Z</updated>
        <content type="html"><![CDATA[<b>Status: Resolved</b><br/><br/>This incident has been resolved.]]></content>
    </entry>
</feed>`;

describe('parseStatuspageFeed on incident.io', () => {
  it('reads CDATA titles and the Status: line, and keeps the link sane', () => {
    const inc = parseStatuspageFeed(OPENAI_FEED);
    expect(inc).toHaveLength(2);
    expect(inc[0]).toMatchObject({ title: 'Elevated errors across ChatGPT and Codex', status: 'Investigating', open: true, link: 'https://status.openai.com/incidents/01M1KWEDH417T2CF44YYHZDFCR' });
    expect(inc[1]).toMatchObject({ status: 'Resolved', open: false });
    expect(inferIndicator(inc)).toEqual({ indicator: 'minor', description: 'Investigating: Elevated errors across ChatGPT and Codex' });
  });
});

describe('inferIndicator', () => {
  it('is none with nothing open', () => {
    expect(inferIndicator(parseStatuspageFeed(FEED).slice(1))).toEqual({ indicator: 'none', description: 'No open incidents' });
  });
  it('is minor for elevated errors', () => {
    const r = inferIndicator(parseStatuspageFeed(FEED));
    expect(r.indicator).toBe('minor');
    expect(r.description).toBe('Update: Elevated errors for multiple models');
  });
  it('is major when an open title says outage', () => {
    const r = inferIndicator([{ title: 'API outage', status: 'Investigating', updatedAt: '', link: null, open: true }, { title: 'x', status: 'Identified', updatedAt: '', link: null, open: true }]);
    expect(r.indicator).toBe('major');
    expect(r.description).toBe('Investigating: API outage (+1 more)');
  });
});

describe('robotsAllows', () => {
  const claude = 'User-agent: *\nDisallow: /api/\nDisallow: /embed/\n';
  it('honours the Statuspage default', () => {
    expect(robotsAllows(claude, '/api/v2/status.json')).toBe(false);
    expect(robotsAllows(claude, '/history.atom')).toBe(true);
  });
  it('allows everything when the group is empty or the file is', () => {
    expect(robotsAllows('User-agent: *\nDisallow:\n', '/api/x')).toBe(true);
    expect(robotsAllows('', '/anything')).toBe(true);
  });
  it('longest match wins between Allow and Disallow', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /history\n', '/history.atom')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /history\n', '/api/x')).toBe(false);
  });
  it('ignores groups for other agents', () => {
    expect(robotsAllows('User-agent: Googlebot\nDisallow: /\n', '/history.atom')).toBe(true);
  });
});

describe('resolveStatusTargets', () => {
  it('starts from the defaults', () => {
    expect(resolveStatusTargets(null).map((t) => t.id)).toEqual(DEFAULT_STATUS_TARGETS.map((t) => t.id));
  });
  it('applies removals and additions, addition winning on the same id', () => {
    const t = resolveStatusTargets(JSON.stringify({ removed: ['x-ai'], added: [{ id: 'mistral', name: 'Mistral', feed: 'https://status.mistral.ai/history.atom' }, { id: 'openai', name: 'OpenAI (mine)', feed: 'https://example/x.atom' }] }));
    const ids = t.map((x) => x.id);
    expect(ids).not.toContain('x-ai');
    expect(ids).toContain('mistral');
    expect(t.find((x) => x.id === 'openai')!.name).toBe('OpenAI (mine)');
    expect(t.find((x) => x.id === 'mistral')!.url).toBe('https://status.mistral.ai/history.atom');
  });
  it('survives garbage', () => {
    expect(resolveStatusTargets('{not json')).toHaveLength(DEFAULT_STATUS_TARGETS.length);
  });
});

describe('pollStatusTarget', () => {
  beforeEach(() => _resetRobotsCache());
  const target = DEFAULT_STATUS_TARGETS[0];
  const mk = (routes: Record<string, { status: number; body: string }>) =>
    async (url: string) => {
      const r = routes[url] ?? { status: 404, body: '' };
      return { status: r.status, text: async () => r.body };
    };

  it('reads the feed when robots allows it', async () => {
    const p = await pollStatusTarget(target, { fetchImpl: mk({
      'https://status.claude.com/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /api/\n' },
      'https://status.claude.com/history.atom': { status: 200, body: FEED },
    }) });
    expect(p.indicator).toBe('minor');
    expect(p.httpStatus).toBe(200);
    expect(p.incidents).toHaveLength(2);
  });

  it('refuses a path robots disallows, without fetching it', async () => {
    let fetchedFeed = false;
    const p = await pollStatusTarget(target, { fetchImpl: async (url: string) => {
      if (url.endsWith('/robots.txt')) return { status: 200, text: async () => 'User-agent: *\nDisallow: /\n' };
      fetchedFeed = true; return { status: 200, text: async () => FEED };
    } });
    expect(p.indicator).toBe('blocked_by_robots');
    expect(fetchedFeed).toBe(false);
  });

  it('is unreachable on a non-2xx and unknown on a non-feed body', async () => {
    const a = await pollStatusTarget(target, { fetchImpl: mk({ 'https://status.claude.com/history.atom': { status: 503, body: '' } }) });
    expect(a.indicator).toBe('unreachable');
    expect(a.description).toBe('HTTP 503');
    _resetRobotsCache();
    const b = await pollStatusTarget(target, { fetchImpl: mk({ 'https://status.claude.com/history.atom': { status: 200, body: '<!DOCTYPE html><html>challenge</html>' } }) });
    expect(b.indicator).toBe('unknown');
  });

  it('is unreachable when fetch throws', async () => {
    const p = await pollStatusTarget(target, { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
    expect(p.indicator).toBe('unreachable');
    expect(p.description).toContain('ENOTFOUND');
  });
});

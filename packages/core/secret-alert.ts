/**
 * A credential seen in an ingested session, as an alert says it.
 *
 * The ledger scanner (db/action-ledger.ts) runs findSecrets over every tool
 * call and tool result it classifies; db/secret-alerts.ts turns a new
 * sighting into a row in `alerts` with alert_type `secret_exposed`, and our
 * worker's delivery loop carries it to webhook, ntfy, Slack or Discord like
 * any other alert. This file is the words, shared by the delivery payloads
 * and the Usage and alert pages, so all of them say the same thing.
 *
 * An alert names the kind of credential, where it appeared (a tool call or a
 * tool result, and which tool), the session, the project and the time. It
 * never carries the value, a fragment of it, or the command or output it sat
 * in: those stay in our database, on this machine. Operation Voyeur.
 *
 * Pure, no Node imports, so client components import it too.
 */

export const SECRET_ALERT_TYPE = 'secret_exposed';
/** `alerts.metric` for a secret alert, so a delivery rule can pick them out. */
export const SECRET_ALERT_METRIC = 'secret';

export interface SecretAlertDetails {
  /** Kinds of credential (anthropic_key, private_key, …). Never a value. */
  kinds: string[];
  /** Where it appeared: in what the agent sent (call) or what came back (result). */
  location: 'call' | 'result';
  tool: string | null;
  /** Session UUID. */
  session: string | null;
  /** Encoded project name, as URLs use it. */
  project: string | null;
  projectDisplay: string | null;
  harness: string | null;
  /** The ingested line's own time, ISO. */
  seenAt: string;
  blockId: number;
  toolUseId: string | null;
}

interface AlertRowLike {
  alert_type: string;
  details?: string | null;
  project_name?: string | null;
  actual_value?: number;
}

export function isSecretAlert(a: { alert_type: string }): boolean {
  return a.alert_type === SECRET_ALERT_TYPE;
}

export function parseSecretDetails(a: AlertRowLike): SecretAlertDetails | null {
  if (!isSecretAlert(a)) return null;
  let d: Partial<SecretAlertDetails> = {};
  try { d = a.details ? JSON.parse(a.details) : {}; } catch { d = {}; }
  return {
    kinds: Array.isArray(d.kinds) ? d.kinds.filter((k): k is string => typeof k === 'string') : [],
    location: d.location === 'call' ? 'call' : 'result',
    tool: d.tool ?? null,
    session: d.session ?? null,
    project: d.project ?? a.project_name ?? null,
    projectDisplay: d.projectDisplay ?? null,
    harness: d.harness ?? null,
    seenAt: d.seenAt ?? '',
    blockId: Number(d.blockId) || 0,
    toolUseId: d.toolUseId ?? null,
  };
}

/** "anthropic_key" → "Anthropic key"; "assigned_secret" → "credential-named assignment". */
export function secretKindLabel(kind: string): string {
  const named: Record<string, string> = {
    private_key: 'private key',
    aws_access_key: 'AWS access key',
    github_token: 'GitHub token',
    gitlab_token: 'GitLab token',
    anthropic_key: 'Anthropic key',
    openai_key: 'OpenAI key',
    unsandbox_key: 'unsandbox key',
    slack_token: 'Slack token',
    stripe_key: 'Stripe live key',
    google_api_key: 'Google API key',
    npm_token: 'npm token',
    bearer_token: 'bearer token',
    assigned_secret: 'password or secret assignment',
    credential: 'credential',
  };
  return named[kind] ?? kind.replace(/_/g, ' ');
}

export interface SecretAlertWords {
  title: string;
  message: string;
  /** "a tool result of Bash" */
  where: string;
  kinds: string;
  /** Where to look on our dashboard: the tool call in its session when known. */
  sessionPath: string | null;
}

export function describeSecretAlert(a: AlertRowLike): SecretAlertWords {
  const d = parseSecretDetails(a) ?? parseSecretDetails({ ...a, alert_type: SECRET_ALERT_TYPE })!;
  const kinds = d.kinds.length ? d.kinds.map(secretKindLabel).join(', ') : 'credential';
  const project = d.projectDisplay || d.project || 'an unknown project';
  const tool = d.tool ? ` of ${d.tool}` : '';
  const where = d.location === 'call' ? `a tool call${tool}` : `a tool result${tool}`;
  const times = a.actual_value && a.actual_value > 1 ? ` Seen ${a.actual_value} times in this session so far.` : '';
  const session = d.session ? `session ${d.session}` : 'a session';
  const message = `A credential (${kinds}) appeared in ${where} in ${session} of ${project}, at ${d.seenAt || 'an unknown time'}. `
    + `Everything in a session goes to its model provider, so treat it as exposed and rotate it. `
    + `The value is not in this alert.${times}`;
  const sessionPath = d.project && d.session
    ? `/projects/${encodeURIComponent(d.project)}/${encodeURIComponent(d.session)}${d.toolUseId ? `#tool-${encodeURIComponent(d.toolUseId)}` : ''}`
    : null;
  return { title: `unfirehose: ${kinds} seen in ${project}`, message, where, kinds, sessionPath };
}

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { describeSecretAlert, parseSecretDetails } from '@unturf/unfirehose/secret-alert';
import { SecretAlertDetail } from './SecretAlertDetail';

afterEach(cleanup);

const alert = {
  id: 5, alert_type: 'secret_exposed', metric: 'secret', window_minutes: 0, threshold_value: 0, actual_value: 2,
  triggered_at: '2026-10-24 10:00:05', project_name: '-home-fox-git-api', acknowledged: 0,
  details: JSON.stringify({
    kinds: ['anthropic_key'], location: 'result', tool: 'Bash', session: 'sess-a', project: '-home-fox-git-api',
    projectDisplay: 'api', harness: 'claude-code', seenAt: '2026-10-24T10:00:00Z', blockId: 7, toolUseId: 'toolu_9',
  }),
};

describe('SecretAlertDetail', () => {
  it('says kind, where, project, session and time, and links to the call and the ledger', () => {
    const { container, getByText } = render(
      <SecretAlertDetail alert={alert} secret={parseSecretDetails(alert)!} words={describeSecretAlert(alert)} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Credential seen: Anthropic key');
    expect(text).toContain('a tool result of Bash');
    expect(text).toContain('sess-a');
    expect(text).toContain('Times in this session2');
    expect(getByText('Open the session at that tool call').getAttribute('href')).toBe('/projects/-home-fox-git-api/sess-a#tool-toolu_9');
    expect(getByText('Flagged actions in this session').getAttribute('href')).toBe('/actions?flag=any&session=sess-a');
    expect(getByText('Acknowledge')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('swr', () => ({
  default: () => ({ data: { harnesses: ['agnt', 'claude-code'], models: ['demo-model'] }, error: undefined, isLoading: false, mutate: vi.fn() }),
}));

const { TrainingExport, trainingExportQuery, EMPTY_TRAINING_FORM } = await import('./TrainingExport');

const DRY = {
  stats: {
    sessionsScanned: 9, examples: 7, turns: 14, messages: 84, toolCalls: 28, turnsDroppedForToolErrors: 1,
    skipped: { toolErrors: 1, tooFewTurns: 1, tooManyTurns: 0, empty: 0 },
    redactions: { home_path: 12, api_key: 2 }, redactionsTotal: 14,
  },
  bytes: 20480,
};

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => { cleanup(); fetchMock.mockReset(); });

describe('trainingExportQuery', () => {
  it('leaves defaults out and names every filter set', () => {
    expect(trainingExportQuery('-home-x-git-p', EMPTY_TRAINING_FORM)).toBe('project=-home-x-git-p');
    expect(trainingExportQuery('p', { ...EMPTY_TRAINING_FORM, model: 'm', harness: 'agnt', from: '2026-10-01', to: '2026-10-23',
      toolErrors: 'session', minTurns: '2', maxTurns: '40', reasoning: true, tools: false, metadata: true }, true))
      .toBe('project=p&model=m&harness=agnt&from=2026-10-01&to=2026-10-23&toolErrors=session&minTurns=2&maxTurns=40&reasoning=1&tools=0&metadata=1&dryRun=1');
  });
});

describe('TrainingExport', () => {
  it('previews counts and redactions, then offers the download for those filters', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => DRY });
    render(<TrainingExport project="-home-x-git-p" />);
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(screen.getByRole('option', { name: 'demo-model' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByTestId('training-preview')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/training-export?project=-home-x-git-p&dryRun=1');
    const preview = screen.getByTestId('training-preview').textContent!;
    expect(preview).toContain('7 of 9 sessions');
    expect(preview).toContain('home_path12');
    expect(preview).toContain('api_key2');
    expect(preview).toContain('20.0 KB');
    expect(screen.getByRole('link', { name: /Download/ }).getAttribute('href')).toBe('/api/training-export?project=-home-x-git-p');

    // A changed filter is a different file: the preview no longer describes it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'reasoning' }));
    expect(screen.queryByTestId('training-preview')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
  });

  it('says what went wrong', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'from is not a date' }) });
    render(<TrainingExport project="p" />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('from is not a date')).toBeTruthy());
  });
});

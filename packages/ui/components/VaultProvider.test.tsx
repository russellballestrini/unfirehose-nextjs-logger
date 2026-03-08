// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VaultProvider, useVault } from './VaultProvider';

afterEach(() => cleanup());
beforeEach(() => {
  localStorage.clear();
});

function VaultConsumer() {
  const vault = useVault();
  return (
    <div>
      <span data-testid="ready">{String(vault.ready)}</span>
      <span data-testid="unlocked">{String(vault.unlocked)}</span>
      <span data-testid="exists">{String(vault.exists)}</span>
      <span data-testid="preferred">{vault.data?.preferred ?? 'none'}</span>
      <span data-testid="key-anthropic">{vault.getKey('anthropic') || 'empty'}</span>
      <button data-testid="create" onClick={() => vault.create('testpass1')}>Create</button>
      <button data-testid="lock" onClick={() => vault.lock()}>Lock</button>
      <button data-testid="unlock" onClick={() => vault.unlock('testpass1')}>Unlock</button>
      <button data-testid="set-key" onClick={() => vault.setKey('anthropic', 'sk-ant-test')}>SetKey</button>
      <button data-testid="remove-key" onClick={() => vault.removeKey('anthropic')}>RemoveKey</button>
      <button data-testid="set-preferred" onClick={() => vault.setPreferred('openai')}>SetPreferred</button>
      <button data-testid="set-model" onClick={() => vault.setModel('anthropic', 'opus')}>SetModel</button>
      <button data-testid="set-endpoint" onClick={() => vault.setEndpoint('custom', 'http://localhost:1234')}>SetEndpoint</button>
    </div>
  );
}

function renderWithVault() {
  return render(
    <VaultProvider>
      <VaultConsumer />
    </VaultProvider>
  );
}

describe('VaultProvider', () => {
  it('starts in ready state with no vault', async () => {
    renderWithVault();
    await waitFor(() => {
      expect(screen.getByTestId('ready').textContent).toBe('true');
    });
    expect(screen.getByTestId('unlocked').textContent).toBe('false');
    expect(screen.getByTestId('exists').textContent).toBe('false');
  });

  it('creates vault and unlocks', async () => {
    const user = userEvent.setup();
    renderWithVault();
    await waitFor(() => {
      expect(screen.getByTestId('ready').textContent).toBe('true');
    });

    await user.click(screen.getByTestId('create'));

    await waitFor(() => {
      expect(screen.getByTestId('unlocked').textContent).toBe('true');
      expect(screen.getByTestId('exists').textContent).toBe('true');
    });
  });

  it('locks and unlocks', async () => {
    const user = userEvent.setup();
    renderWithVault();
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));

    await user.click(screen.getByTestId('create'));
    await waitFor(() => expect(screen.getByTestId('unlocked').textContent).toBe('true'));

    await user.click(screen.getByTestId('lock'));
    await waitFor(() => expect(screen.getByTestId('unlocked').textContent).toBe('false'));

    await user.click(screen.getByTestId('unlock'));
    await waitFor(() => expect(screen.getByTestId('unlocked').textContent).toBe('true'));
  });

  it('manages keys through vault context', async () => {
    const user = userEvent.setup();
    renderWithVault();
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));

    await user.click(screen.getByTestId('create'));
    await waitFor(() => expect(screen.getByTestId('unlocked').textContent).toBe('true'));

    expect(screen.getByTestId('key-anthropic').textContent).toBe('empty');

    await user.click(screen.getByTestId('set-key'));
    await waitFor(() => {
      expect(screen.getByTestId('key-anthropic').textContent).toBe('sk-ant-test');
    });

    await user.click(screen.getByTestId('remove-key'));
    await waitFor(() => {
      expect(screen.getByTestId('key-anthropic').textContent).toBe('empty');
    });
  });

  it('sets preferred provider', async () => {
    const user = userEvent.setup();
    renderWithVault();
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    await user.click(screen.getByTestId('create'));
    await waitFor(() => expect(screen.getByTestId('unlocked').textContent).toBe('true'));

    expect(screen.getByTestId('preferred').textContent).toBe('none');

    await user.click(screen.getByTestId('set-preferred'));
    await waitFor(() => {
      expect(screen.getByTestId('preferred').textContent).toBe('openai');
    });
  });
});

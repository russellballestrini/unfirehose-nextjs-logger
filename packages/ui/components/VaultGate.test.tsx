// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VaultProvider } from './VaultProvider';
import { VaultGate } from './VaultGate';

afterEach(() => cleanup());
beforeEach(() => {
  localStorage.clear();
});

function renderGate() {
  return render(
    <VaultProvider>
      <VaultGate>
        <div data-testid="app-content">App is visible</div>
      </VaultGate>
    </VaultProvider>
  );
}

describe('VaultGate', () => {
  it('shows create vault UI when no vault exists', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByText('Create your vault')).toBeTruthy();
    });
    expect(screen.getByPlaceholderText('Choose a password (8+ chars)')).toBeTruthy();
    expect(screen.getByText('Create Vault')).toBeTruthy();
    expect(screen.queryByTestId('app-content')).toBeNull();
  });

  it('validates minimum password length', async () => {
    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Create your vault')).toBeTruthy());

    const input = screen.getByPlaceholderText('Choose a password (8+ chars)');
    await user.type(input, 'short');
    await user.click(screen.getByText('Create Vault'));

    await waitFor(() => {
      expect(screen.getByText('Password must be at least 8 characters')).toBeTruthy();
    });
    expect(screen.queryByTestId('app-content')).toBeNull();
  });

  it('creates vault and shows app content', async () => {
    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Create your vault')).toBeTruthy());

    const input = screen.getByPlaceholderText('Choose a password (8+ chars)');
    await user.type(input, 'longpassword123');
    await user.click(screen.getByText('Create Vault'));

    await waitFor(() => {
      expect(screen.getByTestId('app-content')).toBeTruthy();
    }, { timeout: 5000 });
  });

  it('skip button creates vault and shows app', async () => {
    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Create your vault')).toBeTruthy());

    await user.click(screen.getByText(/Skip/));

    await waitFor(() => {
      expect(screen.getByTestId('app-content')).toBeTruthy();
    }, { timeout: 5000 });
  });

  it('shows unlock UI when vault already exists', async () => {
    // Pre-create vault
    const { Vault } = await import('./vault');
    await Vault.create('existing-pw');
    Vault.lock(); // lock so gate shows unlock

    renderGate();
    await waitFor(() => {
      expect(screen.getByText('Unlock vault')).toBeTruthy();
    });
    expect(screen.getByPlaceholderText('Vault password')).toBeTruthy();
    expect(screen.getByText('Unlock')).toBeTruthy();
  });

  it('shows error on wrong password', async () => {
    const { Vault } = await import('./vault');
    await Vault.create('real-password');
    Vault.lock();

    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Unlock vault')).toBeTruthy());

    await user.type(screen.getByPlaceholderText('Vault password'), 'wrong-password');
    await user.click(screen.getByText('Unlock'));

    await waitFor(() => {
      expect(screen.getByText('Wrong password')).toBeTruthy();
    });
  });

  it('unlocks with correct password and shows app', async () => {
    const { Vault } = await import('./vault');
    await Vault.create('correct-pw');
    Vault.lock();

    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Unlock vault')).toBeTruthy());

    await user.type(screen.getByPlaceholderText('Vault password'), 'correct-pw');
    await user.click(screen.getByText('Unlock'));

    await waitFor(() => {
      expect(screen.getByTestId('app-content')).toBeTruthy();
    }, { timeout: 5000 });
  });

  it('auto-restores session and shows app immediately', async () => {
    const { Vault } = await import('./vault');
    await Vault.create('auto-restore');
    // Session is active, vault exists — should auto-unlock

    renderGate();
    await waitFor(() => {
      expect(screen.getByTestId('app-content')).toBeTruthy();
    }, { timeout: 5000 });
  });
});

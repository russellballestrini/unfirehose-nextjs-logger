// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

// Key derivation is real crypto, and this suite runs on a box that is also
// serving a dashboard, ingesting sessions and probing a mesh. The default
// 1s window makes these assert machine speed rather than behaviour: they
// have failed twice on load while passing standalone.
/**
 * The vault derives its key with PBKDF2 at the 600,000 iterations that ship,
 * which is the point of testing it. One derivation runs 1.5-2.5s on an idle
 * machine and several times that when the rest of the suite is competing for
 * CPU, so these waits are budgeted for a busy machine rather than a quiet one.
 *
 * Note this is what governs, not vitest's testTimeout: a waitFor with its own
 * timeout gives up on its own schedule no matter how long the test is allowed.
 * Four call sites here still carried a 5s literal after the file-level budget
 * was raised, which is why the suite kept failing intermittently.
 */
const WAIT = { timeout: 30_000 };
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
    }, WAIT);
    expect(screen.getByPlaceholderText('Choose a password (8+ chars)')).toBeTruthy();
    expect(screen.getByText('Create Vault')).toBeTruthy();
    expect(screen.queryByTestId('app-content')).toBeNull();
  });

  it('validates minimum password length', async () => {
    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Create your vault')).toBeTruthy(), WAIT);

    const input = screen.getByPlaceholderText('Choose a password (8+ chars)');
    await user.type(input, 'short');
    await user.click(screen.getByText('Create Vault'));

    await waitFor(() => {
      expect(screen.getByText('Password must be at least 8 characters')).toBeTruthy();
    }, WAIT);
    expect(screen.queryByTestId('app-content')).toBeNull();
  });

  it('creates vault and shows app content', async () => {
    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Create your vault')).toBeTruthy(), WAIT);

    const input = screen.getByPlaceholderText('Choose a password (8+ chars)');
    await user.type(input, 'longpassword123');
    await user.click(screen.getByText('Create Vault'));

    await waitFor(() => {
      expect(screen.getByTestId('app-content')).toBeTruthy();
    }, WAIT);
  });

  it('skip button creates vault and shows app', async () => {
    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Create your vault')).toBeTruthy(), WAIT);

    await user.click(screen.getByText(/Skip/));

    await waitFor(() => {
      expect(screen.getByTestId('app-content')).toBeTruthy();
    }, WAIT);
  });

  it('shows unlock UI when vault already exists', async () => {
    // Pre-create vault
    const { Vault } = await import('./vault');
    await Vault.create('existing-pw');
    Vault.lock(); // lock so gate shows unlock

    renderGate();
    await waitFor(() => {
      expect(screen.getByText('Unlock vault')).toBeTruthy();
    }, WAIT);
    expect(screen.getByPlaceholderText('Vault password')).toBeTruthy();
    expect(screen.getByText('Unlock')).toBeTruthy();
  });

  it('shows error on wrong password', async () => {
    const { Vault } = await import('./vault');
    await Vault.create('real-password');
    Vault.lock();

    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Unlock vault')).toBeTruthy(), WAIT);

    await user.type(screen.getByPlaceholderText('Vault password'), 'wrong-password');
    await user.click(screen.getByText('Unlock'));

    await waitFor(() => {
      expect(screen.getByText('Wrong password')).toBeTruthy();
    }, WAIT);
  });

  it('unlocks with correct password and shows app', async () => {
    const { Vault } = await import('./vault');
    await Vault.create('correct-pw');
    Vault.lock();

    const user = userEvent.setup();
    renderGate();
    await waitFor(() => expect(screen.getByText('Unlock vault')).toBeTruthy(), WAIT);

    await user.type(screen.getByPlaceholderText('Vault password'), 'correct-pw');
    await user.click(screen.getByText('Unlock'));

    await waitFor(() => {
      expect(screen.getByTestId('app-content')).toBeTruthy();
    }, WAIT);
  });

  it('auto-restores session and shows app immediately', async () => {
    const { Vault } = await import('./vault');
    await Vault.create('auto-restore');
    // Session is active, vault exists — should auto-unlock

    renderGate();
    await waitFor(() => {
      expect(screen.getByTestId('app-content')).toBeTruthy();
    }, WAIT);
  });
});

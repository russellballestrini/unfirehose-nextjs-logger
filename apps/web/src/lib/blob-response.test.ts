import { describe, it, expect, vi } from 'vitest';

vi.mock('@unturf/unfirehose/db/schema', () => ({ UNFIREHOSE_DIR: '/tmp/unfirehose-blob-test' }));

const { downloadName, serveBlob } = await import('./blob-response');

const HASH = 'a'.repeat(64);

describe('downloadName', () => {
  it('keeps an ordinary name', () => {
    expect(downloadName('screenshot.png', 'fallback')).toBe('screenshot.png');
  });

  it('drops the directory part of a stored relative path', () => {
    expect(downloadName('nested/spill/out.json', 'fallback')).toBe('out.json');
  });

  it('strips a quote that would close the header value early', () => {
    // An uploaded file named a".png put the rest of its name outside the
    // quoted string in Content-Disposition.
    expect(downloadName('a".png', 'fallback')).toBe('a.png');
  });

  it('strips control characters that could start a new header line', () => {
    expect(downloadName('evil\r\nX-Injected: 1.png', 'fallback')).toBe('evilX-Injected: 1.png');
  });

  it('falls back when nothing usable is left', () => {
    expect(downloadName('"""', 'fallback')).toBe('fallback');
    expect(downloadName(null, 'fallback')).toBe('fallback');
  });
});

describe('serveBlob', () => {
  it('refuses anything that is not a bare sha256', () => {
    // The hash is joined onto a directory, so this is the check that keeps a
    // URL segment from walking out of the store.
    for (const bad of ['../../etc/passwd', `${HASH}/../x`, 'short', `${HASH}A`]) {
      expect(serveBlob(bad, {}).status).toBe(400);
    }
  });

  it('reports a hash with no file behind it', () => {
    expect(serveBlob(HASH, {}).status).toBe(404);
  });
});

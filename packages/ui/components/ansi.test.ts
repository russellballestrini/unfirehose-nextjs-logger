import { describe, it, expect } from 'vitest';
import { ansiToHtml } from './ansi';

const ESC = '\x1b[';

/**
 * This output is handed to dangerouslySetInnerHTML, so the escaping test
 * below is the one that matters most: it is all that stands between a
 * process's stdout and script execution in our page.
 */
describe('ansiToHtml', () => {
  it('passes plain text through untouched', () => {
    expect(ansiToHtml('all quiet')).toBe('all quiet');
  });

  it('wraps coloured runs and closes them', () => {
    expect(ansiToHtml(`${ESC}31mfailed${ESC}0m`))
      .toBe('<span style="color:#ef4444">failed</span>');
  });

  it('escapes markup in terminal output', () => {
    // A build log printing a tag must not become one.
    expect(ansiToHtml('<script>alert(1)</script> & more'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
  });

  it('escapes inside a styled run too', () => {
    expect(ansiToHtml(`${ESC}31m<b>${ESC}0m`))
      .toBe('<span style="color:#ef4444">&lt;b&gt;</span>');
  });

  it('carries style across until it is reset', () => {
    const html = ansiToHtml(`${ESC}32mone two${ESC}0m three`);
    expect(html).toBe('<span style="color:#22c55e">one two</span> three');
  });

  it('combines foreground, background and weight', () => {
    const html = ansiToHtml(`${ESC}1;31;44mloud${ESC}0m`);
    expect(html).toContain('color:#ef4444');
    expect(html).toContain('background:#1e3a5f');
    expect(html).toContain('font-weight:bold');
  });

  it('reads a bare reset as a full reset', () => {
    // `ESC[m` with no digits is a reset; treating it as unknown would leave
    // every following line wearing the last colour.
    expect(ansiToHtml(`${ESC}31mred${ESC}mplain`))
      .toBe('<span style="color:#ef4444">red</span>plain');
  });

  it('clears just the colour on 39 and 49', () => {
    expect(ansiToHtml(`${ESC}31mred${ESC}39mplain`))
      .toBe('<span style="color:#ef4444">red</span>plain');
  });

  it('drops a sequence it does not understand rather than printing it', () => {
    // Cursor moves and clears arrive constantly in a capture-pane snapshot.
    expect(ansiToHtml(`${ESC}38;5;208mtext${ESC}0m`)).toContain('text');
    expect(ansiToHtml(`${ESC}38;5;208mtext${ESC}0m`)).not.toContain('\x1b');
  });

  it('ends bold at 22 without dropping the colour', () => {
    const html = ansiToHtml(`${ESC}1;31mloud${ESC}22mquiet${ESC}0m`);
    expect(html).toContain('<span style="color:#ef4444;font-weight:bold">loud</span>');
    expect(html).toContain('<span style="color:#ef4444">quiet</span>');
  });
});

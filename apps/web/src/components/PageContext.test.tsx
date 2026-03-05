// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PageContext } from './PageContext';

afterEach(() => cleanup());

describe('PageContext', () => {
  it('renders hidden context div with page-type data attribute', () => {
    render(
      <PageContext
        pageType="dashboard"
        summary="Test summary"
        metrics={{ sessions: 10, messages: 100 }}
      />
    );
    const div = document.getElementById('csl-page-context');
    expect(div).toBeTruthy();
    expect(div?.getAttribute('data-page-type')).toBe('dashboard');
    expect(div?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders JSON-LD script tag with correct structure', () => {
    render(
      <PageContext
        pageType="projects"
        summary="Project list"
        metrics={{ count: 47 }}
      />
    );
    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script).toBeTruthy();
    const data = JSON.parse(script!.textContent!);
    expect(data['@type']).toBe('Dataset');
    expect(data.name).toContain('projects');
    expect(data.variableMeasured).toHaveLength(1);
  });

  it('renders summary text in hidden block', () => {
    render(
      <PageContext
        pageType="test"
        summary="My test summary"
        metrics={{ x: 1 }}
      />
    );
    const div = document.getElementById('csl-page-context');
    expect(div?.textContent).toContain('My test summary');
  });

  it('renders metrics as preformatted text', () => {
    render(
      <PageContext
        pageType="test"
        summary="s"
        metrics={{ sessions: 10, messages: 100 }}
      />
    );
    const div = document.getElementById('csl-page-context');
    expect(div?.textContent).toContain('sessions: 10');
    expect(div?.textContent).toContain('messages: 100');
  });

  it('renders details when provided', () => {
    render(
      <PageContext
        pageType="test"
        summary="s"
        metrics={{ x: 1 }}
        details="Detailed info here"
      />
    );
    const div = document.getElementById('csl-page-context');
    expect(div?.textContent).toContain('Detailed info here');
  });

  it('omits details when not provided', () => {
    const { container } = render(
      <PageContext
        pageType="test"
        summary="s"
        metrics={{ x: 1 }}
      />
    );
    const pres = container.querySelectorAll('pre');
    // Only one pre for metrics, no second for details
    expect(pres).toHaveLength(1);
  });

  it('sets meta tags in document head on mount', () => {
    render(
      <PageContext
        pageType="usage"
        summary="Usage data"
        metrics={{ cost: 100 }}
      />
    );
    const meta = document.querySelector('meta[name="csl:page-type"]') as HTMLMetaElement;
    expect(meta).toBeTruthy();
    expect(meta.content).toBe('usage');
  });
});

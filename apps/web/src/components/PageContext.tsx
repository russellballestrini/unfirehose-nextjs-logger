'use client';

import { useEffect } from 'react';

/**
 * Embeds page metrics as hidden structured data for reverse RAG.
 * The uncloseai.js button reads page content to provide contextual answers.
 *
 * Renders:
 * - A hidden div with human-readable summary text (for LLM parsing)
 * - A script tag with JSON-LD structured data (for programmatic access)
 * - Meta tags via DOM manipulation (for head-level context)
 */
export function PageContext({
  pageType,
  summary,
  metrics,
  details,
}: {
  pageType: string;
  summary: string;
  metrics: Record<string, string | number>;
  details?: string;
}) {
  // Set meta tags dynamically
  useEffect(() => {
    const setMeta = (name: string, content: string) => {
      let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement('meta');
        el.name = name;
        document.head.appendChild(el);
      }
      el.content = content;
    };

    setMeta('csl:page-type', pageType);
    setMeta('csl:summary', summary);
    setMeta('csl:metrics', JSON.stringify(metrics));

    // Set page-level description for general scrapers
    setMeta('description', `claude_sexy_logger ${pageType}: ${summary}`);

    return () => {
      document.querySelectorAll('meta[name^="csl:"]').forEach((el) => el.remove());
    };
  }, [pageType, summary, metrics]);

  const metricsText = Object.entries(metrics)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `claude_sexy_logger ${pageType}`,
    description: summary,
    variableMeasured: Object.entries(metrics).map(([k, v]) => ({
      '@type': 'PropertyValue',
      name: k,
      value: v,
    })),
  };

  return (
    <>
      {/* JSON-LD structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hidden context block for LLM/RAG consumption */}
      <div
        id="csl-page-context"
        data-page-type={pageType}
        data-metrics={JSON.stringify(metrics)}
        aria-hidden="true"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
      >
        <h2>claude_sexy_logger — {pageType}</h2>
        <p>{summary}</p>
        <pre>{metricsText}</pre>
        {details && <pre>{details}</pre>}
      </div>
    </>
  );
}

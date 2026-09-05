'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { useState } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function SchemaPage() {
  const [selectedFile, setSelectedFile] = useState('README.md');
  const { data: index } = useSWR('/api/schema', fetcher);
  const { data: doc, isLoading } = useSWR(
    `/api/schema?file=${encodeURIComponent(selectedFile)}`,
    fetcher
  );

  // Navigate markdown links within the schema viewer
  const onNavigate = (href: string) => {
    // Resolve relative paths like ./messages.md or ./harnesses/claude-code.md
    const clean = href.replace(/^\.\//, '');
    if (clean.endsWith('.md')) {
      setSelectedFile(clean);
    }
  };

  const files = index?.files ?? [];
  const schemaFiles = files.filter((f: any) => f.group === 'Schema');
  const harnessFiles = files.filter((f: any) => f.group === 'Harnesses');

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      <PageContext
        pageType="schema"
        summary={`Schema spec: ${selectedFile}. ${files.length} docs.`}
        metrics={{ file: selectedFile, docs: files.length }}
      />

      {/* Schema file list */}
      <div className="w-52 shrink-0 border-r border-[var(--color-border)] overflow-y-auto p-3 space-y-4">
        <div>
          <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase mb-2">Schema</h3>
          {schemaFiles.map((f: any) => (
            <button
              key={f.path}
              onClick={() => setSelectedFile(f.path)}
              className={`block w-full text-left px-2 py-1 text-sm rounded capitalize ${
                selectedFile === f.path
                  ? 'bg-[var(--color-surface-hover)] text-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div>
          <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase mb-2">Harnesses</h3>
          {harnessFiles.map((f: any) => (
            <button
              key={f.path}
              onClick={() => setSelectedFile(f.path)}
              className={`block w-full text-left px-2 py-1 text-sm rounded capitalize ${
                selectedFile === f.path
                  ? 'bg-[var(--color-surface-hover)] text-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Markdown content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && <div className="text-[var(--color-muted)]">Loading...</div>}
        {doc?.content && <MarkdownRenderer content={doc.content} onNavigate={onNavigate} />}
        {doc?.error && <div className="text-[var(--color-error)]">{doc.error}</div>}
      </div>
    </div>
  );
}

/**
 * The two kinds of list our schema docs use.
 *
 * They differ only in what starts a line and what wraps the result. One
 * regex per kind, used both to find a run and to strip its marker, so the
 * two can never disagree about what a list item looks like.
 */
const LIST_KINDS = [
  { starts: /^\s*[-*]\s/, tag: 'ul' as const, marker: 'list-disc' },
  { starts: /^\s*\d+\.\s/, tag: 'ol' as const, marker: 'list-decimal' },
];


export function MarkdownRenderer({ content, onNavigate }: { content: string; onNavigate?: (href: string) => void }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={key++} className="bg-[var(--color-background)] border border-[var(--color-border)] rounded p-4 my-3 overflow-x-auto text-sm">
          {lang && <div className="text-xs text-[var(--color-muted)] mb-2">{lang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Tables
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(<MarkdownTable key={key++} lines={tableLines} onNavigate={onNavigate} />);
      continue;
    }

    // Headers
    if (line.startsWith('#')) {
      const match = line.match(/^(#{1,6})\s+(.*)/);
      if (match) {
        const level = match[1].length;
        const text = match[2];
        const cls = level === 1 ? 'text-xl font-bold mt-6 mb-3' :
                    level === 2 ? 'text-lg font-bold mt-5 mb-2' :
                    level === 3 ? 'text-base font-bold mt-4 mb-2 text-[var(--color-muted)]' :
                    'text-sm font-bold mt-3 mb-1 text-[var(--color-muted)]';
        elements.push(<div key={key++} className={cls}>{renderInline(text, onNavigate)}</div>);
        i++;
        continue;
      }
    }

    // Empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Lists. Bulleted and numbered differ only in what starts a line and
    // which element wraps it, so the run-gathering is written once — it was
    // twice, and the two copies each had their own copy of the regex, in
    // both the test that starts a run and the strip that ends one.
    const list = LIST_KINDS.find((k) => k.starts.test(line));
    if (list) {
      const items: string[] = [];
      while (i < lines.length && list.starts.test(lines[i])) {
        items.push(lines[i].replace(list.starts, ''));
        i++;
      }
      const Tag = list.tag;
      elements.push(
        <Tag key={key++} className={`${list.marker} list-inside my-2 space-y-1 text-sm`}>
          {items.map((item, j) => <li key={j}>{renderInline(item, onNavigate)}</li>)}
        </Tag>
      );
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={key++} className="text-sm my-1.5">{renderInline(line, onNavigate)}</p>
    );
    i++;
  }

  return <div className="max-w-4xl">{elements}</div>;
}

function MarkdownTable({ lines, onNavigate }: { lines: string[]; onNavigate?: (href: string) => void }) {
  const parseRow = (line: string) =>
    line.split('|').slice(1, -1).map(cell => cell.trim());

  if (lines.length < 2) return null;

  const headers = parseRow(lines[0]);
  // Skip separator line (line[1])
  const rows = lines.slice(2).map(parseRow);

  return (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-sm border border-[var(--color-border)]">
        <thead>
          <tr className="bg-[var(--color-surface)]">
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left border-b border-[var(--color-border)] text-[var(--color-muted)]">
                {renderInline(h, onNavigate)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-1.5">
                  {renderInline(cell, onNavigate)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInline(text: string, onNavigate?: (href: string) => void): React.ReactNode {
  // Simple inline formatting: **bold**, `code`, [links](url)
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Code
    const codeMatch = remaining.match(/`(.+?)`/);
    // Link
    const linkMatch = remaining.match(/\[(.+?)\]\((.+?)\)/);

    const matches = [
      boldMatch ? { idx: remaining.indexOf(boldMatch[0]), len: boldMatch[0].length, type: 'bold', m: boldMatch } : null,
      codeMatch ? { idx: remaining.indexOf(codeMatch[0]), len: codeMatch[0].length, type: 'code', m: codeMatch } : null,
      linkMatch ? { idx: remaining.indexOf(linkMatch[0]), len: linkMatch[0].length, type: 'link', m: linkMatch } : null,
    ].filter(Boolean).sort((a, b) => a!.idx - b!.idx);

    if (matches.length === 0) {
      parts.push(remaining);
      break;
    }

    const first = matches[0]!;
    if (first.idx > 0) {
      parts.push(remaining.slice(0, first.idx));
    }

    if (first.type === 'bold') {
      parts.push(<strong key={key++}>{first.m![1]}</strong>);
    } else if (first.type === 'code') {
      parts.push(
        <code key={key++} className="bg-[var(--color-surface-hover)] px-1 py-0.5 rounded text-[var(--color-accent)] text-xs">
          {first.m![1]}
        </code>
      );
    } else if (first.type === 'link') {
      const href = first.m![2];
      const isMdLink = href.endsWith('.md') || href.includes('.md#');
      if (isMdLink && onNavigate) {
        parts.push(
          <button
            key={key++}
            onClick={() => onNavigate(href.split('#')[0])}
            className="text-[var(--color-accent)] hover:underline cursor-pointer"
          >
            {first.m![1]}
          </button>
        );
      } else {
        parts.push(
          <a key={key++} href={href} className="text-[var(--color-accent)] hover:underline">
            {first.m![1]}
          </a>
        );
      }
    }

    remaining = remaining.slice(first.idx + first.len);
  }

  return <>{parts}</>;
}

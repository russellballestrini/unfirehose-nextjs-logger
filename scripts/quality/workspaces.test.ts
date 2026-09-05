import { describe, it, expect } from 'vitest';
import { isSource, isTest, workspaceOf, rel, ROOT } from './workspaces';
import path from 'path';

/**
 * Which files our quality reports count.
 *
 * This decides the denominator of every number those reports print, so a
 * file wrongly included reads as untested shipped code somebody should go
 * and cover, and one wrongly excluded hides real risk.
 */


describe('isSource', () => {
  it('counts ordinary source', () => {
    expect(isSource('apps/web/src/lib/mesh-score.ts')).toBe(true);
    expect(isSource('packages/ui/components/Gauge.tsx')).toBe(true);
  });

  it('does not count a test as code to be covered', () => {
    expect(isSource('packages/core/db/ingest.test.ts')).toBe(false);
    expect(isSource('apps/web/src/app/page.test.tsx')).toBe(false);
  });

  it('does not count test scaffolding either', () => {
    // A fixture builder is only ever run by tests. Grading it measures
    // whether our helpers exercise each other, and any line of it no test
    // happens to need reads as untested shipped code.
    expect(isSource('packages/core/test/db-helper.ts')).toBe(false);
    expect(isSource('packages/ui/test/setup.ts')).toBe(false);
    expect(isSource('apps/web/src/__mocks__/swr.ts')).toBe(false);
  });

  it('does not mistake a directory that merely starts with test', () => {
    expect(isSource('apps/web/src/lib/testing-utils.ts')).toBe(true);
    expect(isSource('packages/core/testbed/thing.ts')).toBe(true);
  });

  it('ignores declarations and anything that is not ts', () => {
    expect(isSource('packages/core/types.d.ts')).toBe(false);
    expect(isSource('apps/web/src/app/globals.css')).toBe(false);
  });
});

describe('isTest', () => {
  it('is the complement for the files that are tests', () => {
    expect(isTest('packages/core/db/ingest.test.ts')).toBe(true);
    expect(isTest('packages/core/db/ingest.ts')).toBe(false);
  });
});

describe('workspaceOf', () => {
  it('names the workspace a path belongs to', () => {
    // It takes an absolute path, because that is what walk hands it.
    expect(workspaceOf(path.join(ROOT, 'apps/web/src/app/page.tsx'))?.dir).toBe('apps/web');
    expect(workspaceOf(path.join(ROOT, 'packages/core/db/ingest.ts'))?.dir).toBe('packages/core');
  });

  it('picks the most specific workspace when two nest', () => {
    // packages/ and packages/core both prefix this path; only one of them
    // has a vitest config and a coverage threshold of its own.
    expect(workspaceOf(path.join(ROOT, 'packages/ui/components/Gauge.tsx'))?.dir).toBe('packages/ui');
  });

  it('has nothing to say about a path outside the repo', () => {
    expect(workspaceOf('/etc/hosts')).toBeUndefined();
  });
});

describe('rel', () => {
  it('reports a path from the repo root, which is how every report reads', () => {
    expect(rel(path.join(ROOT, 'packages/core/db/ingest.ts'))).toBe('packages/core/db/ingest.ts');
  });
});

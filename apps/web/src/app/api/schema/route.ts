import { NextRequest, NextResponse } from 'next/server';
import { readFile, readdir } from 'fs/promises';
import path from 'path';

// The published spec is the only copy. A second tree under docs/schema drifted
// for four months (no throttling, stale harness list) before it was retired.
const SCHEMA_DIR = path.resolve(process.cwd(), '../../packages/schema/docs');

export async function GET(request: NextRequest) {
  const file = request.nextUrl.searchParams.get('file');

  if (!file) {
    // List all schema files
    const files = await listSchemaFiles();
    return NextResponse.json({ files });
  }

  // Sanitize: only allow alphanumeric, hyphens, slashes, and .md extension
  if (!/^[a-z0-9/-]+\.md$/i.test(file) || file.includes('..')) {
    return NextResponse.json({ error: 'Invalid file' }, { status: 400 });
  }

  try {
    const content = await readFile(path.join(SCHEMA_DIR, file), 'utf-8');
    return NextResponse.json({ file, content });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}

async function listSchemaFiles(): Promise<{ path: string; label: string; group: string }[]> {
  const files: { path: string; label: string; group: string }[] = [];

  // Root schema docs
  const rootFiles = await readdir(SCHEMA_DIR).catch(() => []);
  for (const f of rootFiles) {
    if (!f.endsWith('.md')) continue;
    const label = f === 'README.md' ? 'Overview' : f.replace('.md', '').replace(/-/g, ' ');
    files.push({ path: f, label, group: 'Schema' });
  }

  // Harness docs
  const harnessDir = path.join(SCHEMA_DIR, 'harnesses');
  const harnessFiles = await readdir(harnessDir).catch(() => []);
  for (const f of harnessFiles) {
    if (!f.endsWith('.md')) continue;
    const label = f.replace('.md', '').replace(/-/g, ' ');
    files.push({ path: `harnesses/${f}`, label, group: 'Harnesses' });
  }

  return files;
}

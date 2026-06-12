import { readFile } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { NextResponse } from 'next/server';
import { Timing } from '@/lib/timing';

export async function GET() {
  const t = new Timing();
  try {
    const raw = await readFile(claudePaths.statsCache, 'utf-8');
    t.mark('read_file');
    const data = JSON.parse(raw);
    t.mark('parse');
    return NextResponse.json(data, { headers: { 'Server-Timing': t.header() } });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read stats', detail: String(err) },
      { status: 500 }
    );
  }
}

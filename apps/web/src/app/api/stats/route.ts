import { readFile } from 'fs/promises';
import { claudePaths } from '@unfirehose/core/claude-paths';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const raw = await readFile(claudePaths.statsCache, 'utf-8');
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read stats', detail: String(err) },
      { status: 500 }
    );
  }
}

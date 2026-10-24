import { NextResponse } from 'next/server';

/**
 * A route's refusal or failure: `{ error }` with its status. The todo and
 * session routes spelled the whole `NextResponse.json` out at every early
 * return, which made each handler's opening lines read alike.
 */
export function jsonError(error: string | undefined, status: number) {
  return NextResponse.json({ error }, { status });
}

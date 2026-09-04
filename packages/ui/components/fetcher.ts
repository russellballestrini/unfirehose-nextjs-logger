/**
 * The SWR fetcher, once.
 *
 * Twenty-four files declared their own identical copy. Identical is the
 * problem: when one of them needs to start throwing on a non-2xx, or to
 * carry a header, the other twenty-three quietly keep the old behaviour.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   Deliberately not generic. `useSWR(key, fetcher)` infers its Data from the
   fetcher's return type, and a generic one resolves to `{}` there, which
   breaks every call site that does not name a type. `any` keeps the shape
   these 24 inline copies of `r.json()` already had; a caller that wants
   types writes useSWR<Foo>. */
export async function fetcher(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) {
    // SWR only routes to `error` if the promise rejects. Resolving with a
    // parsed error body is how a 500 renders as an empty page instead of a
    // message.
    const err = new Error(`${res.status} ${res.statusText} — ${url}`) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = await res.json().catch(() => undefined);
    throw err;
  }
  return res.json();
}

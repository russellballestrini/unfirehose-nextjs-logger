/**
 * Writing settings from a page. Every page that edits `/api/settings` did
 * the same two steps by hand: merge the new value into its SWR copy, then
 * POST it.
 */

/** POST one setting; nothing on the page is touched. */
export function postSetting(key: string, value: string): Promise<Response> {
  return fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set', key, value }),
  });
}

/**
 * Merge one setting into the page's cached settings, then POST it. The
 * merge skips revalidation: a refetch would reset the inputs a person is
 * still typing into.
 */
export async function writeSetting(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutate: (update: (prev: any) => any, opts: { revalidate: boolean }) => unknown,
  key: string,
  value: string,
): Promise<void> {
  mutate((prev: Record<string, string> | undefined) => ({ ...prev, [key]: value }), { revalidate: false });
  await postSetting(key, value);
}

import { TtlCache } from './ttl-cache';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What a project's tree and git routes remember, kept in one module so a
 * change through either can forget both. A route file may export only its
 * handlers, so the git route could clear its own status but never reach
 * the tree route's listings — a commit left the file browser showing the
 * tree from before it for up to ten seconds.
 */

/** git status + diff per project. Status changes on every save; 5 s stops a burst of tab switches re-running git. */
export const gitStatusCache = new TtlCache<any>(5_000, 500);

/** Directory listings and file reads keyed `project:path:ref`. 10 s makes clicking through a tree instant. */
export const treeCache = new TtlCache<any>(10_000, 100);

export const treeKey = (project: string, subpath: string, ref: string) => `${project}:${subpath}:${ref}`;

/** Forget everything about a project after something changed its repository. */
export function invalidateProject(project: string): void {
  gitStatusCache.delete(project);
  treeCache.deletePrefix(`${project}:`);
}

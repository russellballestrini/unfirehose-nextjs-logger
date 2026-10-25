// Thin wrapper: our unsandbox integration's shell bridge, 404 while it is off.
// Its handlers live in src/integrations/unsandbox/; see src/integrations/catalog.ts.
import { gated } from '@/integrations/server';
import * as shell from '@/integrations/unsandbox/api/shell';

export const GET = gated('unsandbox', shell.GET);
export const POST = gated('unsandbox', shell.POST);
export const HEAD = gated('unsandbox', shell.HEAD);

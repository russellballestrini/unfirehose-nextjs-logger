// Thin wrapper: our unsandbox integration's session sync, 404 while it is off.
// Its handlers live in src/integrations/unsandbox/; see src/integrations/catalog.ts.
import { gated } from '@/integrations/server';
import * as sync from '@/integrations/unsandbox/api/sync';

export const GET = gated('unsandbox', sync.GET);
export const POST = gated('unsandbox', sync.POST);

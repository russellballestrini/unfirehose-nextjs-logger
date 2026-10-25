// Thin wrapper: our unsandbox integration's proxy, 404 while it is off.
// Its handlers live in src/integrations/unsandbox/; see src/integrations/catalog.ts.
import { gated } from '@/integrations/server';
import * as proxy from '@/integrations/unsandbox/api/proxy';

export const GET = gated('unsandbox', proxy.GET);
export const POST = gated('unsandbox', proxy.POST);

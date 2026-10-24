import { NextRequest, NextResponse } from 'next/server';
import { setSetting } from '@unturf/unfirehose/db/ingest';
import { INTEGRATIONS_ENV, integrationSettingKey, isIntegrationId } from '@/integrations/catalog';
import { integrationState, listIntegrations } from '@/integrations/server';

/**
 * Which optional integrations exist and which are on.
 *
 * Pages read this to decide whether an integration's panels render at all;
 * an integration that is off makes no requests and shows nothing. See
 * src/integrations/catalog.ts for the switch.
 */
export async function GET() {
  return NextResponse.json({ env: INTEGRATIONS_ENV, integrations: listIntegrations() });
}

/** Turn one integration on or off: `{ id, enabled }`. Refused while the env decides. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { id, enabled } = body as { id?: unknown; enabled?: unknown };
  if (!isIntegrationId(id) || typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'Expected { id, enabled: boolean } naming a known integration' }, { status: 400 });
  }
  if (integrationState(id).source === 'env') {
    return NextResponse.json(
      { error: `${INTEGRATIONS_ENV} is set, so the environment decides; unset it to toggle here.` },
      { status: 409 },
    );
  }
  setSetting(integrationSettingKey(id), String(enabled));
  return NextResponse.json({ ok: true, id, ...integrationState(id) });
}

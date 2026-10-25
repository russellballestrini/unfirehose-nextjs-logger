'use client';

// Thin wrapper: the page our unsandbox integration owns, shown only while it
// is on. The page itself lives in src/integrations/unsandbox/.
import { IntegrationPage } from '@/integrations';

export default function UnsandboxNodeRoute() {
  return <IntegrationPage id="unsandbox" />;
}

import type { ServerIntegration } from '../server';
import { bootUnsandbox } from './boot';
import { uploadToUnsandbox } from './upload';

/** What unsandbox adds to routes that are not its own. */
export const unsandboxServer: ServerIntegration = {
  boot: bootUnsandbox,
  upload: uploadToUnsandbox,
};

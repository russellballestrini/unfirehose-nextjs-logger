/** One Host block of ~/.ssh/config, as /api/ssh-config returns it. */
export interface SshHost {
  name: string;
  hostname?: string;
  port?: string;
  user?: string;
  identityFile?: string;
  forwardAgent?: string;
}

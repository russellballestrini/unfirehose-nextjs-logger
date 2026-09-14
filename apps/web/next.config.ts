import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  transpilePackages: ['@unturf/unfirehose', '@unturf/unfirehose-ui'],
  // A self-contained server for the container: Next traces exactly the files
  // the server imports into .next/standalone, so the image copies that tree
  // instead of the whole monorepo's node_modules. The tracing root must be
  // the workspace root, not apps/web, or the traced workspace packages
  // (@unturf/*) and the hoisted node_modules two levels up are left behind.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  // The production build compiles and traces; it does not gate. Types are
  // gated by `make` (tsc across every workspace) in CI, so re-running the
  // check inside `next build` only doubles the work — and its single
  // type-check worker is memory-heavy enough to be OOM-killed on a loaded
  // box, which would fail an image build for a reason CI already covers. Keep
  // the gate where it is; let the build build. (Next 16 runs no eslint during
  // build, so there is no eslint key to set — it was removed and now warns.)
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;

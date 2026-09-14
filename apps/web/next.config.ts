import type { NextConfig } from "next";
import path from "path";

// The standalone build (and its wide, monorepo-root file tracing) is ONLY for
// the container image. It is gated behind an env the Dockerfile sets, so a
// local `next dev` or `next build` is byte-for-byte what it was before the
// Dockerfile existed — the tracing root, the type-check skip, none of it
// touches the machine you develop on.
const forImage = process.env.NEXT_STANDALONE === '1';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  transpilePackages: ['@unturf/unfirehose', '@unturf/unfirehose-ui'],
  ...(forImage
    ? {
        // A self-contained server for the container: Next traces the files the
        // server imports into .next/standalone. The tracing root must be the
        // workspace root, or the traced @unturf/* packages and the hoisted
        // node_modules two levels up are left behind.
        output: 'standalone' as const,
        outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
        // The image build compiles and traces; it does not gate. Types are
        // gated by `make`/CI, and the type-check worker is memory-heavy — so
        // skip it here, where CI already covers it.
        typescript: { ignoreBuildErrors: true },
      }
    : {}),
};

export default nextConfig;

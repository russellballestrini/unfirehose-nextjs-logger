import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  transpilePackages: ['@unfirehose/core', '@unfirehose/ui'],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module chạy phía server, không bundle
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;

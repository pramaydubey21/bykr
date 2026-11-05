import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / server-only modules must not be bundled.
  serverExternalPackages: ["@node-rs/argon2", "pg", "mongodb"],
  // db/06_queries.sql and db/07_dml.sql are read at runtime by the admin pages.
  outputFileTracingIncludes: { "/admin/**": ["./db/*.sql"] },
};

export default nextConfig;

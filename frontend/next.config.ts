import type { NextConfig } from "next";

// The browser talks only to this Next.js server (same origin); /api is proxied to the
// FastAPI backend, which must be on a loopback address.
const backend = process.env.YTA_BACKEND_URL ?? "http://127.0.0.1:8000";
const host = new URL(backend).hostname;
if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
  throw new Error(`YTA_BACKEND_URL must be a loopback URL, got ${backend}`);
}

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // E2E tests build into a separate directory so they never disturb a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Compression buffers responses, which would hold back Server-Sent Events.
  compress: false,
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

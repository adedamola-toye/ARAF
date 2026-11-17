import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Security hardening: never announce the framework (X-Powered-By). Guarded by tests/security-headers.test.ts.
  poweredByHeader: false,
  serverExternalPackages: ["pg", "exceljs", "nodemailer"],
  // Files read at runtime (e.g. the logos on the generated GSI mandate) must ship with the serverless functions.
  outputFileTracingIncludes: { "/**": ["./templates/closing/**"] },
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;

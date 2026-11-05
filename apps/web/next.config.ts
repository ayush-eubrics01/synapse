import type { NextConfig } from "next";

const api = `http://127.0.0.1:${process.env.SYNAPSE_API_PORT ?? "7400"}`;

const config: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/health/:path*", destination: `${api}/health/:path*` },
    ];
  },
};

export default config;

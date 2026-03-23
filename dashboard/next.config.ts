import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/coin/:path*', destination: 'http://localhost:2001/api/:path*' },
      { source: '/ws/:path*', destination: 'http://localhost:2001/ws/:path*' },
    ];
  },
  // LLM CLI 호출이 느릴 수 있으므로 프록시 타임아웃 3분
  httpAgentOptions: {
    keepAlive: true,
  },
  experimental: {
    proxyTimeout: 180000,
  },
};

export default nextConfig;

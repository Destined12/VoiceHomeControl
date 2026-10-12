import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  basePath: '',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

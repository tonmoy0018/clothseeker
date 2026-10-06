import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Image uploads are capped at 4 MB in lib/media/process-image.ts (Vercel Hobby rejects
      // request bodies over 4.5 MB). This leaves room for multipart overhead.
      bodySizeLimit: "4.4mb",
    },
  },
  // The server renderer reads font files from disk (lib/renderer/fonts.ts); make sure they are
  // bundled with every server function, not only served from the CDN.
  outputFileTracingIncludes: {
    "/**": ["./public/fonts/*.ttf"],
  },
};

export default nextConfig;

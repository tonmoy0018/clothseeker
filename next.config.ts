import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Locally the repo lives on an iCloud-synced Desktop, which duplicates build files ("… 2.ts").
  // iCloud never syncs folders ending in ".nosync". Vercel builds keep the standard ".next".
  distDir: process.env.VERCEL ? ".next" : ".next.nosync",
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

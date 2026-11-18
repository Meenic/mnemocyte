import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        // Tailwind runs on global CSS only. Without the module exclusion,
        // `as: "*.css"` turns every .module.css into plain global CSS and
        // its class names come back undefined.
        condition: {
          all: [{ not: "foreign" }, { not: { path: /\.module\.css$/ } }],
        },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

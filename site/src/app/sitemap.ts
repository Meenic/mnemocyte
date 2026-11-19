import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** Every page; add the docs pages when they land. */
const ROUTES = ["/", "/changelog", "/community"];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((route) => ({ url: new URL(route, SITE_URL).href }));
}

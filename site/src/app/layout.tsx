import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mnemocyte",
  description: "Memory for TypeScript AI apps.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <a
          href="#top"
          className="absolute -top-15 left-3 z-100 bg-ink px-3.5 py-2.5 text-sm text-on-ink no-underline focus:top-3"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="top" tabIndex={-1} className="outline-none">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}

import "@fontsource-variable/inter/index.css";
import "./globals.css";

import type { Metadata, Viewport } from "next";

import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: { default: "YT Agent Studio", template: "%s · YT Agent Studio" },
  description: "Local documentary production workspace for youtube-agent",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}

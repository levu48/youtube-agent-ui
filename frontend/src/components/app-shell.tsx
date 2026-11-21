"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { ActiveJobIndicator } from "@/components/active-job-indicator";
import { EngineHealthBadge } from "@/components/health-badges";
import { SidebarNav } from "@/components/sidebar-nav";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

function Brand() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 rounded-md px-2 py-1 text-base font-semibold text-white focus-visible:outline-[var(--sidebar-ring)]"
    >
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-white"
      >
        YT
      </span>
      YT Agent Studio
    </Link>
  );
}

function sectionTitle(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  if (pathname === "/projects/new") return "New Project";
  if (pathname.endsWith("/draft")) return "Draft";
  if (pathname.startsWith("/projects")) return "Projects";
  return "YT Agent Studio";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-white px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <aside
        className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col gap-6 bg-sidebar px-3 py-5 text-sidebar-text lg:flex"
        aria-label="Primary"
      >
        <Brand />
        <SidebarNav pathname={pathname} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-surface/95 px-4 backdrop-blur md:px-8">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[260px] gap-6 border-none bg-sidebar p-5 text-sidebar-text">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">Main sections of the app</SheetDescription>
              <div onClickCapture={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
                <Brand />
              </div>
              <SidebarNav pathname={pathname} onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <p className="truncate text-sm font-medium text-muted-foreground" aria-hidden>
            {sectionTitle(pathname)}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <ActiveJobIndicator />
            <EngineHealthBadge />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

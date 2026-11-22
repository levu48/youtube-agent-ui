import { FileText, FolderOpen, Image, LayoutDashboard, Mic, Search, Settings, Clapperboard } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

const RESEARCH_PATH = /^\/projects\/([^/]+)\/research\/?$/;
const PROJECT_PATH = /^\/projects\/([^/]+)(?:\/|$)/;

/** The project the current page belongs to, if any (not the "new project" form). */
function projectOf(pathname: string): string | null {
  const m = PROJECT_PATH.exec(pathname);
  return m && m[1] !== "new" ? m[1] : null;
}

function activeItems(pathname: string) {
  const project = projectOf(pathname);
  const items = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard, match: (p: string) => p === "/" },
    {
      href: "/projects",
      label: "Projects",
      icon: FolderOpen,
      match: (p: string) => p.startsWith("/projects") && !RESEARCH_PATH.test(p),
    },
  ];
  if (project) {
    // M3: research is per project, so it is a link only inside a project.
    items.push({
      href: `/projects/${project}/research`,
      label: "Research",
      icon: Search,
      match: (p: string) => RESEARCH_PATH.test(p),
    });
  }
  return items;
}

// Future milestones: visible, clearly disabled, never links (docs/ui-design.md §3).
const LATER = [
  { label: "Drafts", icon: FileText },
  { label: "Research", icon: Search, needsProject: true },
  { label: "Visuals", icon: Image },
  { label: "Narration", icon: Mic },
  { label: "Production", icon: Clapperboard },
];

const itemBase =
  "flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sidebar-ring)]";

export function SidebarNav({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {activeItems(pathname).map(({ href, label, icon: Icon, match }) => {
          const current = match(pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={current ? "page" : undefined}
                className={cn(
                  itemBase,
                  current
                    ? "bg-sidebar-active text-white"
                    : "text-sidebar-text hover:bg-white/5 hover:text-white",
                )}
              >
                <Icon aria-hidden className="size-4" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div role="separator" className="my-3 h-px bg-white/10" />
      <p className="px-3 pb-1 text-xs font-medium tracking-wide text-sidebar-text/80 uppercase">
        Coming later
      </p>
      <ul className="flex flex-col gap-1">
        {LATER.filter((x) => !(x.needsProject && projectOf(pathname))).map(({ label, icon: Icon, needsProject }) => (
          <li key={label}>
            <span
              aria-disabled="true"
              className={cn(itemBase, "cursor-not-allowed text-sidebar-text/60")}
            >
              <Icon aria-hidden className="size-4" />
              {label}
              <span className="sr-only">
                {needsProject ? "(open a project to research it)" : "(coming in a later milestone)"}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <ul className="mt-auto">
        <li>
          <span aria-disabled="true" className={cn(itemBase, "cursor-not-allowed text-sidebar-text/60")}>
            <Settings aria-hidden className="size-4" />
            Settings
            <span className="sr-only">(coming in a later milestone)</span>
          </span>
        </li>
      </ul>
    </nav>
  );
}

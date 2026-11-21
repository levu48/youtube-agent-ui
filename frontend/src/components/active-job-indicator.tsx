"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";

import { api } from "@/lib/api";

export function ActiveJobIndicator() {
  const q = useQuery({
    queryKey: ["jobs", "active-indicator"],
    queryFn: () => api.jobs({ limit: 10 }),
    refetchInterval: 5000,
    retry: false,
  });
  const active = (q.data ?? []).filter((j) => j.status === "running" || j.status === "queued");
  if (active.length === 0) return null;
  const first = active[0];
  const running = active.filter((j) => j.status === "running").length;
  return (
    <Link
      href={`/projects/${encodeURIComponent(first.project_id)}?job=${first.id}`}
      className="hidden items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100 sm:inline-flex"
    >
      <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" />
      {running > 0 ? `${running} job running` : "Job queued"}
      {active.length > 1 ? ` (+${active.length - 1})` : ""}
    </Link>
  );
}

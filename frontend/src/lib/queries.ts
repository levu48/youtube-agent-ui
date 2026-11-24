"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const qk = {
  engine: ["engine"] as const,
  ollama: ["ollama"] as const,
  config: ["config"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  projectStatus: (id: string) => ["project", id, "status"] as const,
  draft: (id: string) => ["project", id, "draft"] as const,
  draftAvailable: (id: string) => ["project", id, "draft-available"] as const,
  // Under the project key, so a finished job's refresh covers it.
  research: (id: string) => ["project", id, "research"] as const,
  snapshot: (id: string, snapshotId: string) => ["project", id, "snapshot", snapshotId] as const,
  history: (id: string, subject?: string) => ["project", id, "research-history", subject ?? "all"] as const,
  narration: (id: string) => ["project", id, "narration"] as const,
  visuals: (id: string) => ["project", id, "visuals"] as const,
  jobs: (projectId?: string) => ["jobs", projectId ?? "all"] as const,
  job: (id: string) => ["job", id] as const,
  discoverable: ["discoverable"] as const,
};

export const useEngine = () =>
  useQuery({ queryKey: qk.engine, queryFn: api.engine, staleTime: 60_000, retry: 1 });
export const useOllama = () =>
  useQuery({ queryKey: qk.ollama, queryFn: api.ollama, staleTime: 30_000, retry: 1 });
export const useConfig = () =>
  useQuery({ queryKey: qk.config, queryFn: api.config, staleTime: Infinity, retry: 1 });

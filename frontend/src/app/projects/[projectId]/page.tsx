import type { Metadata } from "next";
import { Suspense } from "react";

import { LoadingSkeleton } from "@/components/states";
import { ProjectWorkspaceView } from "@/views/project-workspace-view";

export const metadata: Metadata = { title: "Project" };

export default function Page() {
  return (
    <Suspense fallback={<LoadingSkeleton label="Loading project" />}>
      <ProjectWorkspaceView />
    </Suspense>
  );
}

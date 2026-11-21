import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { ProjectCreateForm } from "@/components/project-create-form";

export const metadata: Metadata = { title: "New Project" };

export default function Page() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="New Project"
        subtitle="Create an engine project. You can generate the draft on the next screen."
        breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: "New Project" }]}
      />
      <div className="rounded-[var(--radius-panel)] border bg-surface p-5 md:p-8">
        <ProjectCreateForm />
      </div>
    </div>
  );
}

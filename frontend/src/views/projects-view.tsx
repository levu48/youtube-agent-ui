"use client";

import { Plus } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EngineAlert } from "@/views/dashboard-view";
import { DiscoverableProjects, ProjectGrid } from "@/views/project-list";

export function ProjectsView() {
  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="All documentary projects in your local projects folder"
        actions={
          <Button asChild size="lg">
            <Link href="/projects/new">
              <Plus aria-hidden /> New Project
            </Link>
          </Button>
        }
      />
      <div className="space-y-6">
        <EngineAlert />
        <DiscoverableProjects />
        <ProjectGrid />
      </div>
    </>
  );
}

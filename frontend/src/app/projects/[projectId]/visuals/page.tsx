import type { Metadata } from "next";

import { VisualsView } from "@/views/visuals-view";

export const metadata: Metadata = { title: "Visuals" };

export default function Page() {
  return <VisualsView />;
}

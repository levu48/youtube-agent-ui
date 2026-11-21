import type { Metadata } from "next";

import { DraftView } from "@/views/draft-view";

export const metadata: Metadata = { title: "Draft" };

export default function Page() {
  return <DraftView />;
}

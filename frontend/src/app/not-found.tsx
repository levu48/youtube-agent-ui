import Link from "next/link";

import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="This page does not exist in the local studio."
      action={
        <Button asChild>
          <Link href="/">Back to Dashboard</Link>
        </Button>
      }
    />
  );
}

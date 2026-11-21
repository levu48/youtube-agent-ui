import { AlertCircle, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed bg-surface px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="size-8 text-muted-foreground" /> : null}
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <div className="max-w-prose text-sm text-muted-foreground">{description}</div> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Retry",
  className,
}: {
  title?: string;
  message?: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-3 rounded-[var(--radius-card)] border border-red-200 bg-red-50 p-4 text-sm text-danger sm:flex-row sm:items-start",
        className,
      )}
    >
      <AlertCircle aria-hidden className="size-5 shrink-0" />
      <div className="flex-1 space-y-1">
        <p className="font-semibold">{title}</p>
        {message ? <div className="text-red-900">{message}</div> : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="bg-white">
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingSkeleton({
  rows = 3,
  className,
  label = "Loading",
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("space-y-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-24 w-full rounded-[var(--radius-card)]" />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

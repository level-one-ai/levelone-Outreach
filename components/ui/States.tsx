"use client";

import { motion } from "framer-motion";

/**
 * Shared loading / empty / error states.
 *
 * Every list in this app is loaded over the network, and a skeleton that
 * matches the real card's shape is what stops the page shifting under the
 * cursor when the data lands.
 */

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card-tight">
      <div className="skeleton mb-3 h-4 w-3/5 rounded" />
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton mb-2 h-3 rounded"
          style={{ width: `${85 - i * 15}%` }}
        />
      ))}
    </div>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon: Icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}) {
  return (
    <motion.div
      className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      {Icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface">
          <Icon className="h-5 w-5 text-muted" />
        </div>
      )}
      <p className="text-fluid-base font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-md text-fluid-sm text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </motion.div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-fluid-base font-medium text-foreground">
        Something went wrong
      </p>
      {/* The real reason, verbatim. A generic "try again" would hide the one
          piece of information that makes the problem fixable. */}
      <p className="max-w-lg text-fluid-sm leading-relaxed text-muted">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn-ghost btn-sm mt-2">
          Try again
        </button>
      )}
    </div>
  );
}

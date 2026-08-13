"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

interface PageTransitionContextValue {
  /** Fade the current page out, then navigate to `href`. */
  leave: (href: string) => void;
}

const PageTransitionContext = createContext<PageTransitionContextValue | null>(
  null
);

/** Null when the page isn't wrapped in a PageTransition — fall back to instant navigation. */
export function usePageTransition() {
  return useContext(PageTransitionContext);
}

/**
 * Route-boundary transitions, carried over from the Level One Proposal
 * Engine: content enters by rising in from below and leaves with a fade before
 * the router push fires. Timings and easing are unchanged from that system
 * (exit 0.35s, enter 0.45s) so both apps move identically.
 */
export default function PageTransition({
  children,
  chrome,
  enter = true,
}: {
  children: ReactNode;
  /** Persistent chrome (e.g. the header bar) that must not fade with the page
      content but still needs access to the transition context. */
  chrome?: ReactNode;
  /** Set false when the page content animates itself in (e.g. the entry card). */
  enter?: boolean;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);

  const leave = useCallback((href: string) => setTarget(href), []);

  return (
    <PageTransitionContext.Provider value={{ leave }}>
      {chrome}
      <AnimatePresence
        mode="wait"
        onExitComplete={() => {
          if (target) router.push(target);
        }}
      >
        {target === null && (
          <motion.div
            key="page"
            className="flex h-full min-h-0 flex-1 flex-col"
            initial={enter ? { opacity: 0, y: 24 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.35 } }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </PageTransitionContext.Provider>
  );
}

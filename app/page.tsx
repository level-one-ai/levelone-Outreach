"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Inbox, LayoutGrid, PhoneCall } from "lucide-react";

import BrandMark from "@/components/BrandMark";
import PageTransition, { usePageTransition } from "@/components/PageTransition";

const MODULES = [
  {
    href: "/trades",
    label: "Trades",
    Icon: PhoneCall,
    description:
      "Grid-scrape local trades past Google's 120-result cap, screen them against TPS, and work the calling list.",
  },
  {
    href: "/b2b",
    label: "B2B Campaigns",
    Icon: LayoutGrid,
    description:
      "Scrape and verify B2B contacts, enrol them in a campaign, and track the follow-up sequence on the Kanban board.",
  },
  {
    href: "/inbox",
    label: "AI Inbox",
    Icon: Inbox,
    description:
      "Review replies sorted by AI sentiment, approve the drafted response, and start the 24-hour booking tracker.",
  },
] as const;

function ModuleCard({
  href,
  label,
  description,
  Icon,
  index,
}: (typeof MODULES)[number] & { index: number }) {
  const transition = usePageTransition();

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      // Staggered so the three cards arrive as a sequence rather than a jump.
      transition={{ duration: 0.45, delay: 0.1 + index * 0.08, ease: [0.22, 1, 0.36, 1] }}
    >
      <Link
        href={href}
        onClick={(e) => {
          if (!transition || e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          transition.leave(href);
        }}
        className="group flex h-full flex-col rounded-3xl border border-line bg-white/60 p-6 shadow-[0_24px_80px_-32px_rgba(17,17,16,0.18)] backdrop-blur-xl transition-all hover:-translate-y-1 hover:border-foreground/25 hover:shadow-[0_32px_90px_-30px_rgba(17,17,16,0.28)]"
      >
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface">
          <Icon className="h-5 w-5 text-foreground" />
        </div>

        <h2 className="mb-2 text-fluid-lg font-semibold tracking-tight text-foreground">
          {label}
        </h2>
        <p className="mb-6 flex-1 text-fluid-sm leading-relaxed text-muted">
          {description}
        </p>

        <span className="inline-flex items-center gap-2 text-fluid-xs font-medium uppercase tracking-widest text-foreground">
          Open
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
        </span>
      </Link>
    </motion.div>
  );
}

export default function HomePage() {
  return (
    <PageTransition>
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center gap-10 px-5 py-16 sm:px-8">
        <motion.div
          className="flex flex-col items-center gap-3"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <BrandMark />
        </motion.div>

        <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-3">
          {MODULES.map((m, i) => (
            <ModuleCard key={m.href} {...m} index={i} />
          ))}
        </div>
      </main>
    </PageTransition>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, LayoutGrid, PhoneCall, Users } from "lucide-react";

import { usePageTransition } from "@/components/PageTransition";

/**
 * Minimalist top bar — brand text top-left, module switcher top-right,
 * sitting outside the main content area. Carried over from the Proposal
 * Engine's HeaderBar, with its proposal links replaced by the three modules.
 */

const MODULES = [
  { href: "/trades", label: "Trades", Icon: PhoneCall },
  { href: "/leads", label: "Leads", Icon: Users },
  { href: "/b2b", label: "B2B", Icon: LayoutGrid },
  { href: "/inbox", label: "Inbox", Icon: Inbox },
] as const;

export default function HeaderBar() {
  const transition = usePageTransition();
  const pathname = usePathname();

  /* When a PageTransition wraps the page, fade the content out before the
     route push so navigation feels continuous. Modified clicks (new tab etc.)
     keep native link behavior, and a link to the current route must not fade
     the page it would stay on. */
  const navigate =
    (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!transition || href === pathname) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
        return;
      e.preventDefault();
      transition.leave(href);
    };

  return (
    <header className="relative z-10 flex shrink-0 items-center justify-between gap-4 px-4 py-4 sm:px-8 sm:py-5">
      <Link
        href="/"
        onClick={navigate("/")}
        className="flex items-center gap-2.5 text-fluid-xs font-medium uppercase tracking-[0.3em] text-muted transition-colors hover:text-foreground"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.png" alt="" className="h-6 w-6 object-contain" />
        <span className="hidden xs:inline">Level One</span>
      </Link>

      <nav className="flex items-center gap-1.5 sm:gap-2">
        {MODULES.map(({ href, label, Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={navigate(href)}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-10 items-center gap-2 rounded-full border px-3 text-fluid-xs font-medium tracking-wide backdrop-blur-md transition-all active:scale-95 sm:px-4 ${
                active
                  ? "border-foreground/25 bg-foreground text-cream shadow-lift"
                  : "border-line bg-white/70 text-muted hover:border-foreground/30 hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden xs:inline">{label}</span>
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

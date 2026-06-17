"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Terminal } from "lucide-react";
import { AccountMenu } from "@/components/AccountMenu";

// Public pages that should not show the authenticated app chrome (nav + account).
const CHROMELESS_PATHS = new Set(["/logged-out", "/gate"]);

export function SiteHeader() {
  const pathname = usePathname();
  // The session workspace is a full-viewport layout with its own top bar — no global nav.
  if (CHROMELESS_PATHS.has(pathname) || pathname.startsWith("/session/")) {
    return null;
  }
  const onCatalog = pathname.startsWith("/catalog") || pathname.startsWith("/play");
  const onLabs = pathname.startsWith("/labs") || pathname.startsWith("/session");

  return (
    <nav className="app-nav">
      <Link href="/" className="brand">
        <span className="brand__mark" aria-hidden>
          <Terminal size={15} />
        </span>
        Ops Coach
      </Link>
      <Link href="/catalog" className={`nav-link${onCatalog ? " active" : ""}`}>
        Catalog
      </Link>
      <Link href="/labs" className={`nav-link${onLabs ? " active" : ""}`}>
        My labs
      </Link>
      <div className="nav-spacer" />
      <AccountMenu />
    </nav>
  );
}

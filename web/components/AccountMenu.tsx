"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Key, LayoutGrid, LogOut, User } from "lucide-react";

function initials(email: string | null): string {
  if (!email) return "";
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export function AccountMenu() {
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/me")
      .then((res) => res.json())
      .then((data: { email?: string | null }) => {
        if (active) setEmail(data.email ?? null);
      })
      .catch(() => {
        // identity is optional (e.g. local dev) — degrade quietly
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = email ?? "Account";

  return (
    <div className="account" ref={ref}>
      <button
        type="button"
        className="account-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" aria-hidden>
          {email ? initials(email) : <User size={14} />}
        </span>
        <span className="account-email">{label}</span>
        <ChevronDown size={15} aria-hidden />
      </button>

      {open ? (
        <div className="account-menu" role="menu">
          <div className="account-menu__head">
            <div className="account-menu__email">{label}</div>
            <div className="account-menu__sub">
              {email ? "Signed in via Google" : "Not signed in"}
            </div>
          </div>
          <Link className="menu-item" role="menuitem" href="/labs" onClick={() => setOpen(false)}>
            <LayoutGrid size={16} aria-hidden />
            My labs
          </Link>
          <Link
            className="menu-item"
            role="menuitem"
            href="/account/keys"
            onClick={() => setOpen(false)}
          >
            <Key size={16} aria-hidden />
            SSH keys
          </Link>
          <div className="menu-sep" />
          <a className="menu-item" role="menuitem" href="/logout">
            <LogOut size={16} aria-hidden />
            Sign out
          </a>
        </div>
      ) : null}
    </div>
  );
}

import Link from "next/link";
import { headers } from "next/headers";
import { LayoutGrid } from "lucide-react";
import { readAlbIdentity } from "@/lib/identity";
import { ensureMigrated, listSessionsForOwner } from "@/lib/db";
import { findCatalogEntry } from "@/lib/content";
import type { SessionStatus } from "@/lib/types";

// Reads the per-request ALB identity header, so it can never be statically prerendered.
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<SessionStatus, string> = {
  provisioning: "Provisioning",
  ready: "Ready",
  running: "Ready",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};

function statusVariant(status: SessionStatus): string {
  if (status === "ready" || status === "running") return "ready";
  if (status === "provisioning") return "provisioning";
  if (status === "failed") return "failed";
  return "stopped";
}

function humanize(value: string): string {
  const s = value.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export default async function MyLabsPage() {
  const identity = await readAlbIdentity({ headers: await headers() });

  if (!identity) {
    return (
      <main className="page page--narrow">
        <header className="page-header">
          <div className="page-header__main">
            <h1 className="page-title">My labs</h1>
          </div>
        </header>
        <div className="notice">
          Sign in to see your labs. You can start one from the{" "}
          <Link href="/catalog">catalog</Link>.
        </div>
      </main>
    );
  }

  await ensureMigrated();
  const sessions = await listSessionsForOwner(identity.sub);

  return (
    <main className="page">
      <header className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">My labs</h1>
          <p className="page-subtitle">Labs you&apos;ve started, newest first.</p>
        </div>
      </header>

      {sessions.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">
            <LayoutGrid size={28} aria-hidden />
          </div>
          <h2>No labs yet</h2>
          <p className="muted">Start your first lab from the catalog.</p>
          <p style={{ marginTop: "1rem" }}>
            <Link className="button btn--accent" href="/catalog">
              Browse catalog
            </Link>
          </p>
        </div>
      ) : (
        <div className="lab-rows">
          {sessions.map((session) => {
            const entry = findCatalogEntry(session.packId, session.labId);
            const title = entry?.labTitle ?? humanize(session.labId);
            const pack = entry?.packTitle ?? humanize(session.packId);
            const score = session.latestGrader?.score ?? null;
            return (
              <Link key={session.id} href={`/session/${session.id}`} className="lab-row">
                <div className="lab-row__main">
                  <div className="lab-row__title">{title}</div>
                  <div className="lab-row__meta">
                    {pack} · {humanize(session.mode)} · {timeAgo(session.createdAt)}
                  </div>
                </div>
                {score ? (
                  <span className="score-pill">
                    {score.passed}/{score.total}
                  </span>
                ) : null}
                <span className={`status status--${statusVariant(session.status)}`}>
                  <span className="status__dot" aria-hidden />
                  {STATUS_LABEL[session.status]}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}

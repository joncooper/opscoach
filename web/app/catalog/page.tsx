import Link from "next/link";
import { Clock } from "lucide-react";
import { getCatalogGrouped } from "@/lib/content";

export default function CatalogPage() {
  let packs = [] as ReturnType<typeof getCatalogGrouped>;
  let error: string | null = null;
  try {
    packs = getCatalogGrouped();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load catalog";
  }

  return (
    <main className="page">
      <header className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Catalog</h1>
          <p className="page-subtitle">
            Hands-on Linux and cloud security labs. Pick a lab, start a session, and
            get live grading feedback.
          </p>
        </div>
      </header>

      {error ? (
        <div className="error-banner">{error}</div>
      ) : (
        <div className="stack">
          {packs.map((pack) => (
            <section key={pack.packId}>
              <div className="section__head">
                <h2>{pack.packTitle}</h2>
                <span className="muted" style={{ fontSize: "0.8125rem" }}>
                  {pack.labs.length} {pack.labs.length === 1 ? "lab" : "labs"}
                </span>
              </div>
              <div className="lab-grid">
                {pack.labs.map((lab) => (
                  <article key={`${lab.packId}:${lab.labId}`} className="card lab-card">
                    <h3>{lab.labTitle}</h3>
                    <p>{lab.summary}</p>
                    <div className="meta">
                      <span className="badge">{lab.kind}</span>
                      {lab.isAwsLab ? <span className="badge badge--accent">AWS</span> : null}
                      <span className="meta__sep">{lab.moduleTitle}</span>
                      <span className="meta__sep" style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                        <Clock size={13} aria-hidden />
                        {lab.estimatedMinutes} min
                      </span>
                    </div>
                    <div className="lab-card__foot">
                      <Link className="button btn--accent btn--sm" href={`/play/${lab.packId}/${lab.labId}`}>
                        Start lab
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

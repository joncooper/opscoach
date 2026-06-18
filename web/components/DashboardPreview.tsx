"use client";

import { useEffect, useState } from "react";

// The Beacon's public-facing dashboard, fetched through /api/sessions/<id>/preview and
// rendered into a sandboxed iframe via srcDoc. Framed like a little browser window so it
// reads clearly as "what the public sees" — and it heals in place every few seconds as the
// keeper repairs the service (fetching, not reloading an iframe src, avoids a perpetual spinner).
export function DashboardPreview({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/preview?token=${encodeURIComponent(
            token
          )}`
        );
        const text = await res.text();
        if (active) setHtml(text);
      } catch {
        // transient — keep the last good frame
      }
    };
    load();
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        load();
      }
    }, 8000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [sessionId, token]);

  return (
    <div>
      <div className="dashframe">
        <div className="dashframe__chrome">
          <span className="dashframe__dot dashframe__dot--r" />
          <span className="dashframe__dot dashframe__dot--y" />
          <span className="dashframe__dot dashframe__dot--g" />
          <span className="dashframe__addr">beacon · /dashboard</span>
          <span className="dashframe__live">
            <span className="dashframe__pulse" aria-hidden />
            live
          </span>
        </div>
        <div className="dashframe__screen">
          {html != null ? (
            <iframe
              srcDoc={html}
              sandbox=""
              title="Live Beacon dashboard"
              style={{ width: "100%", height: "100%", border: 0, display: "block" }}
            />
          ) : (
            <span className="dashframe__loading">Connecting to the host…</span>
          )}
        </div>
      </div>
      <p className="help" style={{ marginTop: "0.5rem" }}>
        What the public sees at the Beacon&apos;s URL, pulled live from the host and self-healing
        as you light lanterns.
      </p>
    </div>
  );
}

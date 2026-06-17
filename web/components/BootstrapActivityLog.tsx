"use client";

import { useEffect, useState } from "react";
import type { BootstrapProgressEntry } from "@/lib/bootstrap-progress";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function BootstrapActivityLog({
  entries,
}: {
  entries: BootstrapProgressEntry[];
}) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="bootstrap-activity-log" aria-live="polite" aria-relevant="additions">
      {entries.map((entry, index) => (
        <div key={`${entry.at}-${index}`} className="bootstrap-activity-log__line">
          <span className="bootstrap-activity-log__time">{formatTime(entry.at)}</span>
          <span className="bootstrap-activity-log__text">{entry.detail}</span>
        </div>
      ))}
    </div>
  );
}

export function ProvisioningElapsed({ since }: { since: string | null | undefined }) {
  const elapsed = useElapsedLabel(since);
  if (!elapsed) {
    return null;
  }
  return <p className="muted provisioning-elapsed">Elapsed: {elapsed}</p>;
}

function useElapsedLabel(since: string | null | undefined): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!since) {
      setLabel(null);
      return;
    }
    const start = Date.parse(since);
    if (Number.isNaN(start)) {
      setLabel(null);
      return;
    }

    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      setLabel(mins > 0 ? `${mins}m ${secs}s` : `${secs}s`);
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);

  return label;
}

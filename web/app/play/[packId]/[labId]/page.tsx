"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Terminal } from "lucide-react";
import { LabBrief } from "@/components/LabBrief";
import type { LabCatalogEntry } from "@/lib/types";

export default function PlayPage({
  params,
}: {
  params: Promise<{ packId: string; labId: string }>;
}) {
  const router = useRouter();
  const [packId, setPackId] = useState("");
  const [labId, setLabId] = useState("");
  const [lab, setLab] = useState<LabCatalogEntry | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [mode, setMode] = useState<"practice" | "assessment">("practice");
  const [showHints, setShowHints] = useState(false);
  const [sshMode, setSshMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    function applyDefault(key: string) {
      if (!active || !key.trim()) return;
      setPublicKey((current) => current.trim() || key.trim());
    }
    async function loadDefaultKey() {
      // Prefer the signed-in user's saved key; fall back to the env-configured dev default.
      try {
        const res = await fetch("/api/me/ssh-key");
        const data = (await res.json()) as { key?: string | null };
        if (typeof data.key === "string" && data.key.trim()) {
          applyDefault(data.key);
          return;
        }
      } catch {
        // fall through to the config default
      }
      try {
        const res = await fetch("/api/config");
        const data = (await res.json()) as { defaultLearnerPublicKey?: string };
        applyDefault(data.defaultLearnerPublicKey ?? "");
      } catch {
        // optional — user can still paste a key
      }
    }
    loadDefaultKey();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    params.then((value) => {
      setPackId(value.packId);
      setLabId(value.labId);
    });
  }, [params]);

  useEffect(() => {
    if (!packId || !labId) return;
    fetch(`/api/labs?packId=${encodeURIComponent(packId)}`)
      .then((res) => res.json())
      .then((data) => {
        const match = (data.labs as LabCatalogEntry[] | undefined)?.find(
          (entry) => entry.labId === labId
        );
        setLab(match ?? null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load lab");
      });
  }, [packId, labId]);

  async function startLab() {
    if (!lab) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packId: lab.packId,
          labId: lab.labId,
          // Browser-terminal launches send no key (the grader key grants the web shell);
          // a key is only submitted when the learner opts into SSH.
          publicKey: sshMode ? publicKey : "",
          mode,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to create session");
      }
      if (data.session?.status === "failed") {
        throw new Error(data.session.errorMessage ?? "Lab failed to start");
      }
      sessionStorage.setItem(`opscoach:token:${data.session.id}`, data.token);
      router.push(`/session/${data.session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start lab");
    } finally {
      setLoading(false);
    }
  }

  const hintsVisible = mode === "practice" && lab && lab.hints.length > 0;

  return (
    <main className="page page--narrow">
      <header className="page-header">
        <div className="page-header__main">
          <div className="breadcrumb">
            <Link href="/catalog">Browse all labs</Link>
            {lab?.packTitle ? ` / ${lab.packTitle}` : ""}
          </div>
          <h1 className="page-title">{lab?.labTitle ?? "Loading lab…"}</h1>
          {lab?.summary ? <p className="page-subtitle">{lab.summary}</p> : null}
        </div>
      </header>

      {lab?.prompt ? <LabBrief prompt={lab.prompt} summary={lab.summary} /> : null}

      <section className="card card--pad-lg" style={{ marginTop: "1.25rem" }}>
        {error ? <div className="error-banner">{error}</div> : null}
        {lab?.isAwsLab ? (
          <div className="notice" style={{ marginBottom: "1.1rem" }}>
            This lab uses a dedicated AWS account with short-lived credentials on the
            lab host.
          </div>
        ) : null}
        <div className="field">
          <label htmlFor={sshMode ? "public-key" : undefined}>How you&apos;ll connect</label>
          {!sshMode ? (
            <>
              <div className="connect-card">
                <span className="connect-card__icon" aria-hidden>
                  <Terminal size={18} />
                </span>
                <div>
                  <strong>Browser terminal</strong>
                  <span className="connect-card__sub">
                    Work right here — nothing to install.
                  </span>
                </div>
              </div>
              <p className="help">
                Prefer your own client?{" "}
                <button type="button" className="linklike" onClick={() => setSshMode(true)}>
                  I&apos;ll SSH in myself
                </button>
              </p>
            </>
          ) : (
            <>
              <textarea
                id="public-key"
                className="mono"
                rows={4}
                placeholder="ssh-ed25519 AAAA... you@host"
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
              />
              <p className="help">
                Paste your public key to connect from your own client, then Start.{" "}
                <button type="button" className="linklike" onClick={() => setSshMode(false)}>
                  Use the browser terminal instead
                </button>
              </p>
            </>
          )}
        </div>
        <div className="field">
          <label htmlFor="mode">Mode</label>
          <select
            id="mode"
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as "practice" | "assessment")
            }
          >
            <option value="practice">Practice — hints and check details</option>
            <option value="assessment">Assessment — no hints or check details</option>
          </select>
        </div>
        {hintsVisible ? (
          <div className="field">
            <button
              type="button"
              className="secondary btn--sm"
              onClick={() => setShowHints((current) => !current)}
            >
              {showHints ? "Hide hints" : `Show hints (${lab.hints.length})`}
            </button>
            {showHints ? (
              <ul style={{ marginTop: "0.75rem", paddingLeft: "1.25rem", color: "var(--text-secondary)" }}>
                {lab.hints.map((hint) => (
                  <li key={hint} style={{ marginBottom: "0.35rem" }}>
                    {hint}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="toolbar">
          <button className="btn--accent" disabled={loading || !lab} onClick={startLab}>
            {loading ? "Starting…" : "Start lab"}
          </button>
        </div>
      </section>
    </main>
  );
}

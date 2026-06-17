"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Key } from "lucide-react";

interface KeyState {
  signedIn: boolean;
  key: string | null;
  updatedAt: string | null;
}

function fingerprintHint(key: string): string {
  const parts = key.split(/\s+/);
  const type = parts[0] ?? "";
  const comment = parts.slice(2).join(" ");
  const blob = parts[1] ?? "";
  const tail = blob.slice(-12);
  return `${type} …${tail}${comment ? `  ${comment}` : ""}`;
}

export default function SshKeysPage() {
  const [state, setState] = useState<KeyState | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  useEffect(() => {
    fetch("/api/me/ssh-key")
      .then((res) => res.json())
      .then((data: KeyState) => setState(data))
      .catch(() => setState({ signedIn: false, key: null, updatedAt: null }));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedAt(false);
    try {
      const res = await fetch("/api/me/ssh-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to save key");
      }
      setState((prev) => ({
        signedIn: true,
        key: data.key,
        updatedAt: new Date().toISOString(),
      }));
      setDraft("");
      setSavedAt(true);
      setTimeout(() => setSavedAt(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSaving(false);
    }
  }

  const hasKey = Boolean(state?.key);

  return (
    <main className="page page--narrow">
      <header className="page-header">
        <div className="page-header__main">
          <div className="breadcrumb">Account</div>
          <h1 className="page-title">SSH keys</h1>
          <p className="page-subtitle">
            Save a default public key so you don&apos;t have to paste it every time you
            start a lab. The matching private key stays on your machine.
          </p>
        </div>
      </header>

      {state && !state.signedIn ? (
        <div className="notice" style={{ marginBottom: "1.25rem" }}>
          You&apos;re not signed in, so a key can&apos;t be saved to your account. You can
          still paste a key per lab on the{" "}
          <Link href="/catalog">catalog</Link>.
        </div>
      ) : null}

      <section className="card card--pad-lg">
        <div className="section__head" style={{ marginBottom: "0.85rem" }}>
          <h2 className="section__title">Default key</h2>
          {state?.updatedAt ? (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              updated {new Date(state.updatedAt).toLocaleDateString()}
            </span>
          ) : null}
        </div>

        {hasKey ? (
          <div
            className="ssh-block"
            style={{ marginBottom: "1.1rem" }}
            aria-label="Current default key"
          >
            <Key size={15} style={{ color: "var(--code-muted)", flexShrink: 0 }} aria-hidden />
            <span className="ssh-block__cmd">{fingerprintHint(state!.key!)}</span>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: "0.875rem", marginTop: 0 }}>
            No default key saved yet.
          </p>
        )}

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="field">
          <label htmlFor="new-key">{hasKey ? "Replace key" : "Add a key"}</label>
          <textarea
            id="new-key"
            className="mono"
            rows={4}
            placeholder="ssh-ed25519 AAAA... you@host"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={state ? !state.signedIn : true}
          />
          <p className="help">Paste a single public key (an ed25519, ecdsa, or rsa key).</p>
        </div>

        <div className="toolbar">
          <button
            className="btn--accent"
            disabled={saving || !draft.trim() || (state ? !state.signedIn : true)}
            onClick={save}
          >
            {saving ? "Saving…" : savedAt ? "Saved" : hasKey ? "Replace key" : "Save key"}
          </button>
          {savedAt ? (
            <span className="status status--ready" style={{ marginLeft: "0.25rem" }}>
              <Check size={14} aria-hidden /> Saved
            </span>
          ) : null}
        </div>
      </section>
    </main>
  );
}

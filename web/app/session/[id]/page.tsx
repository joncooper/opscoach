"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CircleCheck,
  CircleDashed,
  Copy,
  Download,
  Terminal,
  Volume2,
  VolumeX,
  XCircle,
} from "lucide-react";
import { WebTerminal } from "@/components/WebTerminal";
import { DashboardPreview } from "@/components/DashboardPreview";
import { playDawn, playLantern, unlockAudio } from "@/lib/sounds";
import {
  BootstrapActivityLog,
  ProvisioningElapsed,
} from "@/components/BootstrapActivityLog";
import { ProvisioningSteps } from "@/components/ProvisioningSteps";
import type { BootstrapProgressEntry } from "@/lib/bootstrap-progress";
import { learnerSshHost } from "@/lib/ip-address";
import type { StepStatus } from "@/lib/provisioning-steps";
import { deriveProvisioningSteps, type StepOverrides } from "@/lib/provisioning-steps";
import type { CheckResult, GraderResult, SessionState } from "@/lib/types";

function humanize(value: string | undefined | null): string {
  if (!value) return "";
  const s = value.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function CheckIcon({ status }: { status: CheckResult["status"] }) {
  if (status === "pass") {
    return <CircleCheck size={18} className="check-item__icon check-item__icon--pass" aria-hidden />;
  }
  if (status === "fail") {
    return <XCircle size={18} className="check-item__icon check-item__icon--fail" aria-hidden />;
  }
  if (status === "warning") {
    return <AlertCircle size={18} className="check-item__icon check-item__icon--warning" aria-hidden />;
  }
  return <CircleDashed size={18} className="check-item__icon check-item__icon--pending" aria-hidden />;
}

const STATUS_LABEL: Record<string, string> = {
  provisioning: "Provisioning",
  ready: "Ready",
  running: "Ready",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};

function StatusBadge({ status }: { status: SessionState["status"] | undefined }) {
  const variant =
    !status
      ? "stopped"
      : status === "ready" || status === "running"
        ? "ready"
        : status === "provisioning"
          ? "provisioning"
          : status === "failed"
            ? "failed"
            : "stopped";
  return (
    <span className={`status status--${variant}`}>
      <span className="status__dot" aria-hidden />
      {status ? STATUS_LABEL[status] ?? humanize(status) : "Loading"}
    </span>
  );
}

function sshKeyFilename(session: SessionState): string {
  return `opscoach-${session.id.slice(0, 8)}.key`;
}

function buildSshCommand(session: SessionState): string | null {
  const sshHost = learnerSshHost(session.sshHost);
  if (!sshHost) {
    return null;
  }
  const port = session.sshPort ?? 22;
  const user = session.sshUser ?? "learner";
  const file = `~/Downloads/${sshKeyFilename(session)}`;
  return `chmod 600 ${file} && ssh -i ${file} -p ${port} -o StrictHostKeyChecking=accept-new ${user}@${sshHost}`;
}

function mergeBootstrapProgress(
  current: BootstrapProgressEntry[],
  incoming: BootstrapProgressEntry[] | undefined
): BootstrapProgressEntry[] {
  if (!incoming?.length) {
    return current;
  }
  const seen = new Set(current.map((entry) => `${entry.at}:${entry.detail}`));
  const merged = [...current];
  for (const entry of incoming) {
    const key = `${entry.at}:${entry.detail}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }
  return merged.slice(-40);
}

function applySessionPayload(
  data: {
    session?: SessionState | null;
    lab?: { prompt?: string; summary?: string } | null;
  },
  setSession: (value: SessionState | null | ((current: SessionState | null) => SessionState | null)) => void,
  setChecks: (value: CheckResult[] | ((current: CheckResult[]) => CheckResult[])) => void,
  setScore: (
    value: GraderResult["score"] | null | ((current: GraderResult["score"] | null) => GraderResult["score"] | null)
  ) => void,
  setLabPrompt?: (value: string) => void,
  setBootstrapLog?: (value: BootstrapProgressEntry[] | ((current: BootstrapProgressEntry[]) => BootstrapProgressEntry[])) => void
) {
  const next = data.session ?? null;
  setSession(next);
  if (setBootstrapLog && next?.bootstrapProgress) {
    setBootstrapLog((current) => mergeBootstrapProgress(current, next.bootstrapProgress));
  }
  if (next?.latestGrader) {
    setChecks(next.latestGrader.checks);
    setScore(next.latestGrader.score);
  }
  if (setLabPrompt && data.lab?.prompt) {
    setLabPrompt(data.lab.prompt);
  }
}

export default function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [sessionId, setSessionId] = useState("");
  const [session, setSession] = useState<SessionState | null>(null);
  const [labPrompt, setLabPrompt] = useState("");
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [score, setScore] = useState<GraderResult["score"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [grading, setGrading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [keyState, setKeyState] = useState<
    "idle" | "downloading" | "done" | "error"
  >("idle");
  const [stepOverrides, setStepOverrides] = useState<StepOverrides>({});
  const [bootstrapLog, setBootstrapLog] = useState<BootstrapProgressEntry[]>([]);
  const [channel, setChannel] = useState<"web" | "ssh">("web");
  const [soundOn, setSoundOn] = useState(true);
  const passedRef = useRef<Set<string>>(new Set());
  const soundSeededRef = useRef(false);
  const dawnPlayedRef = useRef(false);
  const token = useMemo(() => {
    if (!sessionId || typeof window === "undefined") return null;
    return sessionStorage.getItem(`opscoach:token:${sessionId}`);
  }, [sessionId]);

  const sessionAuthHeaders = useMemo((): HeadersInit | undefined => {
    if (!token) return undefined;
    return { "X-Session-Token": token };
  }, [token]);

  const provisioningSteps = useMemo(
    () => deriveProvisioningSteps(session, stepOverrides),
    [session, stepOverrides]
  );

  useEffect(() => {
    if (!session) return;
    setStepOverrides((current) => {
      const inferred = { ...current };
      if (session.bootstrapReceived) {
        inferred.bootstrap = { status: "done" };
        inferred.start_lab = { status: "done" };
        inferred.install_keys = { status: "done" };
        if (session.status === "provisioning") {
          inferred.verify_ssh = { status: "active" };
        }
      }
      if (session.sshHost) {
        inferred.assign_public_ip = { status: "done", detail: session.sshHost };
      }
      if (session.status === "ready") {
        inferred.verify_ssh = { status: "done" };
        inferred.ready = { status: "done" };
      }
      return inferred;
    });
  }, [session?.bootstrapReceived, session?.sshHost, session?.status]);

  const isReady =
    session?.status === "ready" || session?.status === "running";
  const showProvisioning =
    session?.status === "provisioning" || (!isReady && session?.status !== "failed" && session?.status !== "stopped");

  useEffect(() => {
    params.then((value) => setSessionId(value.id));
  }, [params]);

  useEffect(() => {
    if (!sessionId || !token) return;
    fetch(`/api/sessions/${sessionId}`, { headers: sessionAuthHeaders })
      .then((res) => {
        if (!res.ok) {
          throw new Error(res.status === 401 ? "Session token missing or invalid" : "Failed to load session");
        }
        return res.json();
      })
      .then((data) => {
        applySessionPayload(data, setSession, setChecks, setScore, setLabPrompt, setBootstrapLog);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load session");
      });
  }, [sessionId, token, sessionAuthHeaders]);

  useEffect(() => {
    if (!sessionId || !token) return;
    if (isReady) return;
    if (session?.status === "stopped" || session?.status === "failed") return;

    const interval = setInterval(() => {
      fetch(`/api/sessions/${sessionId}`, { headers: sessionAuthHeaders })
        .then((res) => res.json())
        .then((data) => {
          applySessionPayload(data, setSession, setChecks, setScore, setLabPrompt, setBootstrapLog);
        })
        .catch(() => {
          // keep polling until ready or terminal status
        });
    }, 3000);

    return () => clearInterval(interval);
  }, [sessionId, token, sessionAuthHeaders, isReady, session?.status]);

  useEffect(() => {
    if (!sessionId || !token) return;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source?.close();
      const eventsUrl = `/api/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`;
      source = new EventSource(eventsUrl);
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as
            | { type: "grader"; result: GraderResult }
            | { type: "status"; status: string }
            | {
                type: "ready";
                sshHost: string;
                sshPort: number;
                graderHost?: string | null;
              }
            | {
                type: "step";
                step: string;
                status: StepStatus;
                detail?: string;
              }
            | {
                type: "bootstrap_progress";
                step: string;
                detail: string;
                at: string;
              }
            | { type: "error"; message: string };
          if (payload.type === "grader") {
            setChecks(payload.result.checks);
            setScore(payload.result.score);
          }
          if (payload.type === "step") {
            setStepOverrides((current) => ({
              ...current,
              [payload.step]: { status: payload.status, detail: payload.detail },
            }));
          }
          if (payload.type === "bootstrap_progress") {
            setBootstrapLog((current) =>
              mergeBootstrapProgress(current, [
                {
                  step: payload.step,
                  detail: payload.detail,
                  at: payload.at,
                },
              ])
            );
            setStepOverrides((current) => ({
              ...current,
              [payload.step]: { status: "active", detail: payload.detail },
            }));
          }
          if (payload.type === "ready") {
            const sshHost = learnerSshHost(payload.sshHost);
            if (!sshHost) {
              return;
            }
            setSession((current) =>
              current
                ? {
                    ...current,
                    status: "ready",
                    sshHost,
                    sshPort: payload.sshPort,
                    graderHost: payload.graderHost ?? sshHost,
                  }
                : current
            );
            setError(null);
          }
          if (payload.type === "status") {
            setSession((current) =>
              current ? { ...current, status: payload.status as SessionState["status"] } : current
            );
            if (payload.status === "ready") {
              fetch(`/api/sessions/${sessionId}`)
                .then((res) => res.json())
                .then((data) => {
                  applySessionPayload(data, setSession, setChecks, setScore, setLabPrompt, setBootstrapLog);
                })
                .catch(() => {
                  // non-fatal
                });
            }
          }
          if (payload.type === "error") {
            if (session?.status === "provisioning") {
              setStepOverrides((current) => ({
                ...current,
                verify_ssh: { status: "failed", detail: payload.message },
              }));
            }
            setError(payload.message);
          }
        } catch {
          // ignore malformed events
        }
      };
      source.onerror = () => {
        source?.close();
        if (!closed) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [sessionId, token]);

  useEffect(() => {
    if (!sessionId || !token) return;
    if (!isReady) return;
    if (session?.mode !== "practice") return;
    const sshHost = learnerSshHost(session?.sshHost);
    if (!sshHost) return;
    if (session?.status === "stopped" || session?.status === "failed") return;

    const interval = setInterval(() => {
      fetch(`/api/sessions/${sessionId}/grade`, {
        method: "POST",
        headers: { "X-Session-Token": token },
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error ?? "Grade request failed");
          }
          return res.json();
        })
        .then((data) => {
          if (data.result) {
            setChecks(data.result.checks);
            setScore(data.result.score);
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "Grader error";
          if (!message.includes("still provisioning")) {
            setError(message);
          }
        });
    }, 9_000);

    return () => clearInterval(interval);
  }, [sessionId, token, isReady, session?.mode, session?.sshHost, session?.status]);


  // Unlock Web Audio on the first user gesture (browsers block audio until then).
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // A chime when a check newly passes; a fanfare when all pass. The first snapshot
  // seeds silently so a reload/resume doesn't replay sounds for prior progress.
  useEffect(() => {
    const passed = new Set(
      checks.filter((c) => c.status === "pass").map((c) => c.id)
    );
    if (!soundSeededRef.current) {
      passedRef.current = passed;
      soundSeededRef.current = true;
      return;
    }
    let hasNew = false;
    passed.forEach((id) => {
      if (!passedRef.current.has(id)) hasNew = true;
    });
    passedRef.current = passed;
    if (!soundOn) return;
    const allDone = Boolean(score && score.total > 0 && score.passed === score.total);
    if (allDone && !dawnPlayedRef.current) {
      dawnPlayedRef.current = true;
      playDawn();
    } else if (hasNew) {
      playLantern();
    }
  }, [checks, score, soundOn]);

  async function stopSession() {
    if (!sessionId || !token) return;
    setStopping(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/stop`, {
        method: "POST",
        headers: { "X-Session-Token": token },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to stop session");
      }
      setSession(data.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop session");
    } finally {
      setStopping(false);
    }
  }

  async function runChecks() {
    if (!sessionId || !token) return;
    setGrading(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/grade`, {
        method: "POST",
        headers: { "X-Session-Token": token },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Grade request failed");
      }
      if (data.result) {
        setChecks(data.result.checks);
        setScore(data.result.score);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grader error");
    } finally {
      setGrading(false);
    }
  }

  async function copySshCommand() {
    const command = session ? buildSshCommand(session) : null;
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function downloadSshKey() {
    if (!token || keyState === "downloading") return;
    setKeyState("downloading");
    try {
      const res = await fetch(`/api/sessions/${sessionId}/ssh-key`, {
        headers: { "x-session-token": token },
      });
      if (!res.ok) throw new Error("Key not available yet");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = session ? sshKeyFilename(session) : "opscoach.key";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setKeyState("done");
    } catch {
      setKeyState("error");
    }
  }

  const sshCommand = session && isReady ? buildSshCommand(session) : null;

  const labTitle = humanize(session?.labId) || "Session";
  const lit = score?.passed ?? checks.filter((c) => c.status === "pass").length;
  const total = score?.total ?? (checks.length || 20);
  const allPass = total > 0 && lit === total;
  const unit = session?.packId === "beaconkeeper" ? "lanterns" : "checks";

  return (
    <div className="session-shell">
      <header className="session-topbar">
        <div className="session-topbar__left">
          <Link href="/catalog" className="brand" title="Back to catalog" aria-label="Back to catalog">
            <span className="brand__mark" aria-hidden>
              <Terminal size={15} />
            </span>
          </Link>
          <span className="session-topbar__title">{labTitle}</span>
          <StatusBadge status={session?.status} />
          {score ? (
            <span className="score-pill">
              {score.passed}/{score.total}
            </span>
          ) : null}
        </div>
        <div className="session-topbar__right">
          {isReady ? (
            <div className="seg" role="tablist" aria-label="Console channel">
              <button
                type="button"
                role="tab"
                aria-selected={channel === "web"}
                className={`seg__btn${channel === "web" ? " active" : ""}`}
                onClick={() => setChannel("web")}
              >
                Web shell
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={channel === "ssh"}
                className={`seg__btn${channel === "ssh" ? " active" : ""}`}
                onClick={() => setChannel("ssh")}
              >
                SSH
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="btn--ghost btn--sm"
            aria-label={soundOn ? "Mute sounds" : "Unmute sounds"}
            title={soundOn ? "Sounds on" : "Sounds off"}
            onClick={() => {
              unlockAudio();
              setSoundOn((v) => !v);
            }}
            style={{ padding: "0.35rem" }}
          >
            {soundOn ? <Volume2 size={16} aria-hidden /> : <VolumeX size={16} aria-hidden />}
          </button>
          <button
            type="button"
            className="btn--danger btn--sm"
            disabled={
              stopping ||
              session?.status === "stopped" ||
              session?.status === "stopping"
            }
            onClick={stopSession}
          >
            {stopping ? "Stopping…" : "Stop lab"}
          </button>
        </div>
      </header>

      <div className="session-body">
        <main className="session-main">
          {error && session?.status !== "provisioning" ? (
            <div className="session-main__error">
              {session?.status === "failed" ? session.errorMessage ?? error : error}
            </div>
          ) : null}

          {showProvisioning ? (
            <div className="session-stage">
              <section className="card" style={{ maxWidth: 560, width: "100%" }} aria-live="polite">
                <div className="section__head">
                  <h2 className="section__title">Provisioning</h2>
                  <ProvisioningElapsed since={session?.createdAt} />
                </div>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.875rem" }}>
                  Spinning up a dedicated Linux host on AWS — usually under two minutes.
                </p>
                <ProvisioningSteps steps={provisioningSteps} />
                <BootstrapActivityLog entries={bootstrapLog} />
                {error && session?.status === "provisioning" ? (
                  <p className="help" style={{ color: "var(--fail-text)" }}>
                    {error}
                  </p>
                ) : null}
              </section>
            </div>
          ) : channel === "web" ? (
            isReady && token ? (
              <WebTerminal sessionId={sessionId} token={token} />
            ) : (
              <div className="session-stage">
                <div className="provision-summary">
                  <CircleDashed size={16} aria-hidden />
                  <span>
                    {session?.status === "failed"
                      ? session.errorMessage ?? "Lab failed to start."
                      : "Waiting for the lab to be ready…"}
                  </span>
                </div>
              </div>
            )
          ) : (
            <div className="session-stage">
              <div style={{ maxWidth: 640, width: "100%" }}>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.875rem" }}>
                  Prefer your own terminal? This session has its own one-time SSH key.
                  Download it and connect — it only opens this lab host, and it dies
                  when the session stops. Your progress lives on the host, so you can
                  hop between the web shell and SSH freely.
                </p>
                {sshCommand ? (
                  <>
                    <div className="toolbar" style={{ marginBottom: "0.85rem" }}>
                      <button
                        type="button"
                        className="btn--accent btn--sm"
                        onClick={downloadSshKey}
                        disabled={keyState === "downloading" || !token}
                      >
                        {keyState === "done" ? (
                          <>
                            <Check size={15} aria-hidden /> Key downloaded
                          </>
                        ) : (
                          <>
                            <Download size={15} aria-hidden />{" "}
                            {keyState === "downloading"
                              ? "Downloading…"
                              : "Download session key"}
                          </>
                        )}
                      </button>
                      {keyState === "error" ? (
                        <span className="help" style={{ color: "var(--fail-text)" }}>
                          Key not ready yet — try again in a moment.
                        </span>
                      ) : null}
                    </div>
                    <p className="help" style={{ marginTop: 0 }}>
                      Saves <code>{session ? sshKeyFilename(session) : ""}</code> to your
                      Downloads, then run:
                    </p>
                    <div className="ssh-block">
                      <span className="ssh-block__prompt" aria-hidden>
                        $
                      </span>
                      <span className="ssh-block__cmd">{sshCommand}</span>
                      <button
                        type="button"
                        className="ssh-block__copy"
                        aria-label="Copy SSH command"
                        onClick={copySshCommand}
                      >
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                      </button>
                    </div>
                    <div className="toolbar">
                      <button
                        type="button"
                        className="secondary btn--sm"
                        onClick={copySshCommand}
                      >
                        {copied ? "Copied" : "Copy command"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="provision-summary">
                    <CircleDashed size={16} aria-hidden />
                    <span>Waiting for lab SSH to become ready…</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        <aside className="session-pane">
          <div className="pane-section">
            <div className="pane-progress__head">
              <h3>Progress</h3>
              <span
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: 500,
                  color: allPass ? "var(--pass-text)" : "var(--text-secondary)",
                }}
              >
                {lit} / {total} {unit}
              </span>
            </div>
            <div className="progress-bar">
              <div
                className="progress-bar__fill"
                style={{ width: `${total ? Math.round((lit / total) * 100) : 0}%` }}
              />
            </div>
          </div>

          <div className="pane-section">
            <div className="pane-section__head">
              <h3>Checks</h3>
              {session?.mode === "assessment" && isReady ? (
                <button type="button" className="btn--sm" disabled={grading} onClick={runChecks}>
                  {grading ? "Running…" : "Run checks"}
                </button>
              ) : null}
            </div>
            {checks.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.8125rem", margin: 0 }}>
                {isReady
                  ? session?.mode === "assessment"
                    ? "Run checks when you're ready to submit."
                    : "Checks light up here as you work."
                  : "Checks appear once the lab is ready."}
              </p>
            ) : (
              <ul className="check-list" aria-live="polite">
                {checks.map((check) => (
                  <li key={check.id} className={`check-item check-item--${check.status}`}>
                    <CheckIcon status={check.status} />
                    <div className="check-item__body">
                      <strong>{check.label}</strong>
                      {check.detail ? <span>{check.detail}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {session?.packId === "beaconkeeper" && isReady && token ? (
            <div className="pane-section">
              <h3>Public dashboard</h3>
              <DashboardPreview sessionId={sessionId} token={token} />
            </div>
          ) : null}

        </aside>
      </div>
    </div>
  );
}

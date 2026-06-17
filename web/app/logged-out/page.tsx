import type { Metadata } from "next";

export const metadata: Metadata = { title: "Signed out — Ops Coach" };

// Public, auth-bypassed landing after sign-out (the ALB listener bypass rule lets this
// path through without authenticate-cognito, so the user is not silently re-logged-in).
export default function LoggedOutPage() {
  return (
    <main className="page page--narrow">
      <section
        className="card card--pad-lg"
        style={{ marginTop: "4rem", textAlign: "center" }}
      >
        <div
          className="brand__mark"
          aria-hidden
          style={{ margin: "0 auto 1rem", width: 36, height: 36, borderRadius: 9 }}
        >
          <span style={{ fontSize: "0.95rem", fontFamily: "var(--font-mono)" }}>
            ›_
          </span>
        </div>
        <h1 style={{ fontSize: "1.25rem" }}>Signed out</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          You&apos;ve been signed out of Ops Coach.
        </p>
        <p style={{ marginTop: "1.5rem" }}>
          <a className="button" href="/">
            Sign in again
          </a>
        </p>
      </section>
    </main>
  );
}

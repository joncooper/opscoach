"use client";

import { useEffect, useRef, useState } from "react";

const BOOT = process.env.NEXT_PUBLIC_GATE_PROMPT ?? "ACCESS CODE REQUIRED";

type Status = "idle" | "checking" | "denied" | "accepted";

export default function GatePage() {
  const [typed, setTyped] = useState("");
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState("");
  const [next, setNext] = useState("/");
  const [status, setStatus] = useState<Status>("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setNext(new URLSearchParams(window.location.search).get("next") || "/");
    } catch {
      setNext("/");
    }
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setTyped(BOOT.slice(0, i));
      if (i >= BOOT.length) {
        clearInterval(id);
        setReady(true);
        setTimeout(() => inputRef.current?.focus(), 60);
      }
    }, 30);
    return () => clearInterval(id);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || status === "checking") return;
    setStatus("checking");
    try {
      const res = await fetch("/api/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        setStatus("accepted");
        setTimeout(() => {
          window.location.href = next;
        }, 1500);
        return;
      }
      setStatus("denied");
      setCode("");
      inputRef.current?.focus();
    } catch {
      setStatus("denied");
    }
  }

  return (
    <main className="gate">
      <div className="gate__scanlines" aria-hidden />
      <div className="gate__screen">
        <pre className="gate__text">
          {typed}
          {!ready ? <span className="gate__cursor">█</span> : null}
        </pre>
        {ready && status !== "accepted" ? (
          <form onSubmit={submit} className="gate__form">
            <span className="gate__prompt">&gt;</span>
            <input
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="gate__input"
              autoComplete="off"
              spellCheck={false}
              aria-label="Access code"
              disabled={status === "checking"}
            />
          </form>
        ) : null}
        {status === "denied" ? <pre className="gate__deny">ACCESS DENIED.</pre> : null}
        {status === "accepted" ? (
          <pre className="gate__text gate__accept">ACCESS GRANTED</pre>
        ) : null}
        <a href="/logout" className="gate__logout">
          [ disconnect ]
        </a>
      </div>
    </main>
  );
}

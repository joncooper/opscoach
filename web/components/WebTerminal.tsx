"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

type Status = "connecting" | "connected" | "closed" | "error";

const THEME = {
  background: "#0e1117",
  foreground: "#cbd5e1",
  cursor: "#7c83ff",
  black: "#0e1117",
  brightBlack: "#5c6370",
};

export function WebTerminal({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !sessionId || !token) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null;
    let ro: ResizeObserver | null = null;
    let removeWinListener = () => {};

    (async () => {
      const [{ Terminal }, { FitAddon }, webglMod] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-webgl").catch(() => null),
      ]);
      if (disposed) return;
      term = new Terminal({
        fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        theme: THEME,
        scrollback: 6000,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      try {
        fit.fit();
      } catch {}

      // GPU renderer — the default DOM renderer is the main source of terminal lag.
      if (webglMod && "WebglAddon" in webglMod) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const addon = new (webglMod as any).WebglAddon();
          addon.onContextLoss?.(() => {
            try {
              addon.dispose();
            } catch {}
          });
          term.loadAddon(addon);
        } catch {
          // fall back to the default renderer
        }
      }

      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${location.host}/api/sessions/${encodeURIComponent(
        sessionId
      )}/shell?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      const sendResize = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      };

      ws.onopen = () => {
        if (disposed) return;
        setStatus("connected");
        sendResize();
        term.focus();
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === "string") term.write(ev.data);
        else term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (!disposed) setStatus("closed");
      };
      ws.onerror = () => {
        if (!disposed) setStatus("error");
      };

      term.onData((d: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(d));
        }
      });

      // Refit (and tell the lab) whenever the terminal's box changes size, so it always
      // fills the available space on any monitor.
      let raf = 0;
      const refit = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {}
          sendResize();
        });
      };
      ro = new ResizeObserver(refit);
      ro.observe(el);
      window.addEventListener("resize", refit);
      removeWinListener = () => window.removeEventListener("resize", refit);
    })();

    return () => {
      disposed = true;
      try {
        ro?.disconnect();
      } catch {}
      removeWinListener();
      try {
        ws?.close();
      } catch {}
      try {
        term?.dispose();
      } catch {}
    };
  }, [sessionId, token, attempt]);

  return (
    <div className="webterm-wrap">
      <div ref={containerRef} className="webterm" />
      <div className="webterm-status">
        <span
          className="status"
          style={{
            fontSize: "0.8125rem",
            color:
              status === "connected"
                ? "var(--pass-text)"
                : status === "connecting"
                  ? "var(--text-tertiary)"
                  : "var(--fail-text)",
          }}
        >
          <span
            className="status__dot"
            aria-hidden
            style={{
              background:
                status === "connected"
                  ? "var(--pass)"
                  : status === "connecting"
                    ? "var(--text-tertiary)"
                    : "var(--fail)",
            }}
          />
          {status === "connected"
            ? "Connected"
            : status === "connecting"
              ? "Connecting…"
              : status === "closed"
                ? "Disconnected"
                : "Connection error"}
        </span>
        {status === "closed" || status === "error" ? (
          <button
            type="button"
            className="secondary btn--sm"
            onClick={() => {
              setStatus("connecting");
              setAttempt((a) => a + 1);
            }}
          >
            Reconnect
          </button>
        ) : null}
      </div>
    </div>
  );
}

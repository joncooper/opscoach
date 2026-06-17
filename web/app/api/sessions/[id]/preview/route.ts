import { spawn } from "child_process";
import { readLearnerSessionToken, requireLearnerSession } from "@/lib/session-access";
import type { SessionRecord } from "@/lib/types";

// Live preview of the lab's Beacon dashboard, fetched over the existing per-session SSH
// path (the web task already holds the grader key) and served back over the app's TLS so
// the session page can embed it. No public port on the lab host, no new credentials.
//
// SSH multiplexing (ControlMaster) makes repeated previews — and the grader, which shares
// the same control path — reuse one connection per lab instead of re-handshaking.

const CONTROL_PATH = "/tmp/opscoach-ssh-%h-%p-%r";

// Injected so the raw lab dashboard renders like 2026, not Mosaic.
const DASHBOARD_STYLE = `<style>
:root{color-scheme:light}
html,body{margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1a1d21;background:#fff;line-height:1.55;padding:26px 30px;font-size:15px}
h1{font-size:1.6rem;font-weight:600;letter-spacing:-.02em;margin:0 0 .4rem}
h2{font-size:1.15rem;font-weight:600;margin:1.2rem 0 .4rem}
h3{font-size:1rem;font-weight:600;margin:1rem 0 .3rem}
p{color:#5c636e;margin:.4rem 0}
a{color:#5b51e8;text-decoration:none}
ul,ol{color:#5c636e;padding-left:1.2rem}
table{border-collapse:collapse;font-size:.95rem;margin:.6rem 0}
th,td{padding:7px 12px;border-bottom:1px solid #eceef1;text-align:left}
th{color:#16181c;font-weight:600}
code,kbd{font-family:ui-monospace,"SF Mono",Menlo,monospace;background:#f5f6f8;border-radius:6px;padding:2px 6px;font-size:.9em}
pre{font-family:ui-monospace,"SF Mono",Menlo,monospace;background:#f5f6f8;border-radius:8px;padding:12px 14px;overflow:auto}
hr{border:0;border-top:1px solid #eceef1;margin:1.2rem 0}
</style>`;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function placeholder(message: string): string {
  return `<!doctype html><html><body style="margin:0;font-family:-apple-system,system-ui,sans-serif;color:#9aa1ab;background:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><p>${message}</p></body></html>`;
}

// Prepend our stylesheet so it applies regardless of how the lab structures its HTML
// (a leading <style> is hoisted into <head> by the parser).
function stylize(html: string): string {
  return DASHBOARD_STYLE + html;
}

function fetchDashboard(session: SessionRecord, host: string): Promise<string> {
  return new Promise((resolve) => {
    const args = [
      "-i",
      session.graderKeyPath,
      "-p",
      String(session.sshPort ?? 22),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${CONTROL_PATH}`,
      "-o",
      "ControlPersist=45s",
      `${session.sshUser}@${host}`,
      "curl -s -m 5 -o - http://127.0.0.1:80/",
    ];
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(placeholder("Dashboard not reachable yet."));
    }, 9000);
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(placeholder("Dashboard not reachable yet."));
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(
        out.trim()
          ? out
          : placeholder("The dashboard returned nothing — the service may be down.")
      );
    });
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const token = readLearnerSessionToken(request);
  const session = await requireLearnerSession(id, token);
  if (!session) {
    return htmlResponse(placeholder("Unauthorized."), 401);
  }
  const host = session.graderHost ?? session.sshHost;
  if (!host) {
    return htmlResponse(placeholder("Waiting for the lab to come up…"));
  }
  const html = await fetchDashboard(session, host);
  return htmlResponse(stylize(html));
}

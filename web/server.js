// Custom Next server that adds a WebSocket terminal endpoint on top of the normal app.
//
//   browser (xterm.js)  <-- wss -->  this server  <-- ssh2 PTY -->  lab host
//
// The WS path /api/sessions/<id>/shell is authenticated by POSTing the learner's
// per-session token to the in-app /shell-auth route (which validates it against the DB
// and returns the SSH connection params). The route only answers callers that present
// the internal secret, so only this server can ask it. The browser's WS handshake also
// rides the ALB Cognito cookie, so it's behind login as well.
const http = require("http");
const { parse } = require("url");
const fs = require("fs");
const next = require("next");
const { WebSocketServer } = require("ws");
const { Client: SSHClient } = require("ssh2");

const port = parseInt(process.env.PORT || "3000", 10);
const hostname = "0.0.0.0";
const SHELL_PATH = /^\/api\/sessions\/([^/]+)\/shell$/;
const INTERNAL_SECRET = process.env.INTERNAL_CALLBACK_SECRET || "";

const app = next({ dev: false });
const handle = app.getRequestHandler();

function authShell(sessionId, token) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ token });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/api/sessions/${encodeURIComponent(sessionId)}/shell-auth`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-shell-internal": INTERNAL_SECRET,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

function bridge(ws, params) {
  const conn = new SSHClient();
  let closed = false;
  // The ALB reaps idle connections (~60s), and an interactive terminal is silent
  // between keystrokes. Send a WebSocket ping every 25s so the browser↔ALB↔server hop
  // never goes idle; the browser auto-replies with a pong.
  const pinger = setInterval(() => {
    try {
      if (ws.readyState === ws.OPEN) ws.ping();
    } catch {}
  }, 25000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pinger);
    try {
      conn.end();
    } catch {}
    try {
      ws.close();
    } catch {}
  };

  conn.on("ready", () => {
    conn.shell(
      { term: "xterm-256color", cols: params.cols || 80, rows: params.rows || 24 },
      (err, stream) => {
        if (err) {
          try {
            ws.send(`\r\n[shell error: ${err.message}]\r\n`);
          } catch {}
          cleanup();
          return;
        }
        stream.on("data", (d) => {
          if (ws.readyState === ws.OPEN) ws.send(d);
        });
        stream.stderr.on("data", (d) => {
          if (ws.readyState === ws.OPEN) ws.send(d);
        });
        stream.on("close", cleanup);
        ws.on("message", (data, isBinary) => {
          if (isBinary) {
            stream.write(data); // raw keystrokes
            return;
          }
          // text frames are control messages (resize)
          try {
            const msg = JSON.parse(data.toString());
            if (msg && msg.type === "resize") {
              stream.setWindow(msg.rows, msg.cols, 0, 0);
              return;
            }
          } catch {}
          stream.write(data);
        });
        ws.on("close", cleanup);
        ws.on("error", cleanup);
      }
    );
  });
  conn.on("error", (e) => {
    try {
      ws.send(`\r\n[connection error: ${e.message}]\r\n`);
    } catch {}
    cleanup();
  });

  let privateKey;
  try {
    privateKey = fs.readFileSync(params.keyPath);
  } catch (e) {
    try {
      ws.send(`\r\n[key error: ${e.message}]\r\n`);
    } catch {}
    cleanup();
    return;
  }
  conn.connect({
    host: params.host,
    port: params.port || 22,
    username: params.user,
    privateKey,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    // Ephemeral lab hosts have throwaway host keys; the per-session key authorizes us.
    hostVerifier: () => true,
  });
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    handle(req, res, parse(req.url, true));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    let pathname, query;
    try {
      ({ pathname, query } = parse(req.url, true));
    } catch {
      socket.destroy();
      return;
    }
    const match = SHELL_PATH.exec(pathname || "");
    if (!match) {
      socket.destroy();
      return;
    }
    const sessionId = match[1];
    const token = query && query.token;
    if (!token || !INTERNAL_SECRET) {
      socket.destroy();
      return;
    }
    const params = await authShell(sessionId, token);
    if (!params || !params.ok || !params.host) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, params));
  });

  server.listen(port, hostname, () => {
    console.log(`> opscoach-web ready on http://${hostname}:${port}`);
  });
});

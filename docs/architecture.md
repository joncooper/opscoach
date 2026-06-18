# OpsCoach architecture

OpsCoach runs its web app as a container on **ECS Fargate** behind a **shared ALB + Cognito** platform, and hands each learner a **dedicated, ephemeral EC2 lab host**. The web service bridges the in-browser terminal to that host over SSH, runs a grader against real system state, and tears the host down automatically.

## System topology

![OpsCoach AWS architecture](architecture.svg)

**Numbered flows**

1. **Request** — browser → ALB over HTTPS. The ALB runs `authenticate-cognito` (Cognito hosted UI → Google); a post-auth passphrase gate (Next.js middleware) must also pass before any page renders. `/api/health` and `/logout` are the only Cognito bypasses.
2. **Route** — ALB → the OpsCoach web service on ECS Fargate (private, egress-only subnet).
3. **Provision · operate · grade** — Fargate launches and drives the per-session EC2 lab host: `RunInstances` at start, an SSH PTY for the browser terminal, and a grader over SSH.
4. **Ready webhook** — the lab host calls back to the service (resolved through Cloud Map, authenticated by a shared secret) once it's up.
5. **Terminal** — the browser streams over a WebSocket to the custom Node server, which relays to the host's shell over SSH.
6. **Teardown** — a per-session EventBridge Scheduler one-shot triggers the terminator Lambda to terminate the host; a 5-minute sweep is the backstop.

Grey dashed links are supporting paths: Fargate ↔ RDS PostgreSQL (isolated subnet), the EC2 host pulling its lab image from ECR, and the opt-in direct SSH from a learner's laptop.

**Colour key** — purple: networking (ALB, Cloud Map) · orange: compute & containers (Fargate, EC2, Lambda, ECR) · red: identity & secrets (Cognito, Secrets Manager) · blue: database (RDS) · pink: app integration (EventBridge Scheduler).

## Key flows

### 1 · Authentication & access gate

```mermaid
sequenceDiagram
    autonumber
    actor U as Browser
    participant ALB as ALB
    participant Cog as Cognito
    participant App as Fargate
    U->>ALB: HTTPS request
    ALB->>Cog: authenticate-cognito (if enabled)
    Cog-->>ALB: OIDC tokens
    ALB->>App: forward + signed identity header
    alt no gate cookie
        App-->>U: redirect to /gate
        U->>App: POST /api/gate (passphrase)
        App-->>U: set gate cookie, continue
    end
    App-->>U: app page
    Note over ALB,App: /api/health and /logout skip Cognito
```

### 2 · Provision a lab session

```mermaid
sequenceDiagram
    autonumber
    actor U as Browser
    participant App as Fargate
    participant EC2 as Lab host
    participant ECR as ECR
    participant Sch as Scheduler
    U->>App: POST /api/sessions (start lab)
    App->>App: create session in RDS; mint keys + callback token
    App->>EC2: RunInstances (Launch Template + user-data)
    App->>Sch: CreateSchedule (terminate at T + maxLifetime)
    Note over EC2: user-data: install Docker, block IMDS,<br/>ECR login, run lab container, set authorized_keys
    EC2->>ECR: pull lab image
    EC2->>App: ready webhook (via Cloud Map + shared secret)
    App-->>U: session ready (host, port)
```

### 3 · Browser terminal & SSH

```mermaid
sequenceDiagram
    autonumber
    actor U as Browser
    participant Srv as Node server
    participant EC2 as Lab host
    U->>Srv: WebSocket /api/sessions/:id/shell?token
    Srv->>Srv: shell-auth (internal secret) resolves host + key
    Srv->>EC2: ssh2 PTY on port 22 (per-session key)
    EC2-->>Srv: stdout / stderr
    Srv-->>U: stream to xterm.js
    Note over Srv,EC2: 25s keepalive ping holds the ALB idle timer
    Note over U,EC2: opt-in: SSH directly to the host's public IP
```

### 4 · Live grading

```mermaid
sequenceDiagram
    autonumber
    actor U as Browser
    participant App as Fargate
    participant G as Grader
    participant EC2 as Lab host
    U->>App: POST /api/sessions/:id/grade
    App->>G: spawn grader (allowlisted env, no task-role creds)
    G->>EC2: SSH port 22 (grader key) runs ops status
    EC2-->>G: JSON check results
    G-->>App: { passed, checks[] }
    App->>App: persist check run in RDS
    App-->>U: live results on the dashboard
```

### 5 · Idle / lifetime teardown

```mermaid
sequenceDiagram
    autonumber
    participant Sch as Scheduler
    participant L as Terminator Lambda
    participant EC2 as Lab host
    participant App as Fargate
    Sch->>L: fire at T + maxLifetime
    L->>L: read callback secret (Secrets Manager)
    L->>EC2: TerminateInstances
    L->>App: shutdown callback (mark session stopped)
    Note over EC2,App: backstop: 5-min EventBridge sweep<br/>terminates any host past its ExpiresAt tag
```

## Components

| Component | AWS service | Role |
| --- | --- | --- |
| Web app + terminal bridge | ECS Fargate | Next.js app + custom Node server; WebSocket→SSH PTY bridge; session lifecycle, grading, dashboard |
| Edge auth | ALB + Cognito | `authenticate-cognito` at the load balancer (hosted UI → Google), then a post-auth passphrase gate |
| Lab host | EC2 (per session) | Ephemeral AL2023 / arm64 host running the lab container; learner SSH target |
| Container images | ECR | Images for the web service and each lab |
| Database | RDS PostgreSQL | Sessions, check runs, grader results (isolated subnet) |
| Service discovery | Cloud Map | In-VPC address for lab-host → web callbacks |
| Teardown | EventBridge Scheduler + Lambda | One-shot per-session schedule fires a terminator Lambda; 5-minute sweep backstop |
| Secrets | Secrets Manager | Database credentials, callback secret, grader key |

## Security notes

- **Network isolation** — the database is in an isolated subnet; the web service runs in a private, egress-only subnet behind the shared ALB; only the lab hosts are public (so learners can SSH in directly).
- **IMDS blocked in labs** — lab-host user-data drops container access to the instance metadata service, so a lab container cannot reach the host's IAM role.
- **Least-privilege grading** — the grader is spawned with an allowlisted environment (no task-role credentials); AWS labs instead receive scoped, per-session STS credentials.
- **Per-session SSH keys** — each session mints its own keypair; the browser bridge and the grader use separate keys, and direct SSH is opt-in.
- **Defense in depth at the edge** — Cognito auth at the ALB plus an app-level passphrase gate; only health and logout bypass Cognito.

## See also

- **[../infra/PLATFORM_INTEGRATION.md](../infra/PLATFORM_INTEGRATION.md)** — how the service plugs into a shared ALB/Cognito platform (resource IDs come from `infra/cdk.context.json`, kept out of version control).
- **[../infra/README.md](../infra/README.md)** — CDK stacks and deployment.

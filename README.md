# OpsCoach

OpsCoach is a hands-on Linux and cloud operations training platform. Each learner gets a
real, ephemeral cloud Linux host and works through graded, scenario-based labs — for
example *"Beaconkeeper: Twenty Lanterns to Dawn"* — from an in-browser terminal or over
SSH, with live grading and a live service dashboard.

Instead of multiple-choice quizzes, learners are dropped onto an actual machine and asked
to *do the work*: orient themselves in a shell, find and fix misconfigurations, harden SSH,
triage logs, inspect cloud resources, and so on. A host-side grader inspects real system
state and returns structured pass/fail results, so progress reflects what the learner
actually accomplished on the box.

## Highlights

- **Real ephemeral hosts.** Every session provisions a dedicated, short-lived cloud Linux
  host and tears it down automatically on idle or after a hard lifetime cap.
- **Browser terminal or SSH.** Work entirely in the browser (xterm.js over a WebSocket
  bridge) or connect with your own SSH key — your choice.
- **Live grading.** A grader runs against real system state and streams check results as
  you go, with a live service/scoreboard dashboard alongside the terminal.
- **Scenario content packs.** Self-contained packs bundle the lab runtime image, the
  grader, and the learner-facing brief. Ships with Linux Foundations drills, AWS
  Foundations labs, and the Beaconkeeper capstone.

## Architecture

```
browser (xterm.js)  <-- WebSocket -->  custom Next.js server  <-- ssh2 PTY -->  lab host (EC2)
                                              |
                                              +-- grader / session lifecycle / dashboard
```

- **Web app (`web/`)** — a Next.js app with a thin custom Node server (`web/server.js`)
  that adds a WebSocket-to-SSH bridge: the browser terminal connects over `wss`, the server
  authenticates the session and opens an `ssh2` PTY to the learner's lab host. App routes
  handle session lifecycle, provisioning status, grading, notes, and the live dashboard.
  In production the service runs on **AWS Fargate** behind a **shared ALB + Cognito**
  platform you configure (it imports the VPC/ALB/cluster/Cognito by ID — it does not create
  them). Postgres is used when configured; otherwise an in-memory store is used for local
  development.
- **Lab hosts** — per-session **EC2** instances launched from a hardened AMI, registered for
  automatic teardown. Internal callbacks (ready webhook, terminator) reach the web service
  over a private Cloud Map address, authenticated by a shared secret.
- **Infrastructure (`infra/`)** — an **AWS CDK** (TypeScript) app defining the Fargate
  service, lab-host stack, teardown automation (Lambdas + EventBridge Scheduler), and an
  optional org-guardrail / scenario stack. Platform resource IDs are supplied via CDK
  context (see Configure).
- **Content packs (`ContentPacks/`)** — each pack contains a `manifest.json`, a `runtime/`
  Docker image for the lab host, a `grader/` (Python) that checks real state, and lab
  briefs/templates.

## Repository layout

| Path            | What it is                                                          |
| --------------- | ------------------------------------------------------------------ |
| `web/`          | Next.js app + custom WebSocket/SSH server, API routes, UI          |
| `infra/`        | AWS CDK app (Fargate service, lab hosts, teardown, guardrails)     |
| `ContentPacks/` | Lab + game content (runtime images, graders, briefs)               |
| `scripts/`      | Build, deploy, and smoke-test shell scripts                        |
| `docs/`         | Architecture and design notes                                      |

## Quick start (local)

```bash
cd web
npm install
cp .env.example .env      # fill in values as needed (most are optional locally)
npm run dev               # Next.js dev server
```

With no AWS credentials and no `DATABASE_URL`, the app runs in a local mock mode (in-memory
store, mocked provisioning) so you can explore the UI and content without any cloud
resources. The production custom server is started with `npm run build && npm start`.

Run the web test suite:

```bash
cd web && npm test
```

## Configure

Two pieces of configuration are kept out of version control and supplied locally:

1. **App environment** — copy `web/.env.example` to `web/.env` and fill in values. This file
   documents every variable the app reads, including the access-gate settings (`GATE_TOKEN`,
   `GATE_ANSWERS`, `NEXT_PUBLIC_GATE_PROMPT`), datastore, AWS/region, EC2 lab provisioning,
   session lifecycle limits, and the internal callback secret.

2. **CDK platform context** — copy `infra/cdk.context.example.json` to
   `infra/cdk.context.json` (gitignored) and fill in your platform's IDs: account/region,
   VPC, ECS cluster name, ALB ARN + security group, HTTPS listener ARN, Cloud Map namespace,
   DNS zone, ECR repository, and (optionally) Cognito user-pool ID + hosted-UI domain. If
   you already have a shared platform deployed, `scripts/discover-platform-context.sh` can
   discover and write this file for you from CloudFormation outputs.

```bash
cp infra/cdk.context.example.json infra/cdk.context.json
# edit infra/cdk.context.json, or:
./scripts/discover-platform-context.sh
```

### Access gate

The app sits behind a small post-authentication access gate: after the upstream identity
provider authenticates a visitor, they must enter a shared passphrase before reaching any
page. The prompt, accepted answers, and cookie token are all read from environment
variables (`NEXT_PUBLIC_GATE_PROMPT`, `GATE_ANSWERS`, `GATE_TOKEN`) — nothing secret lives
in the source. See `web/lib/gate.ts`.

## Deploy

Deployment targets a shared ALB/Cognito platform you operate. At a high level:

```bash
# 1) discover/define platform context
./scripts/discover-platform-context.sh        # or hand-edit infra/cdk.context.json

# 2) build + push the web and lab images, then deploy the CDK stacks
./scripts/deploy-platform.sh
```

See `infra/PLATFORM_INTEGRATION.md` for the full integration walkthrough and
`infra/README.md` for CDK stack details.

## License

MIT — see [LICENSE](LICENSE).

# Ops Coach Web

Phase 1 Next.js App Router service for browser-based Linux and cloud lab sessions. Provisions EC2 lab hosts (or mock mode locally), exposes SSH connection details, runs ContentPack graders, and streams check updates over SSE.

**Catalog:** all content packs (`linux-foundations`, `beaconkeeper`, `aws-foundations`) with practice/assessment modes, hints (practice only), and per-session notes.

**AWS labs:** `aws-foundations/aws-security-basics` uses server-side STS + CloudFormation prep (`web/lib/aws-lab-manager.ts`) before EC2 provisioning.

Lab instance teardown (SSH idle webhook, max-TTL scheduler, sweep) is documented in [`docs/lab-lifecycle-design.md`](../docs/lab-lifecycle-design.md).

## Prerequisites

- Node.js 22+
- `openssh-client` and `python3` (for grader scripts)
- Content packs at `../ContentPacks` (or set `CONTENT_ROOT`)
- Optional: Postgres for durable sessions

## Local development

```bash
cd web
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`

### Database

**Without `DATABASE_URL`:** sessions and check runs are stored in memory (fine for smoke tests).

**With Postgres:**

```bash
docker run --name opscoach-pg -e POSTGRES_PASSWORD=opscoach -e POSTGRES_USER=opscoach -e POSTGRES_DB=opscoach -p 5432:5432 -d postgres:16
export DATABASE_URL=postgres://opscoach:opscoach@localhost:5432/opscoach
```

Tables are created automatically on first request via `migrate()`.

### EC2 mock mode

Leave `EC2_LAUNCH_TEMPLATE_ID` unset to use mock provisioning (`127.0.0.1:22`). Grader runs still execute locally against ContentPack scripts.

### Production EC2

Set:

- `EC2_LAUNCH_TEMPLATE_ID`
- `AWS_REGION`
- `INTERNAL_CALLBACK_SECRET`
- `APP_BASE_URL` (public URL for the ready callback)

EC2 user-data should `POST /api/sessions/:id/ready` with header `X-Internal-Secret` and body `{ "sshHost": "...", "sshPort": 22 }`. During bootstrap it may `POST /api/sessions/:id/progress` with `{ "step": "bootstrap"|"start_lab"|"install_keys", "detail": "..." }` for live provisioning updates.

### Smoke test

From repo root (mock mode, no EC2):

```bash
./scripts/smoke-web-session.sh
```

With a local lab container for grading:

```bash
OPSCOACH_SMOKE_START_COMPOSE=1 ./scripts/smoke-web-session.sh
```

## Build

```bash
npm install
npm run build
npm start
```

## Docker

Build from repository root (needs `ContentPacks/` alongside `web/`):

```bash
docker build -f web/Dockerfile -t opscoach-web .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://... \
  -e INTERNAL_CALLBACK_SECRET=... \
  opscoach-web
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/labs` | Full catalog (`?packId=`, `?grouped=1`) |
| GET/PUT | `/api/sessions/:id/notes` | Session scratch notes (PUT requires token) |
| POST | `/api/sessions` | Create session (`packId`, `labId`, `publicKey`, `mode`) |
| GET | `/api/sessions/:id` | Session status |
| POST | `/api/sessions/:id/grade` | Run grader (`X-Session-Token`) |
| POST | `/api/sessions/:id/stop` | Stop session (`X-Session-Token`) |
| GET | `/api/sessions/:id/events` | SSE check updates |
| POST | `/api/sessions/:id/ready` | EC2 ready callback (`X-Internal-Secret`) |
| POST | `/api/sessions/:id/progress` | EC2 bootstrap progress (`X-Internal-Secret`) |
| POST | `/api/sessions/:id/shutdown` | EC2/Lambda idle or TTL teardown (`X-Internal-Secret`) |

## Environment

See `.env.example`.

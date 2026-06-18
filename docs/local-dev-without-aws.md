# Local development without AWS

**Status: v1.0**

Ops Coach web can run **entirely on a developer machine** (no EC2, Fargate, RDS, or AWS API calls) while building features that deploy to Platform in production. This document is the feasibility discussion for getting there.

## Goal

Match the macOS app’s day-to-day loop: open the app, start a lab, SSH from your terminal, see live grading, stop the lab. Production still uses Fargate + per-session EC2; local dev uses Docker on the host.

## What already works (no AWS)

| Piece | Behavior |
|-------|----------|
| Web UI | `cd web && npm run dev`: catalog, play flow, session page, SSE grading |
| Session store | In-memory when `DATABASE_URL` is unset; optional local Postgres |
| Provisioning | **Mock EC2** when `EC2_LAUNCH_TEMPLATE_ID` is unset → session is immediately `ready` at `127.0.0.1:22` |
| Graders | Same ContentPack shell scripts as the native app (SSH from the API process) |
| Smoke | `scripts/smoke-web-session.sh`; with `OPSCOACH_SMOKE_START_COMPOSE=1`, starts a foundations lab on port 22 |

**Today:** mock mode does not start a lab container for you. You must run Docker Compose yourself (or use the smoke script’s compose helper) so something listens on `:22`.

## What’s missing for “just works” local dev

The native app’s `ContainerManager` starts a **per-session** `docker compose` project, maps a dynamic SSH port, injects learner and grader keys, and tears down on stop. The web app does not implement that yet.

| Gap | Impact | Likely fix |
|-----|--------|------------|
| No auto `docker compose` per session | Manual lab startup | `LocalLabProvisioner` behind `provisionLabInstance()` when `OPSCOACH_LOCAL_DEV=1` |
| AWS labs call STS/CFN on create | `aws-security-basics` fails without platform stacks | Skip `prepareAwsSession()` in local mode or use fixture `aws-session/` files |
| Beaconkeeper seeds / images | Capstone needs correct image + seed | Read `runtime.directory` + `defaultSeed` from manifest (same as native) |
| `next dev` + in-memory sessions | Hot reload clears sessions → 403 on `/grade` | Prefer `npm start` after build, or use Postgres locally |
| Port 22 conflicts | Only one lab on default port | Dynamic host ports (`127.0.0.1::22` in compose) |

## Proposed local mode

```bash
# web/.env.local (future)
OPSCOACH_LOCAL_DEV=1
# EC2_LAUNCH_TEMPLATE_ID unset
CONTENT_ROOT=../ContentPacks
SESSIONS_ROOT=/tmp/opscoach-sessions
```

Behavior when `OPSCOACH_LOCAL_DEV=1`:

1. `provisionLabInstance()` runs `docker compose` from the lab’s `runtime.directory`.
2. Maps a free host port; sets `sshHost` / `graderHost` to `127.0.0.1` and the chosen port.
3. Injects learner public key and per-session grader key into the container.
4. `stop` runs `docker compose down` for that session project.
5. Skips AWS lab prep, EventBridge Scheduler, and EC2 terminate paths.

Optional: `scripts/dev.sh` to check Docker, export env, start Next.js.

## Effort estimate

| Scope | Effort | Outcome |
|-------|--------|---------|
| MVP: `linux-foundations` auto-docker | ~1 to 2 days | Full UI + grader loop without AWS |
| All SSH packs + beaconkeeper | ~3 to 5 days | Parity with native non-AWS labs |
| AWS lab local | Extra | Mock/fixture credentials or explicit “requires platform” error |

## Architecture note

Keep a single orchestration interface (`provisionLabInstance` / `terminateLabInstance`). Production: EC2 user-data + Docker on the instance. Local: Docker on the developer’s machine. Same API routes, graders, and ContentPacks.

## References

- Mock EC2: `web/lib/ec2-labs.ts` (`isMockEc2Mode()`)
- Compose smoke: `scripts/smoke-web-session.sh`
- Production deploy: `infra/PLATFORM_INTEGRATION.md`

## Status

**Deferred**: ship Platform deploy first; implement `OPSCOACH_LOCAL_DEV` / `LocalLabProvisioner` when local iteration becomes a bottleneck.

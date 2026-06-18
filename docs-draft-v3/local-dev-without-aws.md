# Local development without AWS

**Status: deferred.** The web app already runs offline well enough to build most features (mock provisioning, in-memory or local Postgres, the real graders). What it does not yet do is start a lab container for you per session, the way the native macOS app does. This doc records what works today, the gap, and the local mode that would close it. The plan is to ship the platform deploy first and build `OPSCOACH_LOCAL_DEV` when local iteration becomes a bottleneck.

## Goal

Match the macOS app's day-to-day loop on a developer machine, with no EC2, Fargate, RDS, or AWS API calls: open the app, start a lab, SSH from your terminal, see live grading, stop the lab. Production still uses Fargate plus per-session EC2; local dev would use Docker on the host.

## What already works (no AWS)

| Piece | Behavior |
|-------|----------|
| Web UI | `cd web && npm run dev`: catalog, play flow, session page, SSE grading |
| Session store | In-memory when `DATABASE_URL` is unset; optional local Postgres |
| Provisioning | **Mock EC2** when `EC2_LAUNCH_TEMPLATE_ID` is unset, so a session is immediately `ready` at `127.0.0.1:22` |
| Graders | The same ContentPack shell scripts as the native app (SSH from the API process) |
| Smoke | `scripts/smoke-web-session.sh`; with `OPSCOACH_SMOKE_START_COMPOSE=1`, starts a foundations lab on port 22 |

The catch today: mock mode does not start a lab container for you. You run Docker Compose yourself (or use the smoke script's compose helper) so something listens on `:22`.

## What is missing for "just works" local dev

The native app's `ContainerManager` starts a per-session `docker compose` project, maps a dynamic SSH port, injects learner and grader keys, and tears down on stop. The web app does not implement that yet.

| Gap | Impact | Likely fix |
|-----|--------|------------|
| No auto `docker compose` per session | Manual lab startup | `LocalLabProvisioner` behind `provisionLabInstance()` when `OPSCOACH_LOCAL_DEV=1` |
| AWS labs call STS/CFN on create | `aws-security-basics` fails without platform stacks | Skip `prepareAwsSession()` in local mode, or use fixture `aws-session/` files |
| Beaconkeeper seeds / images | The capstone needs the correct image and seed | Read `runtime.directory` and `defaultSeed` from the manifest (same as native) |
| `next dev` plus in-memory sessions | Hot reload clears sessions, so `/grade` returns 403 | Prefer `npm start` after a build, or use Postgres locally |
| Port 22 conflicts | Only one lab on the default port | Dynamic host ports (`127.0.0.1::22` in compose) |

## Proposed local mode

```bash
# web/.env.local (future)
OPSCOACH_LOCAL_DEV=1
# EC2_LAUNCH_TEMPLATE_ID unset
CONTENT_ROOT=../ContentPacks
SESSIONS_ROOT=/tmp/opscoach-sessions
```

When `OPSCOACH_LOCAL_DEV=1`, `provisionLabInstance()` would:

1. Run `docker compose` from the lab's `runtime.directory`.
2. Map a free host port and set `sshHost` / `graderHost` to `127.0.0.1` and that port.
3. Inject the learner public key and a per-session grader key into the container.
4. On `stop`, run `docker compose down` for that session's project.
5. Skip AWS lab prep, EventBridge Scheduler, and the EC2 terminate paths.

Optionally, a `scripts/dev.sh` would check Docker, export the env, and start Next.js.

## Effort estimate (deferred)

| Scope | Effort | Outcome |
|-------|--------|---------|
| MVP: `linux-foundations` auto-docker | ~1 to 2 days | Full UI plus grader loop without AWS |
| All SSH packs plus beaconkeeper | ~3 to 5 days | Parity with native non-AWS labs |
| AWS lab local | Extra | Mock/fixture credentials, or an explicit "requires platform" error |

## Architecture note

Keep one orchestration interface (`provisionLabInstance` / `terminateLabInstance`). Production runs EC2 user-data plus Docker on the instance; local would run Docker on the developer's machine. Same API routes, graders, and ContentPacks. That single seam is what keeps a local provisioner from forking the codebase.

## References

- Mock EC2: `web/lib/ec2-labs.ts` (`isMockEc2Mode()`).
- Compose smoke: `scripts/smoke-web-session.sh`.
- Production deploy: [`../infra/PLATFORM_INTEGRATION.md`](../infra/PLATFORM_INTEGRATION.md).

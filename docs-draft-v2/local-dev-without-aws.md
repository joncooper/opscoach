# Local development without AWS

**Status: deferred.** Most of the web app already runs on a developer machine with no AWS; the gap is automatic per-session Docker, which is not yet built. This doc records what works today and what a full local-Docker mode (`OPSCOACH_LOCAL_DEV`) would take, so the work can be picked up when local iteration becomes a bottleneck. The deploy target stays Fargate plus per-session EC2; only local dev would use Docker on the host.

The bar to match is the native macOS app's loop: open the app, start a lab, SSH from your terminal, see live grading, stop the lab.

## What already works (no AWS)

| Piece | Behavior |
|-------|----------|
| Web UI | `cd web && npm run dev`: catalog, play flow, session page, SSE grading |
| Session store | In-memory when `DATABASE_URL` is unset; optional local Postgres |
| Provisioning | **Mock EC2** when `EC2_LAUNCH_TEMPLATE_ID` is unset: the session is immediately `ready` at `127.0.0.1:22` |
| Graders | The same ContentPack shell scripts as the native app (SSH from the API process) |
| Smoke | `scripts/smoke-web-session.sh`; with `OPSCOACH_SMOKE_START_COMPOSE=1`, it starts a foundations lab on port 22 |

The catch: mock mode does not start a lab container for you. Something has to be listening on `:22`, so today you run Docker Compose yourself, or use the smoke script's compose helper.

## The gap: no per-session Docker

The native app's `ContainerManager` starts a per-session `docker compose` project, maps a dynamic SSH port, injects the learner and grader keys, and tears it down on stop. The web app does not implement that yet. Five things stand between mock mode and a hands-off local loop:

| Gap | Impact | Likely fix |
|-----|--------|------------|
| No auto `docker compose` per session | Manual lab startup | `LocalLabProvisioner` behind `provisionLabInstance()` when `OPSCOACH_LOCAL_DEV=1` |
| AWS labs call STS/CFN on create | `aws-security-basics` fails without platform stacks | Skip `prepareAwsSession()` in local mode, or use fixture `aws-session/` files |
| Beaconkeeper seeds / images | The capstone needs the right image and seed | Read `runtime.directory` and `defaultSeed` from the manifest (as the native app does) |
| `next dev` + in-memory sessions | Hot reload clears sessions, so `/grade` returns 403 | Prefer `npm start` after a build, or use Postgres locally |
| Port 22 conflicts | Only one lab on the default port | Dynamic host ports (`127.0.0.1::22` in compose) |

## Proposed local mode

Gate the behavior on `OPSCOACH_LOCAL_DEV=1`, with `EC2_LAUNCH_TEMPLATE_ID` left unset so provisioning does not fall into the AWS path:

```bash
# web/.env.local (future)
OPSCOACH_LOCAL_DEV=1
# EC2_LAUNCH_TEMPLATE_ID unset
CONTENT_ROOT=../ContentPacks
SESSIONS_ROOT=/tmp/opscoach-sessions
```

When `OPSCOACH_LOCAL_DEV=1`:

1. `provisionLabInstance()` runs `docker compose` from the lab's `runtime.directory`.
2. It maps a free host port and sets `sshHost` / `graderHost` to `127.0.0.1` and that port.
3. It injects the learner public key and the per-session grader key into the container.
4. `stop` runs `docker compose down` for that session's project.
5. It skips AWS lab prep, the EventBridge Scheduler, and the EC2 terminate paths.

Optionally, a `scripts/dev.sh` would check Docker, export the env, and start Next.js.

## Effort estimate

Deferred, so these are sizing guesses, not commitments:

| Scope | Effort | Outcome |
|-------|--------|---------|
| MVP: `linux-foundations` auto-docker | ~1 to 2 days | Full UI and grader loop without AWS |
| All SSH packs plus Beaconkeeper | ~3 to 5 days | Parity with the native non-AWS labs |
| AWS lab local | Extra | Mock/fixture credentials, or an explicit "requires platform" error |

## Why this shape

Keep one orchestration interface, `provisionLabInstance` / `terminateLabInstance`, with two implementations behind it: production runs EC2 user-data plus Docker on the instance, local runs Docker on the developer's machine. The API routes, graders, and ContentPacks stay identical across both, so local dev exercises the real code paths rather than a parallel mock.

## References

- Mock EC2: `web/lib/ec2-labs.ts` (`isMockEc2Mode()`)
- Compose smoke: `scripts/smoke-web-session.sh`
- Lab teardown in production: [lab-lifecycle-design.md](lab-lifecycle-design.md)
- Production deploy: [`../infra/PLATFORM_INTEGRATION.md`](../infra/PLATFORM_INTEGRATION.md)

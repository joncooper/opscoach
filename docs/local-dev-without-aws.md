# Local development without AWS

Run the OpsCoach web app on a laptop with no AWS account: clone the repo, `npm run dev`, and the full UI plus grader loop come up in minutes. This doc is the design for closing the last manual gap in that loop. It is a deferred proposal, not a how-to: most of what is below does not exist yet, and the table marks what works today from what is still planned.

## Scope

The goal is the local equivalent of the production lifecycle (provision, operate, grade, tear down) for the SSH-based content packs, close enough that a contributor never needs AWS to build and test a feature. Non-goals: reproducing the AWS control plane locally (Cognito, EventBridge Scheduler, the terminator Lambda), and the AWS-credential labs, whose offline story is deferred under Alternatives.

## What works today, and the one gap

Most of the loop already runs without AWS:

| Piece | Local behavior |
|-------|----------------|
| Web UI | `cd web && npm run dev` serves the catalog, play flow, session page, and SSE grading |
| Session store | In-memory `Map` when `DATABASE_URL` is unset; point it at a local Postgres to persist |
| Provisioning | Mock EC2 when `EC2_LAUNCH_TEMPLATE_ID` is unset (`isMockEc2Mode()` in `../web/lib/ec2-labs.ts`): a session goes `ready` at `127.0.0.1:22` |
| Graders | The same ContentPack scripts as production, run as a subprocess that SSHes from the API process |
| Smoke test | `../scripts/smoke-web-session.sh`; with `OPSCOACH_SMOKE_START_COMPOSE=1` it brings up a foundations lab on `127.0.0.1:22` |

The gap is a single missing piece. Mock mode returns `127.0.0.1:22` but starts nothing listening there. In production a host's user-data brings the lab container up; locally, nothing does, so today you supply the container yourself, by hand or through the smoke script's helper. Closing that seam is the proposal.

(One smaller dev-loop snag lives here too: the in-memory store is wiped on every `next dev` hot reload, after which `/grade` fails with "Invalid session or token." Run `npm start` on a built bundle, or point at a local Postgres, to keep sessions across reloads.)

## One interface, two backends

**Constraint:** the product has to provision a lab two completely different ways, a fresh EC2 host in production and a local container in development, without forking the session lifecycle, the grader, or the API routes.

**Decision:** keep one orchestration interface, `provisionLabInstance()` and `terminateLabInstance()`, and vary only what sits behind it. Production runs Docker on an EC2 host it boots through user-data; local mode runs Docker on the laptop. Everything upstream (the API routes, the SSH grader, the ContentPacks) is identical, because the difference is confined to that one pair of functions. It is the same boundary that already lets mock EC2 stand in for an actual launch; local mode extends it from "return a fake host" to "start a running local one." This is also the bulk of what the native macOS app's `ContainerManager` did (a per-session `docker compose` project, a mapped SSH port, injected keys, teardown on stop), now rebuilt behind the shared interface.

One flag drives it. `web/.env.local` sets `OPSCOACH_LOCAL_DEV=1`, leaves `EC2_LAUNCH_TEMPLATE_ID` unset, and points `CONTENT_ROOT` and `SESSIONS_ROOT` at local paths. With the flag on, `provisionLabInstance()` runs `docker compose` from the lab's `runtime.directory`, maps a free host port, wires `sshHost` and `graderHost` and injects the learner and per-session grader keys, and tears down with `docker compose down` on stop. It skips the AWS-only paths: STS and CloudFormation prep, the Scheduler one-shot, the EC2 terminate calls. An optional `scripts/dev.sh` would check Docker, export the env, and start Next.js, so the loop is one command.

**Trade-off:** the interface has to stay narrow enough that both backends honor it, which keeps EC2-specific and Docker-specific details out of the callers. That narrowness is what makes the whole system testable without AWS. The work is worth doing once local iteration, not deploy, is what slows contributors down.

The one piece this design cannot fully scope in advance is Beaconkeeper: its image and seed (`runtime.directory` and `defaultSeed` from the manifest) need a run to pin down.

## Alternatives considered

A full local AWS emulation (LocalStack or similar) was rejected: it rebuilds the control plane this design treats as a non-goal, and trades a little manual setup for a large, drifting dependency that still would not run the labs. Driving everything through the smoke script's compose helper was rejected as the primary path because it is a test harness, not a dev loop: it starts one fixed lab on a fixed port rather than tracking the lab a learner picked. It stays useful as a fast end-to-end check.

For the AWS-credential labs, the choice is deferred: either mint fixture credentials so they run offline, or have local mode return an explicit "this lab requires the platform" error. The error path is cheaper; fixtures are more complete. Whoever picks this up decides based on whether offline AWS labs justify the fixture upkeep.

## References

- Mock EC2 and the orchestration interface: `../web/lib/ec2-labs.ts` (`isMockEc2Mode()`, `provisionLabInstance()`, `terminateLabInstance()`)
- AWS lab prep that local mode skips: `../web/lib/aws-lab-manager.ts` (`prepareAwsSession()`)
- Production deploy and the shared environment: `../infra/PLATFORM_INTEGRATION.md`

# Lab host lifecycle and teardown

Status: implemented (web app + CDK).

Every learner session gets its own EC2 lab host, and the load-bearing problem is killing it again. This doc explains how OpsCoach provisions and tears down per-session hosts, and why teardown runs as three independent paths instead of one. For the wider security argument that teardown protects, see [security.md](security.md); for where this sits in the system, see [architecture.md](architecture.md).

## Problem

A session can launch a dedicated `t4g.micro` host (Amazon Linux 2023, arm64) running the lab container under Docker. If teardown fails or never runs, hosts leak and bill by the hour. Teardown is therefore the control that has to work.

The trap is assuming the control plane knows when a learner is done. It does not. The web app embeds a browser terminal: xterm.js streams over a WebSocket to a custom Node server (`web/server.js`), which bridges to the host with an `ssh2` PTY on port 22. That bridge holds a connection open with a 25-second keepalive so the load balancer does not cut an idle terminal, so its liveness tracks the socket, not the human.

The learner can also opt into SSH straight from their laptop to the host's public IP, and those sessions never touch the control plane at all. Either way, the Next.js control plane on Fargate cannot reliably infer idle from a browser tab, and it is blind to direct SSH. Whatever decides "this host is idle" has to live on the host.

So teardown has to be:

- **Prompt** once the learner is actually gone (no live SSH on the box).
- **Reliable** when a callback is dropped, a schedule misfires, or the learner never connects at all.
- **Idempotent**, because more than one path can fire on the same host within seconds.

**Non-goals.** This is not a cost-optimization or autoscaling design: there is no bin-packing, no spot fallback, no warm pool. It does not extend a session on activity (a started host dies at its cap regardless of use; see Future improvements). And it is not the security model. It is the mechanism that guarantees the security model's one-hour blast radius actually expires.

## Defense in depth: three teardown paths

Three independent paths bring a host down, and any one is enough: an on-host **idle watcher** for the common case (the learner walks away), a one-shot **max-lifetime timer** as the hard cap, and a periodic **sweep** as the backstop for when the first two never fire. No single mechanism is trusted, because each fails in its own way: the host can wedge, a callback can drop, a schedule can fail to be created at provision. Layering trades a few extra moving parts for a hard guarantee that nothing runs forever, and all three are safe to run more than once.

| Path | Fires when | Runs on | Typical latency |
|------|------------|---------|-----------------|
| 1. SSH idle watcher | No established TCP on host `:22` for the grace period, after at least one session was seen | Background script in host user-data | ~2 min after the last disconnect |
| 2. Max-TTL schedule | A one-shot EventBridge Scheduler entry created at provision | Terminator Lambda | At T + max lifetime, exactly |
| 3. ExpiresAt sweep | An `ExpiresAt` instance tag is in the past | Same Lambda, every 5 min | Up to 5 min after the tag expires |

The three "Why not X alone?" sections below justify the layering, one path at a time. First, the learner's **Stop lab** button and the authenticated `POST /api/sessions/:id/stop` are not a fourth path: they call the same internal shutdown routine the automated paths converge on (see Unified shutdown).

### Why not the idle watcher alone?

Because it runs on the host, and the host can misreport or go silent. The watcher fails to fire in exactly the cases that cost the most: the learner provisions a host and never connects (so the watcher never sees a session to start its idle clock), a bug stalls the loop, or the host wedges badly enough that nothing on it runs. The watcher is the prompt path, not the guaranteed one, so it needs a backstop that runs off-host.

### Why not a timer alone?

A timer with no idle signal is either too aggressive or too loose. Tune it short and it kills learners mid-lab; tune it long and idle hosts bill for the slack. The earlier design made exactly this mistake: it set `ExpiresAt = now + 10 min` at provision and called it idle teardown, which just terminated active sessions ten minutes in. A fixed cap is the right tool for *bounding* cost, not for detecting idle. It belongs as the backstop, with a real idle signal in front of it.

### Why both a schedule and a sweep?

They cover different failures. The schedule is precise but can fail to exist: if `CreateSchedule` fails at provision (missing IAM, a transient API error), there is no timer for that host, and a host with no timer is exactly the host that leaks. The sweep needs nothing but a tag that `RunInstances` already wrote, so it catches hosts the schedule missed, plus any that outlived their schedule through API errors. One path is precise but can fail to exist, the other is blunt but certain, and a single Lambda runs both.

## Path 1: SSH idle watcher

Generated as shell user-data in `web/lib/lab-user-data.ts` (mirrored in `infra/lib/lab-user-data.sh` for launch-template defaults). A background loop runs on the host:

1. Every 15 seconds, count established connections on local port 22 with `ss -tn state established '( sport = :22 )'`.
2. Once that count goes above zero, latch a `had_session` flag. The watcher will not act until it has seen at least one real session.
3. When `had_session` is set and the count falls back to zero, start an idle clock.
4. After `SSH_IDLE_GRACE_SECONDS` (default **120**) of continuous idle, POST the shutdown webhook:

```http
POST /api/sessions/:id/shutdown
X-Internal-Secret: <shared secret>
Content-Type: application/json

{ "reason": "ssh_idle" }
```

The 120-second grace debounces two things: a brief network blip or `ssh` reconnect that should not end the session, and the grader's SSH from Fargate (the platform grades a lab by logging in to check real state) that should be allowed to finish without racing a learner disconnect.

The watcher only *asks* for teardown. It cannot terminate anything: the lab instance role grants log writes and ECR image pulls and nothing else (no `ec2:TerminateInstances`), so a compromised host cannot turn the watcher into a weapon against other instances. Termination always runs off-host, gated by the callback secret.

Two limits are deliberate for v1:

- **The watcher counts every connection on `:22`, including grader SSH from inside the VPC.** A learner who never opens a terminal but runs checks repeatedly from the web UI can see their host torn down soon after grading goes quiet. Acceptable now; the fix is source-aware counting (below).
- **If the learner never SSHes, `had_session` stays unset and the watcher never fires.** That host is precisely what the max-TTL path exists to catch.

## Path 2: Max-TTL schedule

`web/lib/session-scheduler.ts`, called from `web/lib/ec2-labs.ts` right after `RunInstances`. On a successful provision, Fargate creates a one-shot EventBridge Scheduler entry named `opscoach-{sessionId}` (truncated to 64 characters):

- Expression `at(<UTC timestamp>)`, set to **T + maxLifetimeMinutes** from provision.
- Target: the terminator Lambda, with `{ "action": "terminate", "instanceId": "...", "sessionId": "...", "reason": "max_ttl" }`.
- `ActionAfterCompletion: DELETE`, so the entry cleans itself up after it fires.
- Any earlier shutdown (`manual`, `ssh_idle`) calls `DeleteSchedule`, so a host that dies early does not leave a dangling timer.

**Default max lifetime: 60 minutes** (`OPSCOACH_MAX_LIFETIME_MINUTES`, CDK context `maxLifetimeMinutes`). Sixty minutes is long enough for a full lab plus assessment retries and short enough to bound the bill if every other path fails. It is intentionally orthogonal to the idle grace: one bounds the worst case, the other handles the normal case.

**Why EventBridge Scheduler, not EventBridge Rules?** Scheduler does one-shot schedules natively, with per-session names and auto-delete after firing. Rules are built for recurring patterns, which is why the 5-minute sweep (path 3) uses a Rule and the per-session cap does not.

## Path 3: ExpiresAt sweep

`infra/lib/session-terminator/handler.py`, triggered every 5 minutes by an EventBridge Rule defined in `infra/lib/lab-host-stack.ts`. At provision, `RunInstances` tags the host `ExpiresAt=<ISO8601>` on the same horizon as the schedule. On each run, the Lambda lists running OpsCoach hosts (tag `OpsCoach=true`) and, for any whose `ExpiresAt` is in the past, terminates the instance and calls the shutdown API with `reason=expires_at_sweep`.

The sweep depends on nothing but a tag the launch already wrote, which is the whole point: it is the safety net for the rare host whose schedule was never created or somehow outlived itself.

## Unified shutdown

Every path, automated or manual, converges on `shutdownSessionInternal` in `web/lib/sessions.ts`. Keeping one routine is what makes the idempotency real: concurrent triggers collapse onto the same guarded transition instead of racing.

1. Return immediately if the session is already `stopped` or `stopping`.
2. Set status `stopping`.
3. `DeleteSchedule` (best effort).
4. `TerminateInstances` if an instance id is present. Errors are logged, and the session is still marked stopped, so an API hiccup never strands a session in limbo.
5. Set status `stopped` and publish the event the dashboard streams over SSE.

There are two ways in, both reaching the same routine:

| Entry point | Auth | Reasons |
|-------------|------|---------|
| `POST /api/sessions/:id/stop` | Session token | `manual` |
| `POST /api/sessions/:id/shutdown` | `X-Internal-Secret` | `ssh_idle`, `max_ttl`, `expires_at_sweep`, `manual` |

The terminator Lambda terminates EC2 first, then calls the shutdown API, so the EC2 state of the world and the Postgres record converge rather than drift. The shutdown route rejects an unsigned call with 401.

## Alternatives considered

| Approach | Rejected because |
|----------|------------------|
| Provision-time timer as "idle" (`ExpiresAt = now + 10 min`) | Kills active sessions; a fixed timer is not idle detection. This is the bug the current design replaced. |
| Web-only activity timeout | The control plane is blind to SSH. A learner working in the terminal looks idle if the browser tab is quiet, and direct SSH is invisible entirely. |
| Tailscale-only SSH (no public IP) | A product decision for v1: hardened public SSH only. The watcher and timers are written so this can change without reworking teardown. |
| A dedicated Lambda per session | One shared terminator Lambda plus a per-session schedule is simpler to operate and cheaper than N functions. |
| Host self-terminates via its own IAM | Widens the blast radius of a compromised host. Termination stays off-host, behind the callback secret. |

## Configuration

The two knobs that change behavior are the max lifetime and the idle grace. Both are set from the Fargate task environment and plumbed from CDK context; the rest of the environment wires the actors together.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPSCOACH_MAX_LIFETIME_MINUTES` | `60` | Schedule fire time and `ExpiresAt` horizon |
| `OPSCOACH_SSH_IDLE_GRACE_SECONDS` | `120` | Host idle debounce before the shutdown webhook |
| `SESSION_TERMINATOR_LAMBDA_ARN` | (from CDK) | Schedule target |
| `SCHEDULER_INVOKE_ROLE_ARN` | (from CDK) | Scheduler execution role |
| `INTERNAL_CALLBACK_SECRET` | (Secrets Manager) | Authenticates host and Lambda callbacks |

One CDK field is a deliberate trap to avoid: `idleTimeoutMinutes` (default `10`) is a legacy name from the old timer-as-idle design and **no longer drives `ExpiresAt`**. The horizon comes from `maxLifetimeMinutes`. The name is kept only to avoid a churning rename; do not wire teardown to it.

Without `EC2_LAUNCH_TEMPLATE_ID`, provisioning is mock-only: no real host, no scheduler, no watcher, and sessions live in memory unless `DATABASE_URL` is set. That is the local-development path, covered in [local-dev-without-aws.md](local-dev-without-aws.md).

## CDK components

| Resource | Stack | Role |
|----------|-------|------|
| Terminator Lambda | Lab host stack | Direct terminate, the 5-minute sweep, and the shutdown-API notify |
| Scheduler-invoke IAM role | Lab host stack | Lets EventBridge Scheduler invoke the Lambda |
| EventBridge Rule (5 min) | Lab host stack | Sweep trigger |
| Callback secret | Lab host stack | Shared HMAC secret, read by the Fargate task |
| Scheduler IAM on the task role | Web stack | `CreateSchedule` / `DeleteSchedule` |

For how these stacks plug into a borrowed ALB/Cognito/VPC platform, see [../infra/PLATFORM_INTEGRATION.md](../infra/PLATFORM_INTEGRATION.md).

## Future improvements

- **Source-aware idle detection.** Count only SSH from non-VPC (learner) addresses, so web-only grading stops arming the watcher and the first known limitation goes away.
- **Activity extension.** Refresh `ExpiresAt` and reschedule the max-TTL entry on a grader run or an explicit heartbeat, trading some cost for longer working sessions.
- **Teardown metrics.** CloudWatch counters per reason (`ssh_idle`, `max_ttl`, `expires_at_sweep`, `manual`) to tune the grace and the cap against real usage instead of guesses.
- **Pre-baked AMI.** A Packer image with Docker, the watcher, and host hardening already installed, replacing the full user-data bootstrap and shaving provision time.

## Related files

- `web/lib/ec2-labs.ts`: provision, tag, kick off the schedule
- `web/lib/session-scheduler.ts`: EventBridge Scheduler client
- `web/lib/lab-user-data.ts`: host bootstrap and the idle watcher
- `web/app/api/sessions/[id]/shutdown/route.ts`: internal shutdown API
- `web/lib/sessions.ts`: `shutdownSessionInternal`, the unified path
- `infra/lib/lab-host-stack.ts`: terminator Lambda, sweep Rule, scheduler role
- `infra/lib/session-terminator/handler.py`: terminate and sweep logic

# Security model

**Status: v1.0**

OpsCoach gives authenticated users a Linux machine and lets them run commands as a privileged user. That is the product. It is also the main security problem. Here is how the risk is contained.

## The core bet

Assume the lab container can be escaped, and design so it does not matter.

**The EC2 host is the boundary, not the container.** A learner doing a systemd or filesystem lab needs full control of the box, so the lab container runs `--privileged`. OpsCoach does not treat that container as a strong wall. It treats the host as the line, and makes the host cheap to lose:

- **One host per session.** No shared tenancy, so a learner can only ever reach their own machine.
- **Nothing valuable lives on it.** The host's IAM role can pull its lab image and write logs, and nothing more. Database credentials, the callback secret, and grader keys never touch the host.
- **It dies on a timer.** Idle for a couple of minutes, or 60 minutes old, whichever comes first. Teardown is enforced from outside the host, so a hung or hostile box still gets killed.

Worst case for an escaped container: full control of one throwaway machine, with no useful credentials, for at most an hour.

## Layers

The controls, from the edge inward.

**Getting in takes two gates.** The shared ALB authenticates every request through Cognito (hosted UI, Google). Behind it, the app requires a shared passphrase before any page renders (`web/lib/gate.ts`). Only the ALB health check and logout skip Cognito. Each user is capped at three concurrent sessions by default, and every session carries a short-lived bearer token checked against a hash in the database.

**A running host is built to be worthless to steal.** Its IAM role is read-only: it can pull `opscoach-lab*` images and write to the lab log group, nothing more. That role is firewalled off from the container anyway. A `DOCKER-USER` iptables rule drops traffic to `169.254.169.254`, and the host requires IMDSv2 with a one-hop limit, so even a privileged container cannot read the instance role or any secret from metadata. The network path is one-way: the host's security group takes learner SSH from the internet but takes the grader's SSH only from the web service's security group. No learner can reach anyone else's box, and the database sits in an isolated subnet behind the private web service.

**Credentials stay off the host.** Database credentials and the callback HMAC secret live in Secrets Manager, read at runtime by the web task and the terminator Lambda. They are never written to a host or baked into an image. Grading is least-privilege: the grader runs as a subprocess with an allowlisted environment (`PATH`, `HOME`, `LANG`, `AWS_REGION`, `AWS_CONFIG_FILE`, and a few locale variables) and none of the web task's AWS credentials. AWS labs that need cloud access get their own scoped, per-session STS credentials. Each session mints two fresh keypairs (the learner's, with the public key on the box and the private key theirs, and the grader's, server-only), so a leaked learner key reaches one already-owned box and nothing else.

## Deliberate trade-offs

The sharp edges, and why they are acceptable here.

- **The lab container is privileged.** Needed for systemd and realistic admin work. Acceptable because the host around it is single-tenant, credential-poor, and short-lived (see the core bet).
- **The terminal bridge skips SSH host-key verification** (`hostVerifier: () => true` in `web/server.js`). The host was created seconds earlier with a per-session key, and is reached over the AWS private network. There is no prior key to pin, and no third party in the path. The keys are discarded with the session.
- **Learner SSH is open to the internet.** That is the feature. The grader's path is not; it is locked to the web service's security group.

## What this is not

OpsCoach is training infrastructure, not a hostile multi-tenant sandbox. It does not stop a learner from using their own host's outbound network during the session. It bounds spend with a per-user session cap rather than hard cost controls. Both are reasonable given the audience and the one-hour blast radius.

Teardown is the control everything else rests on, so it has three independent layers: an SSH-idle watcher, a one-shot timer, and a periodic sweep. The full design is in **[lab-lifecycle-design.md](lab-lifecycle-design.md)**.

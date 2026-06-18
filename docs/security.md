# Security model

OpsCoach gives authenticated users a real Linux machine and lets them run real commands as a privileged user. That is the product, and it is also the main security problem. Here is how the risk is contained.

## The core bet

Assume the lab container can be escaped, and design so it does not matter.

A learner doing a systemd or filesystem lab needs real control of the box, so the lab container runs `--privileged`. Rather than treat that container as a strong wall, OpsCoach treats the **EC2 host as the real boundary** and makes the host cheap to lose:

- **One host per session.** No shared tenancy, so a learner can only ever reach their own machine.
- **Nothing valuable lives on it.** The host's IAM role can pull its lab image and write logs, and that is all. Database credentials, the callback secret, and grader keys never touch the host.
- **It dies on a timer.** Idle for 10 minutes, or 60 minutes old, whichever comes first. Teardown is enforced from outside the host, so a wedged or hostile box still gets killed.

Worst case for an escaped container: full control of one throwaway machine, with no useful credentials, for at most an hour.

## Layers

From the edge inward.

**Two ways in.** The shared ALB authenticates every request through Cognito (hosted UI, Google). Behind that, the app requires a shared passphrase before any page renders (`web/lib/gate.ts`); only the ALB health check and logout skip Cognito. Each user is limited to a few concurrent sessions, and every session carries a short-lived bearer token checked against a hash in the database.

**A minimal host identity.** The lab instance's IAM role is read-only: pull `opscoach-lab*` images from ECR and write to the lab log group. Nothing else.

**Metadata is firewalled off from the container.** A `DOCKER-USER` iptables rule drops traffic to `169.254.169.254`, and the host requires IMDSv2 with a one-hop limit. So even a privileged container cannot read the host's instance role or any secret from instance metadata.

**A one-way network path.** The lab host is the only public component, and learners SSH straight to it. Its security group accepts learner SSH from the internet, but accepts the grader's SSH *only* from the web service's security group. No learner has a route to anyone else's box. The database sits in an isolated subnet; the web service runs private behind the ALB.

**Secrets stay in Secrets Manager.** Database credentials and the callback HMAC secret are read at runtime by the web task and the terminator Lambda. They are never written to a host or baked into an image.

**Least-privilege grading.** The grader runs as a subprocess with an allowlisted environment only (`PATH`, `HOME`, `LANG`, `AWS_REGION`, and a few more). The web task's own AWS credentials are deliberately kept out of it. AWS labs that need cloud access get their own scoped, per-session STS credentials in the session's workdir.

**Fresh keys per session.** Each session mints two keypairs: the learner's (public key injected into the box, private key theirs to use) and the grader's (held only by the server). A leaked learner key reaches one already-owned box and nothing else.

## Deliberate trade-offs

The sharp edges, and why they are acceptable here.

- **The lab container is privileged.** Needed for systemd and realistic admin work. Acceptable because the host around it is single-tenant, credential-poor, and short-lived (see the core bet).
- **The terminal bridge skips SSH host-key verification** (`hostVerifier: () => true` in `web/server.js`). The host was created seconds earlier with a per-session key and is reached over the AWS private network, so there is no prior key to pin and no third party in the path. The keys are discarded with the session.
- **Learner SSH is open to the internet.** That is the feature. The grader's path is not open; it is locked to the web service's security group.

## What this is not

OpsCoach is training infrastructure, not a hostile multi-tenant sandbox. It does not stop a learner from using their own host's outbound network during the session, and it bounds spend with a per-user session cap rather than hard cost controls. Both are reasonable given the audience and the one-hour blast radius.

Teardown is the load-bearing control, so it has three independent layers: an SSH-idle watcher, a one-shot timer, and a periodic sweep. The full design is in **[lab-lifecycle-design.md](lab-lifecycle-design.md)**.

# Security model

OpsCoach hands authenticated users a real Linux machine and lets them run real commands as a privileged user. That is the product, and it is also the security problem. The whole design is about making that machine cheap to lose.

## The core bet

Assume the lab container can be escaped, and build so that escaping it does not matter.

A learner doing a systemd or filesystem lab needs genuine control of the box, so the lab container runs `--privileged`. Treating that container as a strong wall would be a losing game. Instead OpsCoach treats the EC2 host as the real boundary and makes the host cheap to lose:

- One host per session: no shared tenancy, so a learner can reach only their own machine.
- Nothing valuable lives on it: the host's IAM role can pull the lab image and write logs, and that is the whole list. Database credentials, the callback secret, and grader keys never touch the host.
- It dies on a short clock: teardown is driven from outside the host, so a wedged or hostile box still gets killed.

Worst case for an attacker who escapes the container: full control of one throwaway machine, holding no useful credentials, for at most an hour.

The rest of this document is the controls that make each of those claims true, from the edge inward.

## Two gates, and why they are not the security model

Reaching any page takes two independent checks. The shared Application Load Balancer authenticates every request through Cognito (hosted UI, Google as the identity provider). Behind it, the app requires a shared passphrase before it renders anything (`web/lib/gate.ts`); the accepted codes and cookie token come from environment variables, so no secret lives in source. Only the load balancer health check and the logout route skip Cognito.

These gates keep the public out, but the security model does not rest on them. A shared passphrase is exactly the kind of secret that leaks, so the design never treats it as a wall. If both gates fell, an attacker would reach a session and a privileged host, which is the case the rest of this document is built to survive. Past the gates, every session also carries a short-lived bearer token checked against a hash in the database, so a guessed or stale URL gets a caller nowhere. Each user is capped at three concurrent sessions by default.

## The host is built to be worthless to steal

Once a lab host is running, the design assumes it may be fully compromised and removes anything worth taking.

Its IAM role is read-only and narrow: pull `your-org/opscoach-lab*` images from the registry, write to the lab log group, and nothing else. That role is then kept out of the container's reach.

The control that does the work is IMDSv2 with a one-hop response limit. A metadata request from inside the container crosses the Docker bridge NAT on its way out, and that extra hop spends the single allowance, so the request expires before it reaches the metadata service. A request from the host is still at hop one and succeeds. That is why the host can read its own credentials while the container cannot. A second layer backs it up: a `DOCKER-USER` iptables rule drops container traffic to the metadata address (`169.254.169.254`) outright. A host-root escape can delete that iptables rule, but the one-hop limit still stands, and behind both the role is nearly empty and the host is one isolated, short-lived machine. There is little to take and nowhere to pivot.

The network path is one-way by design. The host's security group accepts learner SSH from the internet, because connecting from your own client is the feature. It accepts the grader's SSH only from the web service's security group, a single source rather than a VPC-wide rule on port 22, so no lab host can reach another. The database sits in an isolated subnet behind the private web service, unreachable from any lab host.

## The valuable secrets live somewhere else

The pieces that hold real credentials stay off the host entirely, so compromising a host never yields them.

Database credentials and the callback HMAC secret live in Secrets Manager, read at runtime by the web task and the terminator Lambda. They are never written to a host or baked into an image.

Grading runs least-privilege. The grader is a committed content-pack program that the web task runs as a child process with an allowlisted environment: `PATH`, `HOME`, `LANG`, `AWS_REGION`, `AWS_CONFIG_FILE`, and a few locale variables. The AWS credential variables and the ECS role-fetch URI are excluded, so a buggy or hostile grader cannot read the database, the callback secret, or assume the task's role. Labs that exercise real cloud APIs do not borrow the task role either; they authenticate with their own scoped, per-session workspace credentials.

Each session also mints two fresh SSH keypairs: the learner's (public key on the box, private key theirs) and the grader's (server-only). A leaked learner key therefore reaches one box the learner already controls, and nothing else, and both keys are discarded when the session ends.

## Teardown is the load-bearing control

Every control above bounds the blast radius; teardown bounds it in time. A host comes down when it goes idle or when it hits an hour old, whichever lands first, and the deadline is enforced from outside the host so a wedged or hostile box cannot dodge it. Three independent paths back that deadline. Any one is enough, and all are safe to run twice:

- an SSH-idle watcher on the host that fires a couple of minutes after the learner disconnects,
- a one-time scheduled timer at the sixty-minute maximum lifetime, and
- a periodic sweep that catches anything the first two missed.

The full design, including why a single timer or a single idle check was rejected, is in [lab-lifecycle-design.md](lab-lifecycle-design.md). For where these controls sit in the larger system, see [architecture.md](architecture.md).

## Honest limits and trade-offs

A few sharp edges are deliberate. The lab container runs privileged, which it must for systemd and realistic administration; that is acceptable only because the host around it is single-tenant, credential-poor, and short-lived. The terminal bridge skips SSH host-key verification (`hostVerifier: () => true` in `web/server.js`): the host was created seconds earlier with a throwaway per-session key, reached over the AWS private network, and discarded with the session, so there is nothing to pin and pinning would add ceremony, not safety.

Two things are out of scope on purpose. OpsCoach does not restrict a learner's outbound network from their own host during the session; egress lockdown waits for the planned move to a dedicated lab account, where it can be tuned to what bootstrap actually needs rather than guessed at now. And it bounds spend with the per-user session cap rather than hard cost controls. Both are reasonable given the audience and the one-hour ceiling on any single host.

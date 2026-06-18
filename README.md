# OpsCoach

**Status: v1.0**

A hands-on platform for learning Linux and AWS operations. Instead of quizzes, you get a throwaway cloud server and a task list, and a grader checks the machine's actual state as you work.

This is a portfolio project. What's worth a look:

- a live browser-to-SSH terminal,
- per-session disposable lab hosts on AWS, and
- grading that reads system state instead of comparing answers.

## Start here

This page is the two-minute pitch. For the system itself, **[docs/architecture.md](docs/architecture.md)** is the walkthrough. It starts at 30,000 feet (the three moving parts), drops to 10,000 feet (the diagram, components, and flows), and lands at 1,000 feet (the design decisions worth defending).

From there:

- **[Security model](docs/security.md)**: how untrusted users get root without putting anything else at risk.
- **[Lab lifecycle](docs/lab-lifecycle-design.md)** and **[local dev](docs/local-dev-without-aws.md)**: ground-level detail, next to the code.

## What it does

A learner opens a lab and gets a dedicated Linux host in a minute or two. They work in a terminal (in the browser or over their own SSH) to fix broken services, harden config, triage logs, wire up systemd. A grader runs against the live machine and streams pass/fail checks to a dashboard beside the terminal. When the learner finishes or goes idle, the host is destroyed.

Three content packs ship today: **Linux Foundations** and **AWS Foundations** drills, and the **Beaconkeeper** capstone, a 20-step systemd and operations scenario on a single box.

## How it works

A request reaches a shared ALB, authenticates through Cognito, and lands on the OpsCoach web app on ECS Fargate. Starting a lab launches a dedicated EC2 host. The web app bridges the browser terminal to that host over SSH, and runs the grader over SSH. Every host self-destructs on an idle or lifetime timer. The [architecture doc](docs/architecture.md) has the diagram and the full provision, terminal, grade, and teardown flows.

## Why it is built this way

The decisions that shaped it:

- **A live host, not a fake shell.** Learning operations means touching actual systemd, packages, and logs. Each session is an EC2 instance, not an emulation.
- **Disposable and single-tenant.** Labs run as a privileged user, so every session gets its own host, wiped on a timer. The security model leans on the cheap, isolated host instead of on container isolation. See [security.md](docs/security.md).
- **Grade state, not answers.** The grader SSHes in and inspects the machine. A check passes only when the box is in the right state.
- **Borrow the platform, do not rebuild it.** The infrastructure plugs into an existing shared ALB, Cognito, and VPC by ID instead of standing up its own. The resource IDs live in local config, kept out of the repo.

## Repository layout

| Path | What it is |
| --- | --- |
| `web/` | Next.js app and custom Node server (WebSocket-to-SSH bridge), API routes, UI |
| `infra/` | AWS CDK app: Fargate service, lab hosts, teardown automation |
| `ContentPacks/` | Labs and graders, including the Beaconkeeper game |
| `scripts/` | Build, deploy, and smoke-test scripts |
| `docs/` | Architecture, security, and design notes |

## Run it locally

```bash
cd web
npm install
cp .env.example .env      # most values are optional locally
npm run dev
```

With no AWS credentials and no `DATABASE_URL`, the app runs in mock mode: an in-memory store and faked provisioning, so you can click through the UI and content offline. Run the tests with `npm test`. More in [docs/local-dev-without-aws.md](docs/local-dev-without-aws.md).

## Configure and deploy

Two things stay out of version control: the app's `web/.env` and the CDK platform context (`infra/cdk.context.json`). Copy each from its example, or generate the context with `scripts/discover-platform-context.sh`. With those in place, `scripts/deploy-platform.sh` builds the images and deploys the stacks. The walkthrough is in [`infra/PLATFORM_INTEGRATION.md`](infra/PLATFORM_INTEGRATION.md).

## License

MIT. See [LICENSE](LICENSE).

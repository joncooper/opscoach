# Access logs

OpsCoach logs one structured line per page request, emitted by `web/middleware.ts`:

```json
{"evt":"access","at":"2026-06-20T15:04:11.000Z","ip":"203.0.113.10","user":"jane@example.com","method":"GET","path":"/catalog"}
```

Each line carries the verified caller (decoded from the ALB OIDC token), the client IP
(first hop of `x-forwarded-for`), the method, and the path. It streams to the web
service's CloudWatch log group, so you can answer who reached what, when, and from
where.

Two things to know:

- It is forward-only. It captures requests from the moment the middleware deploys, not
  retroactively.
- The route matcher excludes static assets and API routes, so every line is a real page
  navigation, not a chatty asset fetch.

For per-session history (which lab a user ran, and when), query the `sessions` table
with `scripts/access-report.sql` instead. The two are complementary: this is page
traffic with IPs, that is session activity with identity.

## Quickest: the helper script

```bash
AWS_PROFILE=<your-profile> scripts/access-log.sh        # last 24h
AWS_PROFILE=<your-profile> scripts/access-log.sh 72      # last 72h
```

It finds the web log group, pulls the access lines, and prints recent requests plus a
per-user rollup (requests and distinct IPs). Read-only.

## CloudWatch Logs Insights

In the console, open Logs Insights, select the web log group (its name contains
`opscoachweb`), set the time range, and run one of these.

Recent requests:

```
fields @timestamp, user, ip, method, path
| filter evt = "access"
| sort @timestamp desc
| limit 100
```

Who, how often, from how many IPs:

```
filter evt = "access"
| stats count() as requests, count_distinct(ip) as ips by user
| sort requests desc
```

Requests per hour:

```
filter evt = "access"
| stats count() as requests by bin(1h)
| sort @timestamp desc
```

Everything from one IP (or swap to `user`):

```
fields @timestamp, user, ip, path
| filter evt = "access" and ip = "203.0.113.10"
| sort @timestamp desc
```

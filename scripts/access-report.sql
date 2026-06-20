-- OpsCoach access / activity report.
--
-- Source: the `sessions` table in the OpsCoach RDS database. Every lab session records
-- the ALB-verified Cognito identity (owner_email / owner_sub) and timestamps, so this
-- answers "who used the app, when, and how often" at the session level.
--
-- Limits: this is session-level, not every page view, and it has NO client IP (the app
-- does not store it). For page views + source IPs, use the shared ALB's access logs, or
-- the per-request access log added in web/middleware.ts (once deployed; query CloudWatch
-- Logs Insights on the web log group: `filter evt="access" | stats count() by user, ip`).
--
-- Run, e.g.:  psql "$DATABASE_URL" -f scripts/access-report.sql
-- (RDS is in a private subnet; reach it from the web task via
--  `aws ecs execute-command ... --command "psql $DATABASE_URL -f -" < scripts/access-report.sql`,
--  or any host with network access to the DB.)

\echo '== Per-user activity, last 3 days =='
SELECT
  COALESCE(owner_email, owner_sub, '(no identity)') AS who,
  COUNT(*)                                          AS sessions,
  COUNT(DISTINCT pack_id || '/' || lab_id)          AS distinct_labs,
  MIN(created_at)                                   AS first_seen,
  MAX(last_activity_at)                             AS last_seen
FROM sessions
WHERE created_at >= now() - interval '3 days'
GROUP BY 1
ORDER BY sessions DESC;

\echo '== Sessions per day, last 14 days =='
SELECT
  date_trunc('day', created_at)::date AS day,
  COUNT(*)                            AS sessions,
  COUNT(DISTINCT owner_sub)           AS distinct_users
FROM sessions
WHERE created_at >= now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;

\echo '== 50 most recent sessions =='
SELECT
  created_at,
  COALESCE(owner_email, owner_sub, '(no identity)') AS who,
  pack_id, lab_id, mode, status
FROM sessions
ORDER BY created_at DESC
LIMIT 50;

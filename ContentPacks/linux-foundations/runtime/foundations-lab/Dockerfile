FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker
RUN rm -f /etc/dpkg/dpkg.cfg.d/excludes \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        alpine bash bc bsd-mailx bsdextrautils ca-certificates coreutils curl dnsutils findutils grep iproute2 iputils-ping jq ksh less lsof man-db manpages manpages-posix nano net-tools netcat-openbsd \
        openssh-server procps python3 quota rsync sudo systemd systemd-sysv tmux tree unzip vim-tiny zip zsh \
    && ln -sf man.REAL /usr/bin/man \
    && ln -sf /usr/bin/alpine /usr/local/bin/pine \
    && (mandb -q || true) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN find /etc/update-motd.d -type f -exec chmod -x {} + 2>/dev/null || true \
    && rm -f /etc/update-motd.d/60-unminimize /run/motd.dynamic /var/run/motd.dynamic /etc/legal \
    && sed -i '/^# sudo hint$/,$d' /etc/bash.bashrc \
    && printf 'Ops Coach lab host. Start in ~/work.\n' > /etc/motd

RUN systemctl set-default multi-user.target || true \
    && rm -f /lib/systemd/system/multi-user.target.wants/getty.target || true

RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -s /bin/bash learner \
    && usermod -aG adm,sudo,systemd-journal learner \
    && useradd -m -s /bin/bash tempadmin \
    && useradd -m -s /bin/bash analyst \
    && useradd -m -s /usr/sbin/nologin opslocked \
    && usermod -aG sudo tempadmin \
    && passwd -l opslocked \
    && mkdir -p /run/sshd /opt/opscoach/private /opt/opscoach/reference /home/learner/.ssh \
    && ssh-keygen -q -t ed25519 -N '' -C opscoach-learner -f /opt/opscoach/private/learner_ed25519 \
    && cp /opt/opscoach/private/learner_ed25519.pub /home/learner/.ssh/authorized_keys \
    && ssh-keygen -q -t ed25519 -N '' -C opscoach-operator -f /opt/opscoach/reference/operator_ed25519 \
    && chmod 700 /home/learner/.ssh \
    && chmod 600 /home/learner/.ssh/authorized_keys /opt/opscoach/private/learner_ed25519 \
    && chown -R learner:learner /home/learner/.ssh \
    && printf 'learner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/learner \
    && chmod 440 /etc/sudoers.d/learner \
    && groupadd -f ops

RUN mkdir -p \
        /home/learner/work/orientation \
        /home/learner/work/search/region-a/archive \
        /home/learner/work/search/region-b/current \
        /home/learner/work/perms \
        /home/learner/work/files \
        /home/learner/work/network \
        /home/learner/work/logs \
        /home/learner/work/vara/ssh \
        /home/learner/work/vara/accounts \
        /home/learner/work/vara/network \
        /home/learner/work/vara/ssh-hardening \
        /home/learner/work/vara/aws \
        /srv/opscoach-api \
        /var/log/opscoach \
    && printf 'Welcome to Ops Coach Linux Foundations.\n' > /opt/opscoach/reference/welcome.txt \
    && printf 'alpha\nincident_code=BK-2049\nretry budget nominal\n' > /home/learner/work/search/region-a/archive/incident-archive.txt \
    && printf '2026-06-12T09:31:00Z retry budget exhausted for queue=images\n2026-06-12T09:32:00Z retry budget exhausted for queue=reports\n' > /home/learner/work/search/region-b/current/retry.log \
    && printf 'private template\n' > /home/learner/work/perms/template.txt \
    && printf 'port=8080\nmode=training\n' > /home/learner/work/files/app.conf.template \
    && printf '# Draft runbook\n' > /home/learner/work/files/draft-runbook.md \
    && printf '2026-06-12T10:00:00Z INFO worker boot\n2026-06-12T10:01:00Z ERROR queue stalled shard=blue\n2026-06-12T10:02:00Z ERROR retry budget exhausted shard=green\n2026-06-12T10:03:00Z INFO worker idle\n' > /var/log/opscoach/worker.log \
    && printf '%s\n' '# SSH authentication triage' '' 'FAILED_AUTH_COUNT=' 'TOP_SOURCE_IP=' '' 'SOURCE_LOG_LINES:' > /home/learner/work/vara/ssh/failed-ssh.txt \
    && printf '%s\n' '# Local account audit' '' 'LOCKED_ACCOUNT=' 'UNEXPECTED_SUDO_ACCOUNT=' '' 'EVIDENCE:' > /home/learner/work/vara/accounts/audit.txt \
    && printf '%s\n' '# Unexpected listener inventory' '' 'PORT=' 'PROCESS=' 'UNIT=' > /home/learner/work/vara/network/listeners.txt \
    && chown -R learner:learner /home/learner/work \
    && chmod -R u+rwX,go+rX /home/learner/work

RUN cat > /var/log/auth.log <<'AUTHLOG'
Jun 14 09:02:11 host sshd[1101]: Failed password for invalid user admin from 203.0.113.17 port 51244 ssh2
Jun 14 09:02:18 host sshd[1103]: Failed password for invalid user oracle from 198.51.100.22 port 51245 ssh2
Jun 14 09:02:29 host sshd[1105]: Failed password for root from 203.0.113.17 port 51246 ssh2
Jun 14 09:03:01 host sshd[1110]: Accepted publickey for learner from 198.51.100.10 port 51247 ssh2
Jun 14 09:03:22 host sshd[1112]: Failed password for invalid user test from 192.0.2.44 port 51248 ssh2
Jun 14 09:04:03 host sshd[1116]: Failed password for invalid user admin from 203.0.113.17 port 51249 ssh2
Jun 14 09:04:44 host sshd[1120]: Failed password for analyst from 198.51.100.22 port 51250 ssh2
AUTHLOG

RUN cat > /home/learner/work/vara/aws/s3.json <<'JSON1'
{
  "Bucket": "vara-research-drop",
  "Status": "Suspended",
  "PublicAccessBlockConfiguration": {
    "BlockPublicAcls": false,
    "IgnorePublicAcls": false,
    "BlockPublicPolicy": false,
    "RestrictPublicBuckets": false
  }
}
JSON1

RUN cat > /home/learner/work/vara/aws/launch-template.json <<'JSON2'
{
  "LaunchTemplateVersions": [
    {
      "LaunchTemplateName": "vara-research-linux",
      "VersionNumber": 3,
      "DefaultVersion": true,
      "LaunchTemplateData": {
        "NetworkInterfaces": [
          { "DeviceIndex": 0, "AssociatePublicIpAddress": true }
        ],
        "MetadataOptions": {
          "HttpTokens": "optional"
        },
        "BlockDeviceMappings": [
          { "DeviceName": "/dev/xvda", "Ebs": { "Encrypted": false } }
        ],
        "IamInstanceProfile": null
      }
    }
  ]
}
JSON2

RUN cat > /home/learner/work/vara/aws/cloudtrail.json <<'JSON3'
{
  "trailList": [
    {
      "Name": "management-events",
      "S3BucketName": "vara-cloudtrail-logs",
      "LogFileValidationEnabled": false
    }
  ]
}
JSON3

RUN cat > /home/learner/work/vara/aws/cloudwatch-alarms.json <<'JSON4'
{
  "MetricAlarms": [
    { "AlarmName": "ConsoleLoginFailures", "StateValue": "OK" }
  ]
}
JSON4

RUN cat > /home/learner/work/vara/aws/security-review.txt <<'REVIEW'
# AWS security review — fill in observed values from JSON captures

S3_VERSIONING=
S3_PUBLIC_ACCESS_BLOCK=
EC2_PUBLIC_IP=
IMDS_HTTP_TOKENS=
ROOT_VOLUME_ENCRYPTED=
INSTANCE_PROFILE=
CLOUDTRAIL_LOG_VALIDATION=
ROOT_ACCOUNT_ALARM=
REVIEW

RUN mkdir -p /etc/ssh/sshd_config.d \
    && cat > /etc/ssh/sshd_config.d/99-vara-lab.conf <<'SSHD'
PasswordAuthentication yes
PermitRootLogin yes
X11Forwarding yes
MaxAuthTries 6
SSHD

RUN chown -R learner:learner /home/learner/work/vara

RUN cat > /usr/local/bin/opscoach-api <<'PYAPI' \
    && chmod +x /usr/local/bin/opscoach-api
#!/usr/bin/env python3
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = b'opscoach-api ok\n'
            self.send_response(200)
            self.send_header('content-type', 'text/plain')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()
    def log_message(self, format, *args):
        return
HTTPServer(('127.0.0.1', 8080), Handler).serve_forever()
PYAPI

RUN cat > /usr/local/bin/opscoach-agent <<'AGENT' \
    && chmod +x /usr/local/bin/opscoach-agent
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /run/opscoach
printf 'agent-ready\n' > /run/opscoach/agent.ready
exec sleep infinity
AGENT

RUN cat > /usr/local/bin/opscoach-worker <<'WORKER' \
    && chmod +x /usr/local/bin/opscoach-worker
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /var/log/opscoach
printf 'worker service observed log file\n' >> /var/log/opscoach/worker.log
exec sleep infinity
WORKER

RUN cat > /usr/local/bin/vara-debug-listener <<'PYDEBUG' \
    && chmod +x /usr/local/bin/vara-debug-listener
#!/usr/bin/env python3
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'VARA debug listener\n'
        self.send_response(200)
        self.send_header('content-type', 'text/plain')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, format, *args):
        return
HTTPServer(('127.0.0.1', 9091), Handler).serve_forever()
PYDEBUG

RUN cat > /usr/local/bin/opscoach-seed-auth-journal <<'AUTHJOURNAL' \
    && chmod +x /usr/local/bin/opscoach-seed-auth-journal \
    && mkdir -p /etc/systemd/system/ssh.service.d \
    && cat > /etc/systemd/system/ssh.service.d/opscoach-auth-journal.conf <<'DROPIN'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /run/opscoach
stamp=/run/opscoach/auth-journal.seeded
if [ -e "$stamp" ]; then
    exit 0
fi
while IFS= read -r line; do
    logger -p authpriv.info -t sshd -- "$line"
done <<'AUTHLOG'
Failed password for invalid user admin from 203.0.113.17 port 51244 ssh2
Failed password for invalid user oracle from 198.51.100.22 port 51245 ssh2
Failed password for root from 203.0.113.17 port 51246 ssh2
Accepted publickey for learner from 198.51.100.10 port 51247 ssh2
Failed password for invalid user test from 192.0.2.44 port 51248 ssh2
Failed password for invalid user admin from 203.0.113.17 port 51249 ssh2
Failed password for analyst from 198.51.100.22 port 51250 ssh2
AUTHLOG
touch "$stamp"
AUTHJOURNAL
[Service]
ExecStartPost=/usr/local/bin/opscoach-seed-auth-journal
DROPIN

RUN cat > /etc/systemd/system/opscoach-api.service <<'UNIT' \
    && cat > /etc/systemd/system/opscoach-worker.service <<'UNIT2' \
    && cat > /etc/systemd/system/opscoach-agent.service <<'UNIT3' \
    && cat > /etc/systemd/system/vara-debug-listener.service <<'UNIT4' \
    && systemctl enable ssh.service opscoach-api.service opscoach-worker.service vara-debug-listener.service
[Unit]
Description=Ops Coach local API
After=network.target
[Service]
ExecStart=/usr/local/bin/opscoach-api
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
[Unit]
Description=Ops Coach worker
After=network.target
[Service]
ExecStart=/usr/local/bin/opscoach-worker
Restart=always
[Install]
WantedBy=multi-user.target
UNIT2
[Unit]
Description=Ops Coach agent
After=network.target
[Service]
ExecStart=/usr/local/bin/opscoach-agent
Restart=always
[Install]
WantedBy=multi-user.target
UNIT3
[Unit]
Description=VARA local debug listener
After=network.target
[Service]
ExecStart=/usr/local/bin/vara-debug-listener
Restart=always
[Install]
WantedBy=multi-user.target
UNIT4

EXPOSE 22 8080
STOPSIGNAL SIGRTMIN+3
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 CMD test -S /run/systemd/private || exit 1
CMD ["/lib/systemd/systemd"]

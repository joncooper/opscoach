FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

RUN rm -f /etc/dpkg/dpkg.cfg.d/excludes \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates coreutils curl findutils groff-base grep jq less man-db manpages nano openssh-server procps python3 sudo tree unzip vim-tiny \
    && ln -sf man.REAL /usr/bin/man \
    && arch="$(uname -m)" \
    && case "$arch" in x86_64) aws_arch=x86_64 ;; aarch64|arm64) aws_arch=aarch64 ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac \
    && curl -fsSLo /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && (mandb -q || true) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN find /etc/update-motd.d -type f -exec chmod -x {} + 2>/dev/null || true \
    && rm -f /etc/update-motd.d/60-unminimize /run/motd.dynamic /var/run/motd.dynamic /etc/legal \
    && sed -i '/^# sudo hint$/,$d' /etc/bash.bashrc \
    && printf 'Ops Coach AWS lab host. Start in ~/work/aws.\nRead README.md. Assigned resource variables are loaded from resource-map.env.\n' > /etc/motd

RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -s /bin/bash learner \
    && mkdir -p /run/sshd /opt/opscoach/private /home/learner/.ssh /home/learner/.aws /home/learner/work/aws \
    && ssh-keygen -A \
    && ssh-keygen -q -t ed25519 -N '' -C opscoach-aws-learner -f /opt/opscoach/private/learner_ed25519 \
    && cp /opt/opscoach/private/learner_ed25519.pub /home/learner/.ssh/authorized_keys \
    && chmod 700 /home/learner/.ssh \
    && chmod 600 /home/learner/.ssh/authorized_keys /opt/opscoach/private/learner_ed25519 \
    && ln -sf /opt/opscoach/aws-session/config /home/learner/.aws/config \
    && ln -sf /opt/opscoach/aws-session/credentials /home/learner/.aws/credentials \
    && chown -R learner:learner /home/learner/.ssh /home/learner/.aws /home/learner/work \
    && printf 'learner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/learner \
    && chmod 440 /etc/sudoers.d/learner

RUN cat > /etc/profile.d/opscoach-aws.sh <<'PROFILE' \
    && chmod 644 /etc/profile.d/opscoach-aws.sh \
    && printf '\nif [ -n "${BASH_VERSION:-}" ] && command -v aws_completer >/dev/null 2>&1; then\n  complete -o bashdefault -o default -C "$(command -v aws_completer)" aws 2>/dev/null || true\nfi\ncd ~/work/aws 2>/dev/null || cd ~/work\nif [ -r ./resource-map.env ]; then\n  source ./resource-map.env\nfi\nif [ -t 1 ] && [ -r README.md ]; then printf "\\nAWS lab workspace ready. Read README.md first; resource-map.env variables are already loaded.\\n\\n"; fi\n' >> /home/learner/.bashrc \
    && chown learner:learner /home/learner/.bashrc
if [ -d /opt/opscoach/aws-session ]; then
    export AWS_CONFIG_FILE=/opt/opscoach/aws-session/config
    export AWS_SHARED_CREDENTIALS_FILE=/opt/opscoach/aws-session/credentials
    export AWS_PROFILE=opscoach
    export AWS_DEFAULT_REGION="$(cat /opt/opscoach/aws-session/region 2>/dev/null || printf us-east-1)"
    export AWS_REGION="$AWS_DEFAULT_REGION"
    export AWS_PAGER=
fi
PROFILE

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]

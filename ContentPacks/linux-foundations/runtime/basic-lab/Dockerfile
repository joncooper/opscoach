FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN rm -f /etc/dpkg/dpkg.cfg.d/excludes \
    && apt-get update \
    && apt-get install -y --no-install-recommends bash openssh-server sudo findutils grep coreutils curl procps iproute2 ca-certificates less man-db manpages manpages-posix tree \
    && ln -sf man.REAL /usr/bin/man \
    && (mandb -q || true) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
RUN find /etc/update-motd.d -type f -exec chmod -x {} + 2>/dev/null || true \
    && rm -f /etc/update-motd.d/60-unminimize /run/motd.dynamic /var/run/motd.dynamic /etc/legal \
    && sed -i '/^# sudo hint$/,$d' /etc/bash.bashrc
RUN useradd -m -s /bin/bash learner \
    && echo 'learner:learner' | chpasswd \
    && usermod -aG sudo learner \
    && mkdir -p /run/sshd /opt/opscoach/private /home/learner/.ssh /home/learner/work/nested/a /home/learner/work/nested/b \
    && ssh-keygen -q -t ed25519 -N '' -C opscoach-basic -f /opt/opscoach/private/learner_ed25519 \
    && cp /opt/opscoach/private/learner_ed25519.pub /home/learner/.ssh/authorized_keys \
    && chmod 700 /home/learner/.ssh \
    && chmod 600 /home/learner/.ssh/authorized_keys /opt/opscoach/private/learner_ed25519 \
    && printf 'alpha\nneedle=harbor\n' > /home/learner/work/nested/b/observations.txt \
    && printf 'Ops Coach drill host. Start in ~/work.\n' > /etc/motd \
    && chown -R learner:learner /home/learner/.ssh /home/learner/work
RUN printf 'learner ALL=(ALL) ALL\n' > /etc/sudoers.d/learner && chmod 440 /etc/sudoers.d/learner
CMD ["/usr/sbin/sshd", "-D", "-e"]

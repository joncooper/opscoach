FROM ubuntu:24.04

ARG BEACON_SEED=demo
ENV BEACON_SEED=${BEACON_SEED}
ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN rm -f /etc/dpkg/dpkg.cfg.d/excludes \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        dbus \
        gzip \
        iproute2 \
        jq \
        less \
        logrotate \
        lsof \
        man-db \
        manpages \
        manpages-posix \
        nano \
        nginx \
        openssh-server \
        procps \
        python3 \
        sl \
        sqlite3 \
        sudo \
        systemd \
        systemd-sysv \
        tar \
        tree \
        vim-tiny \
    && ln -sf man.REAL /usr/bin/man \
    && (mandb -q || true) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN find /etc/update-motd.d -type f -exec chmod -x {} + 2>/dev/null || true \
    && rm -f /etc/update-motd.d/60-unminimize /run/motd.dynamic /var/run/motd.dynamic /etc/legal \
    && sed -i '/^# sudo hint$/,$d' /etc/bash.bashrc

# Keep systemd in containers relatively quiet, but do not remove the target
# wants that setup_game.py creates later.
RUN systemctl set-default multi-user.target || true \
    && rm -f /lib/systemd/system/multi-user.target.wants/getty.target || true

COPY game/ /opt/beaconkeeper/game/
RUN chmod +x /opt/beaconkeeper/game/*.py /opt/beaconkeeper/game/*.sh \
    && /usr/bin/python3 /opt/beaconkeeper/game/setup_game.py \
    && rm -rf /opt/beaconkeeper/game

EXPOSE 22 80
STOPSIGNAL SIGRTMIN+3
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=20 \
    CMD test -S /run/systemd/private || exit 1
CMD ["/lib/systemd/systemd"]

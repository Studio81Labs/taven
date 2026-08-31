# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
ARG SOURCE_DATE_EPOCH=1783347486

FROM ${UBUNTU_IMAGE} AS ubuntu-snapshot

ARG UBUNTU_SNAPSHOT=20260810T000000Z
RUN sed -i \
      -e "s|http://archive.ubuntu.com/ubuntu/|https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/|g" \
      -e "s|http://security.ubuntu.com/ubuntu/|https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/|g" \
      /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::https::Verify-Peer=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends \
      ca-certificates=20260601~24.04.1 \
      openssl=3.0.13-0ubuntu3.12 \
    && rm -rf /var/lib/apt/lists/*

FROM ubuntu-snapshot AS appimage-extract

ARG ORCA_APPIMAGE_URL=https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.4.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage
ARG ORCA_APPIMAGE_SHA256=d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd
ARG ORCA_APPIMAGE_SIZE=137759224
ARG ORCA_SQUASHFS_OFFSET=944632

ADD --checksum=sha256:d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd ${ORCA_APPIMAGE_URL} /tmp/orca.AppImage
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      liblzo2-2=2.10-2build4 \
      squashfs-tools=1:4.6.1-1build1 \
    && test "$(stat -c %s /tmp/orca.AppImage)" = "${ORCA_APPIMAGE_SIZE}" \
    && echo "${ORCA_APPIMAGE_SHA256}  /tmp/orca.AppImage" | sha256sum -c - \
    && unsquashfs -q -o "${ORCA_SQUASHFS_OFFSET}" -d /opt/orca /tmp/orca.AppImage \
    && rm -rf /opt/orca/resources/profiles /tmp/orca.AppImage /var/lib/apt/lists/*

FROM ubuntu-snapshot AS runtime-build

ARG SOURCE_DATE_EPOCH
COPY tools/slicing-fixtures/ubuntu-packages.lock /tmp/ubuntu-packages.expected
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libglu1-mesa=9.0.2-1.1build1 \
      libice6=2:1.0.10-1build3 \
      libglvnd0=1.7.0-1build1 \
      libopengl0=1.7.0-1build1 \
      libsm6=2:1.2.3-1build3 \
      libwebkit2gtk-4.1-0=2.52.3-0ubuntu0.24.04.1 \
    && install -d -o 10001 -g 10001 /work \
    && install -d /usr/share/doc/taven-orca \
    && dpkg-query -W -f='${Package}=${Version}\n' | LC_ALL=C sort > /usr/share/doc/taven-orca/ubuntu-packages.lock \
    && cmp /tmp/ubuntu-packages.expected /usr/share/doc/taven-orca/ubuntu-packages.lock \
    && rm /tmp/ubuntu-packages.expected \
    && rm -rf /var/lib/apt/lists/*

COPY --from=appimage-extract /opt/orca /opt/orca
COPY tools/slicing-fixtures/profiles/resolved /opt/taven/profiles
COPY tools/slicing-fixtures/licenses /usr/share/doc/taven-orca/licenses
COPY tools/slicing-fixtures/fixtures/LICENSE.txt /usr/share/doc/taven-orca/licenses/Taven-fixtures-LICENSE.txt
COPY tools/slicing-fixtures/THIRD_PARTY_NOTICES.md /usr/share/doc/taven-orca/THIRD_PARTY_NOTICES.md

# Package maintainer scripts create logs, caches, and wall-clock mtimes. Remove
# disposable state and normalize the assembled filesystem before flattening it
# into the final image so clean builds produce the same OCI manifest.
RUN rm -rf /var/cache/* /var/log/* /var/lib/apt/lists/* \
    && rm -f /var/lib/dpkg/status-old \
    && rm -f /var/lib/dbus/machine-id \
    && ln -s /etc/machine-id /var/lib/dbus/machine-id \
    && find / -xdev -mindepth 1 \
      \( -path /dev -o -path /proc -o -path /sys \
         -o -path /etc/hostname -o -path /etc/hosts -o -path /etc/resolv.conf \) \
      -prune -o -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + \
    && touch -h -d "@${SOURCE_DATE_EPOCH}" /

FROM scratch AS runtime

ARG SOURCE_DATE_EPOCH
COPY --from=runtime-build / /

ENV APPDIR=/opt/orca \
    HOME=/tmp/home \
    LC_ALL=C \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config \
    XDG_DATA_HOME=/tmp/data
WORKDIR /work

LABEL org.opencontainers.image.title="Taven OrcaSlicer runtime" \
      org.opencontainers.image.source="https://github.com/Studio81Labs/taven" \
      org.opencontainers.image.version="2.4.2" \
      org.opencontainers.image.revision="8500fcdccaa10b5099ac20d252af3a7c560046f1" \
      org.opencontainers.image.licenses="AGPL-3.0"

USER 10001:10001
ENTRYPOINT ["/opt/orca/AppRun"]
CMD ["--help"]

FROM runtime AS runner

COPY --chmod=0555 apps/slicer-worker/orca-runner.sh /usr/local/bin/taven-orca-runner

ENTRYPOINT ["/usr/local/bin/taven-orca-runner"]
CMD []

#!/usr/bin/env sh
# Install or upgrade DGX Spark Dashboard. Safe to run repeatedly.
set -eu

log() {
  printf '\n==> DGX Spark Dashboard: %s\n' "$*"
}

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

download_file() {
  url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
  else
    echo "curl or wget is required to download DGX Spark Dashboard." >&2
    exit 1
  fi
}

bootstrap_release() {
  REPOSITORY=${DGX_DASHBOARD_REPOSITORY:-singhangadin/DGX-Spark-Dashboard}
  REQUESTED_VERSION=${DGX_DASHBOARD_VERSION:-latest}
  INSTALL_DIR=${DGX_DASHBOARD_DIR:-"$HOME/DGX-Spark-Dashboard"}
  ASSET=dgx-spark-dashboard-deploy.tar.gz
  if [ "$REQUESTED_VERSION" = latest ]; then
    RELEASE_URL="https://github.com/${REPOSITORY}/releases/latest/download"
  else
    NORMALIZED_VERSION=${REQUESTED_VERSION#v}
    if ! printf '%s\n' "$NORMALIZED_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "DGX_DASHBOARD_VERSION must be latest or X.Y.Z (optionally prefixed with v)." >&2
      exit 1
    fi
    REQUESTED_VERSION=$NORMALIZED_VERSION
    RELEASE_URL="https://github.com/${REPOSITORY}/releases/download/v${NORMALIZED_VERSION}"
  fi
  BUNDLE_URL=${DGX_DASHBOARD_BUNDLE_URL:-"${RELEASE_URL}/${ASSET}"}
  CHECKSUM_URL=${DGX_DASHBOARD_CHECKSUM_URL:-"${BUNDLE_URL}.sha256"}
  TEMP_DIR=$(mktemp -d)

  cleanup() {
    rm -rf "$TEMP_DIR"
  }
  trap cleanup 0 HUP INT TERM

  log "Downloading DGX Spark Dashboard release ${REQUESTED_VERSION}"
  download_file "$BUNDLE_URL" "$TEMP_DIR/$ASSET"
  download_file "$CHECKSUM_URL" "$TEMP_DIR/$ASSET.sha256"

  log "Verifying the release checksum"
  EXPECTED=$(awk 'NR == 1 {print $1}' "$TEMP_DIR/$ASSET.sha256")
  if ! printf '%s\n' "$EXPECTED" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    echo "Release checksum file is invalid." >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$TEMP_DIR/$ASSET" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$TEMP_DIR/$ASSET" | awk '{print $1}')
  else
    echo "sha256sum or shasum is required to verify the release." >&2
    exit 1
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Release checksum verification failed." >&2
    exit 1
  fi

  mkdir "$TEMP_DIR/deploy"
  tar -xzf "$TEMP_DIR/$ASSET" -C "$TEMP_DIR/deploy"
  for file in install.sh docker-compose.yml docker-compose.gpu.yml docker-compose.cdi.yml .env.example VERSION .dgx-dashboard-release; do
    if [ ! -e "$TEMP_DIR/deploy/$file" ]; then
      echo "Release bundle is missing $file; aborting." >&2
      exit 1
    fi
  done

  if [ -e "$INSTALL_DIR" ] && [ ! -f "$INSTALL_DIR/.dgx-dashboard-release" ]; then
    echo "Refusing to overwrite a source checkout or unmanaged directory: $INSTALL_DIR" >&2
    echo "Choose another DGX_DASHBOARD_DIR or run that checkout's ./install.sh." >&2
    exit 1
  fi

  log "Installing deployment files to $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  mkdir -p "$INSTALL_DIR"
  for file in install.sh docker-compose.yml docker-compose.gpu.yml docker-compose.cdi.yml .env.example VERSION .dgx-dashboard-release; do
    cp "$TEMP_DIR/deploy/$file" "$INSTALL_DIR/$file"
  done
  chmod 0755 "$INSTALL_DIR/install.sh"
  cd "$INSTALL_DIR"
  DGX_DASHBOARD_BOOTSTRAPPED=1 DGX_DASHBOARD_RELEASE_VERSION="$REQUESTED_VERSION" sh ./install.sh
  exit $?
}

# A piped installer has no adjacent files. An installed release refreshes its
# own managed bundle before each run while preserving its configured image tag.
if [ "${DGX_DASHBOARD_BOOTSTRAPPED:-0}" != 1 ]; then
  if [ -f "$ROOT/.dgx-dashboard-release" ]; then
    if [ -z "${DGX_DASHBOARD_VERSION+x}" ] && [ -f "$ROOT/.env" ]; then
      DGX_DASHBOARD_VERSION=$(sed -n 's/^DASHBOARD_VERSION=//p' "$ROOT/.env" | tail -n 1)
      DGX_DASHBOARD_VERSION=${DGX_DASHBOARD_VERSION:-latest}
    fi
    DGX_DASHBOARD_DIR=${DGX_DASHBOARD_DIR:-$ROOT}
    export DGX_DASHBOARD_DIR DGX_DASHBOARD_VERSION
    bootstrap_release
  elif [ ! -f "$ROOT/docker-compose.yml" ]; then
    bootstrap_release
  fi
fi

if [ ! -f "$ROOT/docker-compose.yml" ] || [ ! -f "$ROOT/.env.example" ]; then
  echo "Deployment files are incomplete in $ROOT; aborting." >&2
  exit 1
fi

cd "$ROOT"
log "Starting setup from $ROOT"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Administrator access is required to install or start Docker." >&2
    exit 1
  fi
}

load_platform() {
  OS_ID=unknown
  OS_CODENAME=
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID=${ID:-unknown}
    OS_CODENAME=${VERSION_CODENAME:-}
  fi
}

install_docker_engine() {
  if [ "$(uname -s)" != "Linux" ]; then
    echo "Docker is not installed. Install and start Docker Desktop, then re-run this script." >&2
    exit 1
  fi

  load_platform
  echo "Docker was not found. Installing Docker Engine and Compose v2 for $OS_ID..."
  case "$OS_ID" in
    ubuntu|debian)
      if [ -z "$OS_CODENAME" ]; then
        echo "Could not determine the Linux release codename." >&2
        exit 1
      fi
      as_root apt-get update
      as_root apt-get install -y ca-certificates curl
      as_root install -m 0755 -d /etc/apt/keyrings
      as_root curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
      as_root chmod a+r /etc/apt/keyrings/docker.asc
      ARCH=$(dpkg --print-architecture)
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$ARCH" "$OS_ID" "$OS_CODENAME" | as_root tee /etc/apt/sources.list.d/docker.list >/dev/null
      as_root apt-get update
      as_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    fedora)
      as_root dnf -y install dnf-plugins-core
      as_root dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo
      as_root dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *)
      echo "Automatic Docker installation supports Ubuntu, Debian, and Fedora." >&2
      echo "Install Docker Engine and Docker Compose v2 for your platform, then re-run this script." >&2
      exit 1
      ;;
  esac
}

start_docker_service() {
  if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    as_root systemctl enable --now docker 2>/dev/null || as_root systemctl start docker
  fi
}

install_compose_plugin() {
  load_platform
  echo "Docker Compose v2 was not found. Installing the Compose plugin..."
  case "$OS_ID" in
    ubuntu|debian)
      as_root apt-get update
      if ! as_root apt-get install -y docker-compose-plugin; then
        as_root apt-get install -y docker-compose-v2
      fi
      ;;
    fedora)
      as_root dnf -y install docker-compose-plugin
      ;;
    *)
      echo "Docker Compose v2 is required. Install it for your platform, then re-run this script." >&2
      exit 1
      ;;
  esac
}

if ! command -v docker >/dev/null 2>&1; then
  install_docker_engine
  start_docker_service
fi

log "Checking Docker Engine and Compose v2"
if ! docker info >/dev/null 2>&1; then
  start_docker_service
fi

if ! docker compose version >/dev/null 2>&1; then
  install_compose_plugin
fi

if ! docker info >/dev/null 2>&1; then
  if as_root docker info >/dev/null 2>&1; then
    CURRENT_USER=${SUDO_USER:-${USER:-$(id -un)}}
    as_root usermod -aG docker "$CURRENT_USER"
    if [ "$(id -u)" -ne 0 ] && command -v sg >/dev/null 2>&1 && [ "${DGX_DASHBOARD_DOCKER_GROUP_REEXEC:-0}" != 1 ]; then
      echo "Added $CURRENT_USER to the docker group. Continuing setup with the new group..."
      exec sg docker -c "DGX_DASHBOARD_DOCKER_GROUP_REEXEC=1 sh \"$ROOT/install.sh\""
    fi
    echo "Added $CURRENT_USER to the docker group. Sign out and sign in again, then re-run ./install.sh." >&2
  else
    echo "Docker is installed but not running. Start Docker, then re-run this script." >&2
  fi
  exit 1
fi

log "Preparing persistent dashboard settings"
mkdir -p data
# The container is deliberately non-root. Settings contain no secrets and need
# to be writable by that unprivileged process across common rootless/rootful
# Docker installations.
chmod 0777 data
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env (dashboard port: 8787)."
fi

# A version passed to the clone-free bootstrap is an explicit install choice.
# Persist it so future `docker compose` commands use the same image tag.
if [ -n "${DGX_DASHBOARD_RELEASE_VERSION:-}" ]; then
  if grep -q '^DASHBOARD_VERSION=' .env; then
    sed -i.bak "s/^DASHBOARD_VERSION=.*/DASHBOARD_VERSION=$DGX_DASHBOARD_RELEASE_VERSION/" .env && rm -f .env.bak
  else
    printf '\nDASHBOARD_VERSION=%s\n' "$DGX_DASHBOARD_RELEASE_VERSION" >> .env
  fi
fi

if [ -S /var/run/docker.sock ]; then
  if command -v stat >/dev/null 2>&1; then
    DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null || true)
    if [ -n "${DOCKER_GID:-}" ]; then
      if grep -q '^DOCKER_GID=' .env; then
        sed -i.bak "s/^DOCKER_GID=.*/DOCKER_GID=$DOCKER_GID/" .env && rm -f .env.bak
      else
        printf '\nDOCKER_GID=%s\n' "$DOCKER_GID" >> .env
      fi
    fi
  fi
fi

# Compose arguments are assembled once so the same GPU integration is used for
# pulling/building and starting the service.
set -- -f docker-compose.yml
log "Selecting NVIDIA GPU integration"
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; then
  log "Using NVIDIA Docker runtime"
  set -- "$@" -f docker-compose.gpu.yml
elif [ -f /var/run/cdi/nvidia.yaml ] || [ -f /etc/cdi/nvidia.yaml ]; then
  log "Using NVIDIA CDI integration"
  set -- "$@" -f docker-compose.cdi.yml
else
  echo "Warning: NVIDIA Container Toolkit/CDI GPU access is unavailable. The dashboard will start, but GPU stats will be unavailable." >&2
fi

if [ "${DGX_DASHBOARD_USE_RELEASE_IMAGE:-0}" != 1 ] && [ -f Dockerfile ] && [ -d backend ] && [ -f docker-compose.dev.yml ]; then
  set -- "$@" -f docker-compose.dev.yml
  log "Building and starting the local source checkout"
  docker compose "$@" up --build -d --remove-orphans
else
  IMAGE_VERSION=$(sed -n 's/^DASHBOARD_VERSION=//p' .env | tail -n 1)
  IMAGE_VERSION=${IMAGE_VERSION:-latest}
  log "Pulling release image ${IMAGE_VERSION}"
  if ! docker compose "$@" pull dashboard; then
    echo "Could not pull the release image. Confirm the GitHub package is public and the version exists." >&2
    exit 1
  fi
  log "Starting the versioned release image"
  docker compose "$@" up --no-build -d --remove-orphans
fi
PORT=$(sed -n 's/^DASHBOARD_PORT=//p' .env | tail -n 1)
PORT=${PORT:-8787}
if command -v curl >/dev/null 2>&1; then
  log "Verifying http://localhost:$PORT/api/health"
  ATTEMPT=0
  until curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || [ "$ATTEMPT" -ge 15 ]; do
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
fi

if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "DGX Spark Dashboard is ready at http://localhost:$PORT"
else
  echo "DGX Spark Dashboard was started at http://localhost:$PORT (health check is still starting)."
fi
echo "Useful commands: docker compose logs -f; docker compose down"

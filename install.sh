#!/usr/bin/env sh
# Install or upgrade DGX Spark Dashboard. Safe to run repeatedly.
set -eu

log() {
  printf '\n==> DGX Spark Dashboard: %s\n' "$*"
}

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

bootstrap_from_github() {
  REPOSITORY=${DGX_DASHBOARD_REPOSITORY:-singhangadin/DGX-Spark-Dashboard}
  BRANCH=${DGX_DASHBOARD_BRANCH:-main}
  INSTALL_DIR=${DGX_DASHBOARD_DIR:-"$HOME/DGX-Spark-Dashboard"}
  ARCHIVE_URL=${DGX_DASHBOARD_ARCHIVE_URL:-"https://github.com/${REPOSITORY}/archive/refs/heads/${BRANCH}.tar.gz"}
  TEMP_DIR=$(mktemp -d)

  cleanup() {
    rm -rf "$TEMP_DIR"
  }
  trap cleanup 0 HUP INT TERM

  if [ -e "$INSTALL_DIR" ]; then
    echo "Refusing to overwrite existing directory: $INSTALL_DIR" >&2
    echo "Update it from that directory with: git pull && ./install.sh" >&2
    exit 1
  fi

  log "Downloading ${REPOSITORY}@${BRANCH}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$ARCHIVE_URL" -o "$TEMP_DIR/dashboard.tar.gz"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TEMP_DIR/dashboard.tar.gz" "$ARCHIVE_URL"
  else
    echo "curl or wget is required to download DGX Spark Dashboard." >&2
    exit 1
  fi

  log "Extracting the dashboard source"
  tar -xzf "$TEMP_DIR/dashboard.tar.gz" -C "$TEMP_DIR"
  SOURCE_DIR=$(find "$TEMP_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)
  if [ -z "${SOURCE_DIR:-}" ] || [ ! -f "$SOURCE_DIR/install.sh" ]; then
    echo "Downloaded archive does not contain install.sh; aborting." >&2
    exit 1
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  mv "$SOURCE_DIR" "$INSTALL_DIR"
  log "Source installed to $INSTALL_DIR"
  cd "$INSTALL_DIR"
  DGX_DASHBOARD_BOOTSTRAPPED=1 sh ./install.sh
  exit $?
}

# `curl .../install.sh | sh` has no project files beside the script. Download
# the selected branch first, then re-run this same script from the checkout.
if [ "${DGX_DASHBOARD_BOOTSTRAPPED:-0}" != 1 ] && { [ ! -f "$ROOT/docker-compose.yml" ] || [ ! -f "$ROOT/Dockerfile" ] || [ ! -d "$ROOT/backend" ]; }; then
  bootstrap_from_github
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

# Detect the NVIDIA runtime without downloading a CUDA image during installation.
log "Selecting NVIDIA GPU integration"
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; then
  log "Using NVIDIA Docker runtime"
  log "Building and starting the dashboard"
  docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d --remove-orphans
elif [ -f /var/run/cdi/nvidia.yaml ] || [ -f /etc/cdi/nvidia.yaml ]; then
  log "Using NVIDIA CDI integration"
  log "Building and starting the dashboard"
  docker compose -f docker-compose.yml -f docker-compose.cdi.yml up --build -d --remove-orphans
else
  echo "Warning: NVIDIA Container Toolkit/CDI GPU access is unavailable. The dashboard will start, but GPU stats will be unavailable." >&2
  log "Building and starting the dashboard without GPU access"
  docker compose up --build -d --remove-orphans
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

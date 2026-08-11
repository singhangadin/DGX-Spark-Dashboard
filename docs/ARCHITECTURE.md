# Architecture

The dashboard has one container, one process, and no background collector. The browser calls `GET /api/metrics` at the selected interval (2 seconds by default). This makes idle overhead close to zero and lets settings prevent collection altogether.

## Metric sources

| Category | Source | Notes |
| --- | --- | --- |
| CPU, RAM, uptime | Read-only host `/proc/stat`, `/proc/cpuinfo`, `/proc/meminfo`, and `/proc/loadavg` binds | The API returns `source: host`; it labels a container fallback only if a required host file is unavailable |
| Host network | Host network namespace plus read-only `/proc/net/dev` and `/proc/net/route` binds | Returns useful host interfaces, including physical, wireless and VPN interfaces, while omitting loopback and container-internal noise; marks the default uplink |
| Host disk I/O | Read-only host `/proc/diskstats` bind | Returns counters for every supported physical disk plus legacy aggregate totals; no filesystem scan |
| Host disk capacity | `statvfs` on the existing `data` bind mount | Capacity is a filesystem property that `/proc/diskstats` does not carry. `data` is already bound from the host, so this measures the host filesystem holding the installation without any additional host access. Free space excludes root-reserved blocks. `DASHBOARD_DISK_CAPACITY_PATH` overrides the measured path; a failed read degrades to `capacity: null` rather than failing disk collection |
| GPUs | NVML (`libnvidia-ml`) via `nvidia-ml-py` | Runs only when GPU is enabled; reads the same driver counters `nvidia-smi` exposes, without a subprocess or CSV parsing |
| Docker containers | Docker Engine Unix socket | Read-only application behavior; per-container stats are collected only if enabled |

## Settings and persistence

`PUT /api/settings` atomically persists selected metric categories, refresh interval, appearance, the GPU display mode and the top-card display mode (`graphs` or `text`) to `data/settings.json`. `data` is a host bind mount, so configuration survives a container rebuild or upgrade. The installer makes this non-secret directory writable to the unprivileged container process. The server checks the settings before calling every collector.

## Host integrations and security

The Docker socket is necessary for Docker statistics. A read-only socket bind does not itself restrict Docker API methods, so the app deliberately exposes only read endpoints and runs as an unprivileged user with `cap_drop: ALL`, `no-new-privileges`, and a read-only root filesystem. Separate read-only binds of the host hostname plus CPU, memory, load, network, and disk-counter files preserve host telemetry without exposing the host root. Host networking is used because Linux proc network counters are namespace-specific; without it, the dashboard would measure its container interface instead of the DGX Spark uplink. All capabilities remain dropped. Run it only on trusted networks. `DASHBOARD_BIND_ADDRESS` accepts a comma-separated list of literal IPs or interface names — a small stdlib launcher (`app.serve`) opens one listening socket per resolved address, always includes loopback, and skips targets that are unavailable at start. Prefer naming specific trusted interfaces such as `wg0,tailscale0` over `0.0.0.0` so the unauthenticated dashboard is not exposed on every NIC.

The GPU reservation in `docker-compose.gpu.yml` supports the NVIDIA Docker runtime. Current toolkit installations that use CDI are supported through `docker-compose.cdi.yml`. The installer selects the available integration; without either, the application remains healthy and reports GPU telemetry as unavailable.

## Build, release, and installation

Production Compose uses the versioned OCI artifact at
`ghcr.io/singhangadin/dgx-spark-dashboard`. It never needs the application
source or a host-side image build. A GitHub Release contains only the installer,
Compose definitions, `.env.example`, the release version, and a SHA-256
checksum. The curl/wget bootstrap verifies that checksum before replacing its
managed deployment files; it never overwrites `.env` or `data/`.

Source checkouts add `docker-compose.dev.yml`, which restores the Docker build
context and tags the result `dgx-spark-dashboard:local`. `install.sh` chooses
that overlay automatically when the Dockerfile and backend source exist. This
keeps development convenient without making public installations clone or
compile the project.

[`VERSION`](../VERSION) is the sole release-number source. The manually
dispatched Release workflow follows the same model as `singhangad.in`: a human
selects `MAJOR`, `MINOR`, or `PATCH`; CI promotes `develop` into `main`, computes
and commits the next SemVer value, generates notes from Conventional Commits,
tags `vX.Y.Z`, publishes the ARM64 image as `X.Y.Z` and `latest`, creates the
GitHub Release, then merges the release back into `develop`. An explicit
`release_as` value supports the one-time initial release.

## Metrics API compatibility

`GET /api/metrics` keeps the original top-level network and disk counters for
existing clients and additively exposes the running build `version` for the
dashboard header. Network payloads additionally expose `interfaces[]`, ordered
with the default route first, and disk payloads expose `disks[]`. Each source
contains its name and cumulative counters; the dependency-free frontend derives
rates between browser polls and keeps only 30 chart samples per visible source
in memory. Nothing is persisted or collected in the background.

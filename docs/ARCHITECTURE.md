# Architecture

The dashboard has one container, one process, and no background collector. The browser calls `GET /api/metrics` at the selected interval (2 seconds by default). This makes idle overhead close to zero and lets settings prevent collection altogether.

## Metric sources

| Category | Source | Notes |
| --- | --- | --- |
| CPU, RAM, uptime | `psutil` reading procfs/sysfs | Lightweight local reads; CPU/SoC temperature is shown when host sensors are exposed |
| Host network | Read-only host `/proc/net/dev` and `/proc/net/route` binds | Uses the host's default uplink; falls back to container counters only if those files are unavailable |
| Host disk I/O | Read-only host `/proc/diskstats` bind | Aggregates read/write counters for physical disks; no capacity or filesystem scan |
| GPUs | `nvidia-smi` from NVIDIA Container Toolkit | Runs only when GPU is enabled; 2-second command timeout |
| Docker containers | Docker Engine Unix socket | Read-only application behavior; per-container stats are collected only if enabled |

## Settings and persistence

`PUT /api/settings` atomically persists selected metric categories, refresh interval, appearance, the GPU display mode and the top-card display mode (`graphs` or `text`) to `data/settings.json`. `data` is a host bind mount, so configuration survives a container rebuild or upgrade. The installer makes this non-secret directory writable to the unprivileged container process. The server checks the settings before calling every collector.

## Host integrations and security

The Docker socket is necessary for Docker statistics. A read-only socket bind does not itself restrict Docker API methods, so the app deliberately exposes only read endpoints and runs as an unprivileged user with `cap_drop: ALL`, `no-new-privileges`, and a read-only root filesystem. Separate read-only binds of the host hostname, network-counter, and disk-counter files preserve host identity and telemetry without exposing the host root or sharing its network namespace. Run it only on trusted networks; bind the dashboard to `127.0.0.1` if it should not be reachable over the LAN.

The GPU reservation in `docker-compose.gpu.yml` supports the NVIDIA Docker runtime. Current toolkit installations that use CDI are supported through `docker-compose.cdi.yml`. The installer selects the available integration; without either, the application remains healthy and reports GPU telemetry as unavailable.

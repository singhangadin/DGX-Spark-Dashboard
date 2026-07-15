# DGX Spark Dashboard

> A lightweight, self-hosted dashboard for monitoring an NVIDIA DGX Spark.

DGX Spark Dashboard gives you a modern view of your system without a database,
cloud service, agent daemon, or frontend framework. It runs as a single Docker
Compose service and collects only the metric categories you enable.

> This is an independent community project. It is not affiliated with or
> endorsed by NVIDIA.

## Highlights

- CPU utilization, core/thread count, frequency, and exposed CPU/SoC temperature
- NVIDIA GPU utilization, temperature, power draw, VRAM where the driver exposes it, and GPU workload view
- RAM and swap usage, host-network receive/send rates, and physical-disk read/write throughput
- Docker container name, image, status, CPU, and memory usage
- Light, dark, and system appearance modes
- Switchable chart and text views for the summary cards and GPU details
- Mobile-friendly layout and settings that disable collection at the source
- One-command Docker Compose installation, with NVIDIA runtime and CDI support

## Quick start

### Requirements

- A Linux host. On Ubuntu, Debian, and Fedora, `install.sh` installs Docker Engine and Docker Compose v2 automatically when they are missing.
- On macOS or Windows, install and start Docker Desktop first.
- Optional but recommended for GPU metrics: NVIDIA Container Toolkit with a
  working host `nvidia-smi`

For the quickest setup on a new host, run:

```sh
curl -fsSL https://raw.githubusercontent.com/singhangadin/DGX-Spark-Dashboard/main/install.sh | sh
```

Open [http://localhost:8787](http://localhost:8787).

The installer is safe to run again after an update. It downloads the source,
creates `.env` on the first run, installs Docker and Compose when supported,
detects NVIDIA Docker runtime or CDI integration automatically, and starts the
appropriate Compose configuration. It finishes by checking the local health
endpoint. The same `install.sh` handles both direct installation and an
existing source checkout.

If Docker is installed for the first time, the script adds the invoking user to
the `docker` group and continues setup automatically when the system supports
`sg`. Otherwise, sign out and back in once, then run `./install.sh` again.

### Use `wget` or clone the source

Use `wget` instead of `curl` if you prefer:

```sh
wget -qO- https://raw.githubusercontent.com/singhangadin/DGX-Spark-Dashboard/main/install.sh | sh
```

To inspect or change the source before installing, clone the repository:

```sh
git clone https://github.com/singhangadin/DGX-Spark-Dashboard.git
cd DGX-Spark-Dashboard
./install.sh
```

The direct installer downloads the repository to `~/DGX-Spark-Dashboard` and
intentionally refuses to overwrite an existing directory. To use a different
location, set `DGX_DASHBOARD_DIR` for the shell receiving the script:

```sh
curl -fsSL https://raw.githubusercontent.com/singhangadin/DGX-Spark-Dashboard/main/install.sh | DGX_DASHBOARD_DIR=/opt/dgx-spark-dashboard sh
```

### Change the port

Edit `.env` and set a different port, then run the installer again:

```sh
DASHBOARD_PORT=8788
```

```sh
./install.sh
```

The dashboard will then be available at `http://localhost:8788`.

## What the dashboard collects

| Category | Data shown | How to disable it |
| --- | --- | --- |
| CPU | Utilization, cores, threads, frequency, CPU/SoC temperature when exposed | Settings → CPU |
| NVIDIA GPU | Utilization, temperature, power draw, memory where available | Settings → NVIDIA GPU |
| Memory | RAM and swap use | Settings → RAM & swap |
| Network | Default-uplink traffic and current receive/send rate | Settings → Host network totals |
| Disk I/O | Physical-disk read/write throughput | Settings → Host disk I/O |
| Docker | Containers, state, image, CPU, and memory use | Settings → Docker containers |

Disabled categories are not collected. For example, disabling NVIDIA GPU skips
the `nvidia-smi` call and disabling Docker skips all Docker socket calls.

## Dashboard settings

Open **Settings** in the header to choose:

- Refresh interval from 1 to 60 seconds
- Which metric categories to collect
- Whether the top CPU, memory, GPU, network, and disk-I/O cards use live sparklines or text-only values
- Whether GPU details use utilization bars or compact text values

Use the header appearance button to cycle through **Auto**, **Light**, and
**Dark**. All preferences persist in `data/settings.json` across container
rebuilds and upgrades.

## Operations

Run these commands from the repository directory:

```sh
docker compose ps          # service status
docker compose logs -f     # follow logs
docker compose down        # stop the dashboard; settings remain in ./data
./install.sh               # build and start after an update
```

To update the dashboard:

```sh
git pull
./install.sh
```

To remove it:

```sh
docker compose down --rmi local
```

Remove the project directory and `data/` as well only if you also want to
discard saved dashboard preferences.

## GPU telemetry notes

The dashboard uses NVIDIA's tooling available inside the NVIDIA Container
Toolkit environment. If the GPU panel says telemetry is unavailable:

1. Confirm the host sees the GPU: `nvidia-smi`
2. Install or repair the NVIDIA Container Toolkit.
3. Run `./install.sh` again so it can select NVIDIA runtime or CDI support.

Some driver fields are hardware-dependent. A dash beside **LIMIT** means
`nvidia-smi` did not expose a live configurable GPU power-limit value. It does
not mean that power monitoring has failed; **POWER** can still report current
draw. The DGX Spark's published GB10 TDP is a hardware specification, not
necessarily a live driver power-limit reading.

## Security and privacy

The dashboard does not send telemetry to a cloud service. It does require
read-only access to the Docker socket for container statistics and a read-only
host mount for host identity and filesystem context. Although the application
does not expose Docker control actions, the Docker socket is sensitive—run the
dashboard on a trusted network.

For local-only access, change the Compose port mapping in `docker-compose.yml`
from:

```yaml
- "${DASHBOARD_PORT:-8787}:8787"
```

to:

```yaml
- "127.0.0.1:${DASHBOARD_PORT:-8787}:8787"
```

Then run `./install.sh` again.

## DGX Spark reference hardware

The dashboard includes a compact reference card at the bottom of the page. It
summarizes NVIDIA's published DGX Spark platform: GB10 Grace Blackwell, a
20-core Arm CPU, 128 GB unified LPDDR5x memory, up to 1 PFLOP FP4 AI compute,
and ConnectX networking. See the [official NVIDIA DGX Spark
specifications](https://www.nvidia.com/en-us/products/workstations/dgx-spark/)
for the complete and current hardware reference.

## Development and contribution

This project intentionally uses FastAPI plus dependency-free HTML, CSS, and
JavaScript. Before contributing, read [AGENTS.md](AGENTS.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The key checks are:

```sh
python3 -m py_compile backend/app/main.py
docker compose config
docker compose build
```

## License

Copyright 2026 Angad Singh. Licensed under the [Apache License 2.0](LICENSE).

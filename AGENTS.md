# DGX Spark Dashboard — agent guide

This repository builds a **low-overhead, self-hosted host-monitoring dashboard** for NVIDIA DGX Spark systems. It is intentionally a small Docker Compose application: a FastAPI collector and a static single-page UI are served from one container.

## Start here

1. Read `README.md` for the product contract and install flow.
2. Read `docs/ARCHITECTURE.md` before changing telemetry, API shapes, or privileges.
3. Run the checks in the README after making changes.

`CLAUDE.md` intentionally points here so Claude Code and agents that discover
that convention receive the same instructions.

## Repository map

```
install.sh                 Sole installer; bootstraps from GitHub or a checkout, then Docker/Compose on supported Linux hosts
docker-compose.yml         Production deployment and minimum privileges
backend/app/main.py        API, host metric collection, persisted settings
frontend/                  Dependency-free dashboard UI
data/                      Runtime settings volume (gitignored)
docs/ARCHITECTURE.md       Metric sources, performance and security decisions
```

## Non-negotiable constraints

- Keep the dashboard lightweight. Do not add a database, broker, build step, or polling library without a strong measurable reason.
- Collection is demand-driven: **never read a metric category that is disabled** in settings.
- Docker access is read-only in application behavior. Never add container lifecycle, shell, exec, image, or write endpoints.
- The image must continue to run with a read-only root filesystem and as a non-root user.
- Preserve the `./data` bind mount: it persists settings across image upgrades.
- The read-only hostname, `/proc/net`, and `/proc/diskstats` binds keep host identity, uplink, and disk-I/O counters accurate. Do not widen them; document any additional host mount.
- Treat the Docker socket and GPU access as privileged host integrations; document any new host mount or capability.

## Development conventions

- Python: standard library first; use explicit response models/typed shapes where practical.
- Frontend: vanilla HTML/CSS/JS. Avoid a framework and any CDN dependencies.
- Keep `/api/metrics` backward compatible. Additive fields are safe; rename/remove only with a migration note in the README.
- Use `nvidia-smi` only when GPU metrics are enabled. Its failure must degrade to `available: false`, never fail the whole request.
- Container statistics are expensive because Docker returns cumulative counters. Query them only when the `docker` category is enabled.

## Validation

Run these before handing work off:

```sh
python3 -m py_compile backend/app/main.py
docker compose config
docker compose build
```

For a live host with the NVIDIA Container Toolkit:

```sh
./install.sh
curl http://localhost:8787/api/health
curl http://localhost:8787/api/metrics
```

Do not commit `data/settings.json`, `.env`, generated caches, or credentials.

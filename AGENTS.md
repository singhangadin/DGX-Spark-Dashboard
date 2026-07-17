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
install.sh                 Sole installer; bootstraps a verified release bundle or builds a source checkout
docker-compose.yml         Production image deployment and minimum privileges
docker-compose.dev.yml     Local source-build overlay; never shipped to release installs
VERSION                    Sole semantic release version source
.github/workflows/release.yml  develop→main SemVer/image/release automation
scripts/release/           Dependency-free version bump and release-note tools
backend/app/main.py        API, host metric collection, persisted settings
backend/app/serve.py       Multi-address/interface bind launcher; the image entrypoint
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
- The read-only hostname, CPU/memory/load `/proc` files, `/proc/net`, and `/proc/diskstats` binds keep host telemetry accurate. Do not widen them; document any additional host mount.
- Preserve host networking unless network telemetry is replaced with another verified host-level source; container-network `/proc/net` values are inaccurate for this product.
- Treat the Docker socket and GPU access as privileged host integrations; document any new host mount or capability.
- Production installation must remain clone-free and pull a released image. Keep source builds isolated to `docker-compose.dev.yml`.

## Development conventions

- Python: standard library first; use explicit response models/typed shapes where practical.
- Frontend: vanilla HTML/CSS/JS. Avoid a framework and any CDN dependencies.
- Keep `/api/metrics` backward compatible. Additive fields are safe; rename/remove only with a migration note in the README.
- Query the GPU via NVML (`nvidia-ml-py`) only when GPU metrics are enabled. Any NVML failure (including a missing driver or `NOT_SUPPORTED` fields) must degrade to `available: false` or a `None` field, never fail the whole request.
- Container statistics are expensive because Docker returns cumulative counters. Query them only when the `docker` category is enabled.

## Validation

Run these before handing work off:

```sh
python3 -m py_compile backend/app/main.py backend/app/serve.py
docker compose config
docker compose -f docker-compose.yml -f docker-compose.dev.yml build
```

For a live host with the NVIDIA Container Toolkit:

```sh
./install.sh
curl http://localhost:8787/api/health
curl http://localhost:8787/api/metrics
```

Do not commit `data/settings.json`, `.env`, generated caches, or credentials.

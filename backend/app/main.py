"""Low-overhead, on-demand host metric collector for DGX Spark Dashboard."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import psutil
import pynvml
from docker import DockerClient
from docker.errors import DockerException
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from requests.exceptions import RequestException

# main.py lives at /app/app/main.py in the image, so its direct parent is the
# application root that also contains the static frontend directory.
APP_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = APP_DIR / "frontend"
SETTINGS_PATH = Path(os.getenv("DASHBOARD_SETTINGS_PATH", "/app/data/settings.json"))
APP_VERSION = os.getenv("DASHBOARD_APP_VERSION", "dev")
HOSTNAME_PATH = Path(os.getenv("DASHBOARD_HOSTNAME_PATH", "/host-hostname"))
HOST_PROC_STAT_PATH = Path(os.getenv("DASHBOARD_HOST_PROC_STAT_PATH", "/host-proc-stat"))
HOST_PROC_CPUINFO_PATH = Path(os.getenv("DASHBOARD_HOST_PROC_CPUINFO_PATH", "/host-proc-cpuinfo"))
HOST_MEMINFO_PATH = Path(os.getenv("DASHBOARD_HOST_MEMINFO_PATH", "/host-meminfo"))
HOST_LOADAVG_PATH = Path(os.getenv("DASHBOARD_HOST_LOADAVG_PATH", "/host-loadavg"))
HOST_NETWORK_DEV_PATH = Path(os.getenv("DASHBOARD_HOST_NETWORK_DEV_PATH", "/host-network-dev"))
HOST_NETWORK_ROUTE_PATH = Path(os.getenv("DASHBOARD_HOST_NETWORK_ROUTE_PATH", "/host-network-route"))
HOST_DISKSTATS_PATH = Path(os.getenv("DASHBOARD_HOST_DISKSTATS_PATH", "/host-diskstats"))
# Capacity is a filesystem property, so it cannot come from the diskstats bind.
# `data` is already a host bind mount, which makes it a window onto the host
# filesystem the installation lives on — no additional host access required.
# Override only to measure a filesystem other than the one holding the install.
DISK_CAPACITY_PATH = Path(os.getenv("DASHBOARD_DISK_CAPACITY_PATH", "/app/data"))
SETTINGS_LOCK = threading.Lock()
CPU_SAMPLE_LOCK = threading.Lock()
PREVIOUS_HOST_CPU_SAMPLE: tuple[int, int] | None = None
DEFAULT_SETTINGS = {
    "refresh_seconds": 2,
    "theme": "auto",
    "display_mode": "graphs",
    "summary_display_mode": "graphs",
    "metrics": {
        "cpu": True,
        "gpu": True,
        "memory": True,
        "network": True,
        "disk": True,
        "docker": True,
    },
}


class Settings(BaseModel):
    refresh_seconds: int = Field(default=2, ge=1, le=60)
    theme: str = Field(default="auto", pattern="^(auto|light|dark)$")
    display_mode: str = Field(default="graphs", pattern="^(graphs|text)$")
    summary_display_mode: str = Field(default="graphs", pattern="^(graphs|text)$")
    metrics: dict[str, bool] = DEFAULT_SETTINGS["metrics"].copy()


def _merged_settings(candidate: dict[str, Any] | None) -> dict[str, Any]:
    candidate = candidate or {}
    categories = candidate.get("metrics", {})
    return {
        "refresh_seconds": min(60, max(1, int(candidate.get("refresh_seconds", 2)))),
        "theme": candidate.get("theme") if candidate.get("theme") in {"auto", "light", "dark"} else "auto",
        "display_mode": candidate.get("display_mode") if candidate.get("display_mode") in {"graphs", "text"} else "graphs",
        "summary_display_mode": candidate.get("summary_display_mode") if candidate.get("summary_display_mode") in {"graphs", "text"} else "graphs",
        "metrics": {key: bool(categories.get(key, value)) for key, value in DEFAULT_SETTINGS["metrics"].items()},
    }


def load_settings() -> dict[str, Any]:
    with SETTINGS_LOCK:
        try:
            return _merged_settings(json.loads(SETTINGS_PATH.read_text()))
        except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
            return _merged_settings(None)


def save_settings(settings: Settings) -> dict[str, Any]:
    payload = _merged_settings(settings.model_dump())
    with SETTINGS_LOCK:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS_PATH.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, indent=2) + "\n")
        temporary.replace(SETTINGS_PATH)
    return payload


def bytes_used(total: float, used: float) -> dict[str, float]:
    return {"total": total, "used": used, "percent": round((used / total * 100) if total else 0, 1)}


def get_host_name() -> str:
    try:
        host_name = HOSTNAME_PATH.read_text().strip()
        if host_name:
            return host_name
    except OSError:
        pass
    return os.uname().nodename


def _read_host_proc(path: Path) -> str | None:
    try:
        return path.read_text()
    except OSError:
        return None


def _host_cpu_sample() -> tuple[int, int] | None:
    stat = _read_host_proc(HOST_PROC_STAT_PATH)
    if stat is None:
        return None
    for line in stat.splitlines():
        fields = line.split()
        if not fields or fields[0] != "cpu" or len(fields) < 5:
            continue
        try:
            values = [int(value) for value in fields[1:]]
        except ValueError:
            return None
        total = sum(values)
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        return total, idle
    return None


def _cpu_frequency_mhz() -> float | None:
    """Best-effort current CPU frequency.

    x86 exposes `cpu MHz` per core in /proc/cpuinfo, but ARM SoCs like the DGX
    Spark's Grace CPU omit it. There psutil reads the host-visible sysfs cpufreq
    node instead; fall back to it before giving up.
    """
    try:
        frequency = psutil.cpu_freq()
    except (OSError, NotImplementedError, AttributeError):
        return None
    return round(frequency.current) if frequency and frequency.current else None


def _host_cpu_info() -> tuple[int, int, float | None]:
    info = _read_host_proc(HOST_PROC_CPUINFO_PATH)
    if info is None:
        threads = psutil.cpu_count() or 1
        return threads, psutil.cpu_count(logical=False) or threads, _cpu_frequency_mhz()
    blocks = [block for block in info.split("\n\n") if block.strip()]
    threads = len(blocks) or (psutil.cpu_count() or 1)
    physical_cores: set[tuple[str, str]] = set()
    frequencies: list[float] = []
    for block in blocks:
        fields = {}
        for line in block.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                fields[key.strip().lower()] = value.strip()
        physical_id, core_id = fields.get("physical id"), fields.get("core id")
        if physical_id is not None and core_id is not None:
            physical_cores.add((physical_id, core_id))
        try:
            frequencies.append(float(fields.get("cpu mhz", "")))
        except ValueError:
            pass
    # ARM cpuinfo lacks physical/core ids; Grace has no SMT, so one thread per
    # core makes threads an accurate physical-core count there. Frequency also
    # falls back to sysfs via psutil when cpuinfo omits `cpu MHz`.
    cores = len(physical_cores) or threads
    frequency_mhz = round(sum(frequencies) / len(frequencies)) if frequencies else _cpu_frequency_mhz()
    return threads, cores, frequency_mhz


def _host_load_average() -> list[float]:
    loadavg = _read_host_proc(HOST_LOADAVG_PATH)
    if loadavg:
        try:
            return [round(float(value), 2) for value in loadavg.split()[:3]]
        except ValueError:
            pass
    return [round(value, 2) for value in os.getloadavg()] if hasattr(os, "getloadavg") else []


def get_cpu() -> dict[str, Any]:
    global PREVIOUS_HOST_CPU_SAMPLE
    sample = _host_cpu_sample()
    if sample is not None:
        with CPU_SAMPLE_LOCK:
            previous = PREVIOUS_HOST_CPU_SAMPLE
            PREVIOUS_HOST_CPU_SAMPLE = sample
        total_delta = sample[0] - previous[0] if previous else 0
        idle_delta = sample[1] - previous[1] if previous else 0
        percent = round(max(0, min(100, (total_delta - idle_delta) / total_delta * 100)) if total_delta else 0, 1)
        source = "host"
    else:
        percent = psutil.cpu_percent(interval=None)
        source = "container"
    threads, cores, frequency_mhz = _host_cpu_info()
    return {
        "percent": percent,
        "cores": cores,
        "threads": threads,
        "frequency_mhz": frequency_mhz,
        "load_average": _host_load_average(),
        "temperature": get_cpu_temperature(get_temperatures()),
        "source": source,
    }


def _host_memory_info() -> dict[str, int] | None:
    meminfo = _read_host_proc(HOST_MEMINFO_PATH)
    if meminfo is None:
        return None
    values: dict[str, int] = {}
    for line in meminfo.splitlines():
        key, separator, value = line.partition(":")
        if not separator:
            continue
        try:
            values[key] = int(value.split()[0]) * 1024
        except (IndexError, ValueError):
            continue
    return values if "MemTotal" in values else None


def get_memory() -> dict[str, Any]:
    values = _host_memory_info()
    if values is not None:
        total = values["MemTotal"]
        available = values.get("MemAvailable")
        if available is None:
            available = sum(values.get(key, 0) for key in ("MemFree", "Buffers", "Cached", "SReclaimable")) - values.get("Shmem", 0)
        return {
            "ram": bytes_used(total, max(0, total - available)),
            "swap": bytes_used(values.get("SwapTotal", 0), max(0, values.get("SwapTotal", 0) - values.get("SwapFree", 0))),
            "source": "host",
        }
    memory, swap = psutil.virtual_memory(), psutil.swap_memory()
    return {
        "ram": bytes_used(memory.total, memory.used),
        "swap": bytes_used(swap.total, swap.used),
        "source": "container",
    }


def get_uptime_seconds() -> int:
    stat = _read_host_proc(HOST_PROC_STAT_PATH)
    if stat:
        for line in stat.splitlines():
            fields = line.split()
            if len(fields) == 2 and fields[0] == "btime":
                try:
                    return round(time.time() - int(fields[1]))
                except ValueError:
                    break
    return round(time.time() - psutil.boot_time())


def _default_host_interface() -> str | None:
    """Read the host's IPv4 default-route interface without needing host networking."""
    try:
        routes = HOST_NETWORK_ROUTE_PATH.read_text().splitlines()[1:]
    except OSError:
        return None
    for route in routes:
        fields = route.split()
        if len(fields) < 4 or fields[1] != "00000000":
            continue
        try:
            if int(fields[3], 16) & 0x2:  # Route is up.
                return fields[0]
        except ValueError:
            continue
    return None


def _host_network_counters() -> dict[str, tuple[int, int]]:
    try:
        lines = HOST_NETWORK_DEV_PATH.read_text().splitlines()[2:]
    except OSError:
        return {}
    counters: dict[str, tuple[int, int]] = {}
    for line in lines:
        if ":" not in line:
            continue
        interface, raw_values = line.split(":", 1)
        values = raw_values.split()
        if len(values) < 9:
            continue
        try:
            counters[interface.strip()] = (int(values[0]), int(values[8]))
        except ValueError:
            continue
    return counters


def get_network() -> dict[str, Any]:
    """Return per-interface host counters plus backward-compatible uplink totals."""
    counters = _host_network_counters()
    default_interface = _default_host_interface()
    virtual_prefixes = ("lo", "docker", "veth", "br-", "virbr", "cni", "flannel", "kube", "tun", "tap")
    physical = {
        name: values
        for name, values in counters.items()
        if not name.startswith(virtual_prefixes) or name == default_interface
    }
    interfaces = [
        {
            "name": name,
            "bytes_received": physical[name][0],
            "bytes_sent": physical[name][1],
            "default": name == default_interface,
        }
        for name in sorted(physical, key=lambda name: (name != default_interface, name))
    ]

    if default_interface and default_interface in counters:
        received, sent = counters[default_interface]
        return {
            "bytes_sent": sent,
            "bytes_received": received,
            "source": "host",
            "interface": default_interface,
            "interfaces": interfaces,
        }

    if physical:
        received = sum(values[0] for values in physical.values())
        sent = sum(values[1] for values in physical.values())
        return {
            "bytes_sent": sent,
            "bytes_received": received,
            "source": "host",
            "interface": ", ".join(sorted(physical)),
            "interfaces": interfaces,
        }

    counters = psutil.net_io_counters()
    return {
        "bytes_sent": counters.bytes_sent,
        "bytes_received": counters.bytes_recv,
        "source": "container",
        "interface": None,
        "interfaces": [
            {
                "name": "Container aggregate",
                "bytes_received": counters.bytes_recv,
                "bytes_sent": counters.bytes_sent,
                "default": True,
            }
        ],
    }


def get_disk_capacity() -> dict[str, Any] | None:
    """Report host filesystem capacity for the volume holding the installation.

    Returns None when the path cannot be stat'ed, so a capacity failure degrades
    to a card without a capacity figure rather than failing disk collection.
    """
    try:
        stats = os.statvfs(DISK_CAPACITY_PATH)
    except OSError:
        return None
    block = stats.f_frsize or stats.f_bsize
    total = stats.f_blocks * block
    if total <= 0:
        return None
    # f_bavail excludes root-reserved blocks, so it is what an ordinary process
    # can actually write — the honest "free" figure. Used is derived from
    # f_bfree instead, so reserved blocks count as used and the parts still sum
    # to the total.
    free = stats.f_bavail * block
    used = total - stats.f_bfree * block
    return {
        "path": str(DISK_CAPACITY_PATH),
        "total_bytes": total,
        "free_bytes": free,
        "used_bytes": used,
        "percent": round(used / total * 100, 1),
    }


def get_disk_io() -> dict[str, Any]:
    """Read per-device and aggregate physical-disk counters from host diskstats."""
    try:
        lines = HOST_DISKSTATS_PATH.read_text().splitlines()
    except OSError:
        return {"available": False, "reason": "host disk counters are unavailable"}

    physical_device = re.compile(r"(?:nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+)$")
    disks: list[dict[str, Any]] = []
    read_sectors = write_sectors = 0
    for line in lines:
        fields = line.split()
        if len(fields) < 10 or not physical_device.fullmatch(fields[2]):
            continue
        try:
            device_read_sectors = int(fields[5])
            device_write_sectors = int(fields[9])
        except ValueError:
            continue
        read_sectors += device_read_sectors
        write_sectors += device_write_sectors
        disks.append(
            {
                "name": fields[2],
                "read_bytes": device_read_sectors * 512,
                "write_bytes": device_write_sectors * 512,
            }
        )
    if not disks:
        return {"available": False, "reason": "no supported physical disks found"}
    disks.sort(key=lambda disk: disk["name"])
    return {
        "available": True,
        "read_bytes": read_sectors * 512,
        "write_bytes": write_sectors * 512,
        "source": "host",
        "devices": ", ".join(disk["name"] for disk in disks),
        "disks": disks,
        "capacity": get_disk_capacity(),
    }


def get_temperatures() -> list[dict[str, Any]]:
    readings = []
    try:
        sources = psutil.sensors_temperatures(fahrenheit=False)
    except (AttributeError, OSError):
        sources = {}
    for source, entries in sources.items():
        for index, entry in enumerate(entries, start=1):
            label = entry.label or (f"ACPI thermal zone {index}" if source == "acpitz" else f"{source} {index}")
            readings.append({"source": source, "label": label, "current": entry.current, "high": entry.high, "critical": entry.critical})
    return readings


def get_cpu_temperature(readings: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return a CPU temperature, falling back to ACPI zones on unified SoCs."""
    cpu_sources = ("coretemp", "k10temp", "cpu", "soc", "zenpower")
    direct = [item["current"] for item in readings if any(key in item["source"].lower() for key in cpu_sources)]
    if direct:
        return {"current": round(sum(direct) / len(direct), 1), "label": "CPU temperature"}
    acpi = [item["current"] for item in readings if item["source"] == "acpitz"]
    if acpi:
        return {"current": round(sum(acpi) / len(acpi), 1), "label": "CPU / SoC temperature (ACPI)"}
    return None


_NVML_LOCK = threading.Lock()
_nvml_ready = False


def _ensure_nvml() -> bool:
    """Initialise NVML once and keep the session for the process lifetime.

    An nvmlInit/nvmlShutdown cycle costs ~9 ms, which dwarfs the ~1.4 ms the
    queries themselves take, so tearing the session down every poll was most of
    the cost. Keeping it open does not cost extra memory: the driver library's
    pages stay resident after the first load either way.
    """
    global _nvml_ready
    if _nvml_ready:
        return True
    with _NVML_LOCK:
        if _nvml_ready:  # another thread initialised while we waited
            return True
        try:
            pynvml.nvmlInit()
        except pynvml.NVMLError:
            return False
        _nvml_ready = True
        return True


def _reset_nvml() -> None:
    """Drop the cached session so the next poll re-initialises it."""
    global _nvml_ready
    with _NVML_LOCK:
        _nvml_ready = False


def get_gpu() -> dict[str, Any]:
    # NVML is the library nvidia-smi itself wraps, so this reads the same driver
    # counters without forking a process or parsing CSV on every poll.
    if not _ensure_nvml():
        return {"available": False, "reason": "NVML (NVIDIA driver) is unavailable in this container"}
    try:
        def read(func: Any, *args: Any) -> Any:
            # Many fields are hardware-dependent. On the GB10's unified memory,
            # GPU memory info and the power limit report NOT_SUPPORTED, matching
            # the dashes nvidia-smi prints; treat any NVML error as "field absent".
            try:
                return func(*args)
            except pynvml.NVMLError:
                return None

        gpus = []
        for index in range(pynvml.nvmlDeviceGetCount()):
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            name = read(pynvml.nvmlDeviceGetName, handle)
            if isinstance(name, bytes):
                name = name.decode()
            util = read(pynvml.nvmlDeviceGetUtilizationRates, handle)
            memory = read(pynvml.nvmlDeviceGetMemoryInfo, handle)
            temperature = read(pynvml.nvmlDeviceGetTemperature, handle, pynvml.NVML_TEMPERATURE_GPU)
            power = read(pynvml.nvmlDeviceGetPowerUsage, handle)
            power_limit = read(pynvml.nvmlDeviceGetPowerManagementLimit, handle)
            gpus.append({
                "index": index,
                "name": name,
                "utilization": float(util.gpu) if util else None,
                "memory_utilization": float(util.memory) if util else None,
                "memory_used_mib": round(memory.used / 1048576, 1) if memory else None,
                "memory_total_mib": round(memory.total / 1048576, 1) if memory else None,
                "temperature_c": float(temperature) if temperature is not None else None,
                "power_w": round(power / 1000, 2) if power is not None else None,
                "power_limit_w": round(power_limit / 1000, 2) if power_limit is not None else None,
            })
        return {"available": bool(gpus), "gpus": gpus}
    except pynvml.NVMLError:
        # Device enumeration failed, so the cached session is stale (a driver
        # reload, for example). Drop it and report unavailable for this poll;
        # the next one re-initialises. Per-field errors are handled in read().
        _reset_nvml()
        return {"available": False, "reason": "unable to query NVIDIA GPU"}


def _container_stats(container: Any) -> dict[str, Any]:
    """Sample one running container's live CPU/memory usage.

    A single `stats(stream=False)` read takes ~1-2s because the daemon samples the
    container, so callers run these concurrently — collecting them serially makes
    the whole /api/metrics response grow with the number of running containers.
    """
    try:
        stats = container.stats(stream=False)
    except (DockerException, RequestException):
        return {"stats_available": False}
    cpu = stats.get("cpu_stats", {})
    previous = stats.get("precpu_stats", {})
    cpu_delta = cpu.get("cpu_usage", {}).get("total_usage", 0) - previous.get("cpu_usage", {}).get("total_usage", 0)
    system_delta = cpu.get("system_cpu_usage", 0) - previous.get("system_cpu_usage", 0)
    online_cpus = cpu.get("online_cpus") or len(cpu.get("cpu_usage", {}).get("percpu_usage", [])) or 1
    memory = stats.get("memory_stats", {})
    return {
        "cpu_percent": round((cpu_delta / system_delta * online_cpus * 100) if system_delta else 0, 1),
        "memory_used": memory.get("usage", 0),
        "memory_limit": memory.get("limit", 0),
    }


def get_docker() -> dict[str, Any]:
    client: DockerClient | None = None
    try:
        client = DockerClient(base_url="unix:///var/run/docker.sock", timeout=5)
        containers = client.containers.list(all=True)
        items: list[dict[str, Any]] = []
        running: list[tuple[dict[str, Any], Any]] = []
        for container in containers:
            info = container.attrs
            state_info = info.get("State", "unknown")
            state = state_info.get("Status", "unknown") if isinstance(state_info, dict) else state_info
            image = info.get("Config", {}).get("Image") or info.get("Image", "untagged")
            item: dict[str, Any] = {"name": container.name, "image": image, "state": state}
            items.append(item)
            if state == "running":
                running.append((item, container))
        # Sample all running containers concurrently so the request stays fast
        # regardless of how many containers are running.
        if running:
            with ThreadPoolExecutor(max_workers=min(8, len(running))) as executor:
                samples = executor.map(_container_stats, (container for _, container in running))
                for (item, _), sample in zip(running, samples):
                    item.update(sample)
        return {"available": True, "containers": items}
    except (DockerException, RequestException) as error:
        return {"available": False, "reason": str(error)}
    finally:
        if client is not None:
            client.close()


def get_metrics() -> dict[str, Any]:
    settings = load_settings()
    enabled = settings["metrics"]
    metrics: dict[str, Any] = {
        "timestamp": int(time.time() * 1000),
        "hostname": get_host_name(),
        "uptime_seconds": get_uptime_seconds(),
        "version": APP_VERSION,
        "enabled": enabled,
    }
    # Each branch gates its collection to make a disabled metric genuinely free.
    if enabled["cpu"]:
        metrics["cpu"] = get_cpu()
    if enabled["memory"]:
        metrics["memory"] = get_memory()
    if enabled["network"]:
        metrics["network"] = get_network()
    if enabled["disk"]:
        metrics["disk"] = get_disk_io()
    if enabled["gpu"]:
        metrics["gpu"] = get_gpu()
    if enabled["docker"]:
        metrics["docker"] = get_docker()
    return metrics


app = FastAPI(title="DGX Spark Dashboard", docs_url=None, redoc_url=None)
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="assets")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": APP_VERSION}


@app.get("/api/settings")
def settings() -> dict[str, Any]:
    return load_settings()


@app.put("/api/settings")
def update_settings(settings_input: Settings) -> dict[str, Any]:
    try:
        return save_settings(settings_input)
    except OSError as error:
        raise HTTPException(status_code=500, detail="Could not persist settings") from error


@app.get("/api/metrics")
def metrics() -> dict[str, Any]:
    return get_metrics()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")

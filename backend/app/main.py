"""Low-overhead, on-demand host metric collector for DGX Spark Dashboard."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import psutil
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
HOSTNAME_PATH = Path(os.getenv("DASHBOARD_HOSTNAME_PATH", "/host-hostname"))
HOST_NETWORK_DEV_PATH = Path(os.getenv("DASHBOARD_HOST_NETWORK_DEV_PATH", "/host-network-dev"))
HOST_NETWORK_ROUTE_PATH = Path(os.getenv("DASHBOARD_HOST_NETWORK_ROUTE_PATH", "/host-network-route"))
HOST_DISKSTATS_PATH = Path(os.getenv("DASHBOARD_HOST_DISKSTATS_PATH", "/host-diskstats"))
SETTINGS_LOCK = threading.Lock()
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


def get_cpu() -> dict[str, Any]:
    frequency = psutil.cpu_freq()
    temperature = get_cpu_temperature(get_temperatures())
    return {
        "percent": psutil.cpu_percent(interval=None),
        "cores": psutil.cpu_count(logical=False) or psutil.cpu_count(),
        "threads": psutil.cpu_count(),
        "frequency_mhz": round(frequency.current, 0) if frequency else None,
        "load_average": [round(value, 2) for value in os.getloadavg()] if hasattr(os, "getloadavg") else [],
        "temperature": temperature,
    }


def get_memory() -> dict[str, Any]:
    memory, swap = psutil.virtual_memory(), psutil.swap_memory()
    return {"ram": bytes_used(memory.total, memory.used), "swap": bytes_used(swap.total, swap.used)}


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
    """Return host uplink counters, falling back safely when host files are absent."""
    counters = _host_network_counters()
    default_interface = _default_host_interface()
    if default_interface and default_interface in counters:
        received, sent = counters[default_interface]
        return {
            "bytes_sent": sent,
            "bytes_received": received,
            "source": "host",
            "interface": default_interface,
        }

    virtual_prefixes = ("lo", "docker", "veth", "br-", "virbr", "cni", "flannel", "kube", "tun", "tap")
    physical = {name: values for name, values in counters.items() if not name.startswith(virtual_prefixes)}
    if physical:
        received = sum(values[0] for values in physical.values())
        sent = sum(values[1] for values in physical.values())
        return {
            "bytes_sent": sent,
            "bytes_received": received,
            "source": "host",
            "interface": ", ".join(sorted(physical)),
        }

    counters = psutil.net_io_counters()
    return {
        "bytes_sent": counters.bytes_sent,
        "bytes_received": counters.bytes_recv,
        "source": "container",
        "interface": None,
    }


def get_disk_io() -> dict[str, Any]:
    """Read aggregate physical-device I/O counters from the host's diskstats."""
    try:
        lines = HOST_DISKSTATS_PATH.read_text().splitlines()
    except OSError:
        return {"available": False, "reason": "host disk counters are unavailable"}

    physical_device = re.compile(r"(?:nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+)$")
    devices: list[str] = []
    read_sectors = write_sectors = 0
    for line in lines:
        fields = line.split()
        if len(fields) < 10 or not physical_device.fullmatch(fields[2]):
            continue
        try:
            read_sectors += int(fields[5])
            write_sectors += int(fields[9])
        except ValueError:
            continue
        devices.append(fields[2])
    if not devices:
        return {"available": False, "reason": "no supported physical disks found"}
    return {
        "available": True,
        "read_bytes": read_sectors * 512,
        "write_bytes": write_sectors * 512,
        "source": "host",
        "devices": ", ".join(devices),
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


def get_gpu() -> dict[str, Any]:
    if not shutil.which("nvidia-smi"):
        return {"available": False, "reason": "nvidia-smi is unavailable in this container"}
    query = "index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit"
    try:
        output = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {"available": False, "reason": "unable to query NVIDIA GPU"}
    gpus = []
    for line in output.splitlines():
        row = [item.strip() for item in line.split(",")]
        if len(row) != 9:
            continue
        def numeric(value: str) -> float | None:
            if "n/a" in value.lower() or "not supported" in value.lower():
                return None
            return float(re.sub(r"[^0-9.]", "", value) or 0)
        gpus.append({"index": int(row[0]), "name": row[1], "utilization": numeric(row[2]), "memory_utilization": numeric(row[3]), "memory_used_mib": numeric(row[4]), "memory_total_mib": numeric(row[5]), "temperature_c": numeric(row[6]), "power_w": numeric(row[7]), "power_limit_w": numeric(row[8])})
    return {"available": bool(gpus), "gpus": gpus}


def get_docker() -> dict[str, Any]:
    client: DockerClient | None = None
    try:
        client = DockerClient(base_url="unix:///var/run/docker.sock", timeout=2)
        containers = client.containers.list(all=True)
        result = []
        for container in containers:
            info = container.attrs
            state_info = info.get("State", "unknown")
            state = state_info.get("Status", "unknown") if isinstance(state_info, dict) else state_info
            image = info.get("Config", {}).get("Image") or info.get("Image", "untagged")
            item: dict[str, Any] = {"name": container.name, "image": image, "state": state}
            if state == "running":
                try:
                    stats = container.stats(stream=False)
                    cpu = stats.get("cpu_stats", {})
                    previous = stats.get("precpu_stats", {})
                    cpu_delta = cpu.get("cpu_usage", {}).get("total_usage", 0) - previous.get("cpu_usage", {}).get("total_usage", 0)
                    system_delta = cpu.get("system_cpu_usage", 0) - previous.get("system_cpu_usage", 0)
                    online_cpus = cpu.get("online_cpus") or len(cpu.get("cpu_usage", {}).get("percpu_usage", [])) or 1
                    memory = stats.get("memory_stats", {})
                    item.update({"cpu_percent": round((cpu_delta / system_delta * online_cpus * 100) if system_delta else 0, 1), "memory_used": memory.get("usage", 0), "memory_limit": memory.get("limit", 0)})
                except (DockerException, RequestException):
                    item["stats_available"] = False
            result.append(item)
        return {"available": True, "containers": result}
    except (DockerException, RequestException) as error:
        return {"available": False, "reason": str(error)}
    finally:
        if client is not None:
            client.close()


def get_metrics() -> dict[str, Any]:
    settings = load_settings()
    enabled = settings["metrics"]
    metrics: dict[str, Any] = {"timestamp": int(time.time() * 1000), "hostname": get_host_name(), "uptime_seconds": round(time.time() - psutil.boot_time()), "enabled": enabled}
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
    return {"status": "ok"}


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

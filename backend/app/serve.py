"""Bind the dashboard to one or more host addresses or interfaces.

`uvicorn --host` accepts a single address, but with host networking the
dashboard often needs to listen on a chosen set of trusted interfaces at once —
for example loopback plus a WireGuard and a Tailscale address — without exposing
every host NIC via 0.0.0.0. DASHBOARD_BIND_ADDRESS is therefore a comma- or
space-separated list of literal IPs or interface names (e.g. "wg0,tailscale0").
"""

from __future__ import annotations

import fcntl
import os
import socket
import struct
import sys

import uvicorn

from app.main import app

SIOCGIFADDR = 0x8915  # Linux ioctl to read an interface's IPv4 address.
LOOPBACK = "127.0.0.1"
WILDCARDS = {"0.0.0.0", "::"}


def _log(message: str) -> None:
    print(f"serve: {message}", file=sys.stderr)


def _is_ip(value: str) -> bool:
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, value)
            return True
        except OSError:
            continue
    return False


def _interface_ipv4(name: str) -> str | None:
    """Resolve a network interface name to its current IPv4 address (Linux)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            packed = struct.pack("256s", name.encode()[:15])
            info = fcntl.ioctl(probe.fileno(), SIOCGIFADDR, packed)
        return socket.inet_ntoa(info[20:24])
    except OSError:
        return None


def resolve_targets(raw: str) -> list[str]:
    """Turn the configured list into a deduplicated set of bindable addresses."""
    targets = [item.strip() for item in raw.replace(",", " ").split() if item.strip()]
    resolved: list[str] = []
    for target in targets:
        if target in WILDCARDS:
            return [target]  # A wildcard already covers every interface.
        address = target if _is_ip(target) else _interface_ipv4(target)
        if address is None:
            _log(f"could not resolve bind target '{target}'; skipping")
            continue
        if address not in resolved:
            resolved.append(address)
    # Always keep loopback so the container healthcheck and local access work.
    if LOOPBACK not in resolved:
        resolved.insert(0, LOOPBACK)
    return resolved


def _make_socket(host: str, port: int) -> socket.socket | None:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((host, port))
    except OSError as error:
        _log(f"skipping {host}:{port} ({error})")
        sock.close()
        return None
    sock.listen()
    _log(f"listening on {host}:{port}")
    return sock


def main() -> None:
    port = int(os.getenv("DASHBOARD_PORT", "8787"))
    targets = resolve_targets(os.getenv("DASHBOARD_BIND_ADDRESS", LOOPBACK))
    sockets = [sock for sock in (_make_socket(host, port) for host in targets) if sock]
    if not sockets:
        _log("no bind address is available; refusing to start")
        raise SystemExit(1)
    server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="warning"))
    server.run(sockets=sockets)


if __name__ == "__main__":
    main()

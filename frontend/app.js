const $ = (selector) => document.querySelector(selector);
const API = "/api";
let settings = null;
let timer = null;
let previousNetwork = null;
let previousDisk = null;
let metricsLoaded = false;
const summaryHistory = { cpu: [], memory: [], gpu: [], network: [], disk: [] };
const createDefaultSettings = () => ({
  refresh_seconds: 2,
  theme: "auto",
  display_mode: "graphs",
  summary_display_mode: "graphs",
  metrics: {
    cpu: true,
    gpu: true,
    memory: true,
    network: true,
    disk: true,
    docker: true,
  },
});
function applyTheme(theme) {
  const labels = { auto: "Auto", light: "Light", dark: "Dark" },
    icons = { auto: "◐", light: "☀", dark: "◑" };
  document.body.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#f4f7fc" : "#090b11");
  $("#theme-label").textContent = labels[theme];
  $("#theme-icon").textContent = icons[theme];
  $("#theme-switch").title = `Appearance: ${labels[theme]}. Click to change.`;
}
function applyDisplayMode(mode) {
  document.body.dataset.displayMode = mode;
}
function applySummaryDisplayMode(mode) {
  document.body.dataset.summaryDisplayMode = mode;
}
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );

const prettyBytes = (value = 0) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};
const uptimeDetail = (seconds) => {
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60);
  return d ? `Up ${d}d ${h}h ${m}m` : `Up ${h}h ${m}m`;
};
const setHTML = (el, html) => {
  el.replaceChildren();
  if (typeof html === "string") el.innerHTML = html;
  else el.append(html);
};
const toneFor = (value, kind = "utilization") => {
  if (value == null || Number.isNaN(Number(value))) return "neutral";
  const [warning, danger] = kind === "temperature" ? [65, 80] : [60, 85];
  return value >= danger ? "danger" : value >= warning ? "warning" : "good";
};
const toneColor = (tone) =>
  ({
    good: "#5fe0a6",
    warning: "#f7c65a",
    danger: "#ff7474",
    neutral: "#f1f4fb",
  })[tone] || "#f1f4fb";
const addSummarySample = (key, value, timestamp) => {
  if (!Number.isFinite(value)) return;
  const samples = summaryHistory[key];
  samples.push({ value, timestamp });
  if (samples.length > 30) samples.shift();
};
const sparkline = (values, tone, label, format) => {
  const observed = values.length
      ? values
      : [{ value: 0, timestamp: Date.now() }],
    points = observed.map((sample) => sample.value),
    chartPoints = points.length > 1 ? points : [points[0], points[0]],
    minimum = Math.min(...chartPoints),
    range = Math.max(Math.max(...chartPoints) - minimum, 1);
  const line = chartPoints
    .map(
      (value, index) =>
        `${((index / (chartPoints.length - 1)) * 100).toFixed(1)},${(27 - ((value - minimum) / range) * 22).toFixed(1)}`,
    )
    .join(" ");
  return `<div class="summary-chart-wrap" tabindex="0" role="img" aria-label="${escapeHTML(label)} chart" data-values="${observed.map((sample) => Number(sample.value).toFixed(3)).join(",")}" data-times="${observed.map((sample) => Number(sample.timestamp)).join(",")}" data-label="${escapeHTML(label)}" data-format="${format}"><svg class="summary-chart" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,31 ${line} 100,31" fill="${toneColor(tone)}" opacity=".12"/><polyline points="${line}" fill="none" stroke="${toneColor(tone)}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="chart-tooltip" role="status"></span></div>`;
};
const card = (label, value, sub, tone = "neutral", chart = "") =>
  `<article class="card"><div class="label">${label}</div><div class="value" style="color:${toneColor(tone)}">${value}</div><div class="sub">${sub || ""}</div>${chart}</article>`;
const skeleton = (className = "") =>
  `<span class="skeleton ${className}" aria-hidden="true"></span>`;

function renderLoading() {
  if (metricsLoaded) return;
  setHTML(
    $("#summary"),
    Array.from(
      { length: 5 },
      () =>
        `<article class="card skeleton-card">${skeleton("skeleton-label")}${skeleton("skeleton-value")}${skeleton("skeleton-sub")}${skeleton("skeleton-chart")}</article>`,
    ).join(""),
  );
  setHTML(
    $("#gpus"),
    `<article class="gpu-card skeleton-gpu">${skeleton("skeleton-title")}${skeleton("skeleton-temp")}<div class="skeleton-bars">${skeleton("skeleton-bar")}${skeleton("skeleton-bar")}</div></article>`,
  );
  const containerHeader = `<div class="container-row container-header"><span>Container</span><span>Status</span><span>CPU</span><span>Memory</span><span>Usage</span></div>`;
  const row = `<div class="container-row skeleton-row">${skeleton("skeleton-name")}${skeleton("skeleton-state")}${skeleton("skeleton-cell")}${skeleton("skeleton-cell")}${skeleton("skeleton-cell")}</div>`;
  setHTML($("#containers"), containerHeader + row + row + row);
  ["#summary", "#gpus", "#containers"].forEach((selector) =>
    $(selector).setAttribute("aria-busy", "true"),
  );
  $("#updated").textContent = "Loading…";
  $("#container-count").textContent = "Loading…";
}

function renderSummary(data) {
  const cards = [];
  const showCharts = settings?.summary_display_mode !== "text";
  if (data.cpu) {
    const tone = toneFor(data.cpu.percent),
      temp = data.cpu.temperature
        ? ` · <span style="color:${toneColor(toneFor(data.cpu.temperature.current, "temperature"))}">${data.cpu.temperature.current}°C</span>`
        : "";
    addSummarySample("cpu", data.cpu.percent, data.timestamp);
    cards.push(
      card(
        "CPU",
        `${data.cpu.percent}%`,
        `${data.cpu.cores} cores · ${data.cpu.threads} threads${temp}`,
        tone,
        showCharts
          ? sparkline(summaryHistory.cpu, tone, "CPU utilization", "percent")
          : "",
      ),
    );
  }
  if (data.memory) {
    const tone = toneFor(data.memory.ram.percent);
    addSummarySample("memory", data.memory.ram.percent, data.timestamp);
    cards.push(
      card(
        "MEMORY",
        `${data.memory.ram.percent}%`,
        `${prettyBytes(data.memory.ram.used)} / ${prettyBytes(data.memory.ram.total)}`,
        tone,
        showCharts
          ? sparkline(summaryHistory.memory, tone, "Memory use", "percent")
          : "",
      ),
    );
  }
  if (data.gpu?.available) {
    const g = data.gpu.gpus[0],
      tone = toneFor(g.utilization);
    addSummarySample("gpu", g.utilization, data.timestamp);
    cards.push(
      card(
        "GPU",
        `${g.utilization}%`,
        `${escapeHTML(g.name)} · ${g.temperature_c}°C`,
        tone,
        showCharts
          ? sparkline(summaryHistory.gpu, tone, "GPU utilization", "percent")
          : "",
      ),
    );
  }
  if (data.network) {
    const now = data.timestamp,
      source = data.network.source === "host" ? "Host" : "Container fallback",
      interfaceName = data.network.interface
        ? ` · ${data.network.interface}`
        : "";
    let rate = `Collecting rate… · ${source}${interfaceName}`,
      combinedRate = 0;
    if (previousNetwork) {
      const dt = Math.max((now - previousNetwork.time) / 1000, 0.1),
        receivedRate = Math.max(
          0,
          (data.network.bytes_received - previousNetwork.rx) / dt,
        ),
        sentRate = Math.max(
          0,
          (data.network.bytes_sent - previousNetwork.tx) / dt,
        );
      combinedRate = receivedRate + sentRate;
      rate = `↓ ${prettyBytes(receivedRate)}/s · ↑ ${prettyBytes(sentRate)}/s · ${source}${interfaceName}`;
    }
    previousNetwork = {
      time: now,
      rx: data.network.bytes_received,
      tx: data.network.bytes_sent,
    };
    addSummarySample("network", combinedRate, data.timestamp);
    cards.push(
      card(
        "HOST NETWORK",
        prettyBytes(data.network.bytes_received),
        rate,
        "neutral",
        showCharts
          ? sparkline(
              summaryHistory.network,
              "neutral",
              "Combined network",
              "bytes",
            )
          : "",
      ),
    );
  }
  if (data.disk) {
    if (!data.disk.available) {
      cards.push(card("DISK I/O", "—", data.disk.reason, "neutral"));
    } else {
      const now = data.timestamp,
        deviceName = data.disk.devices ? ` · ${data.disk.devices}` : "";
      let totalRate = "Collecting rate…",
        detail = `Host disks${deviceName}`,
        combinedRate = 0;
      if (previousDisk) {
        const dt = Math.max((now - previousDisk.time) / 1000, 0.1),
          readRate = Math.max(
            0,
            (data.disk.read_bytes - previousDisk.read) / dt,
          ),
          writeRate = Math.max(
            0,
            (data.disk.write_bytes - previousDisk.write) / dt,
          );
        combinedRate = readRate + writeRate;
        totalRate = `${prettyBytes(combinedRate)}/s`;
        detail = `Read ${prettyBytes(readRate)}/s · Write ${prettyBytes(writeRate)}/s${deviceName}`;
      }
      previousDisk = {
        time: now,
        read: data.disk.read_bytes,
        write: data.disk.write_bytes,
      };
      addSummarySample("disk", combinedRate, data.timestamp);
      cards.push(
        card(
          "DISK I/O",
          totalRate,
          detail,
          "neutral",
          showCharts
            ? sparkline(
                summaryHistory.disk,
                "neutral",
                "Combined disk I/O",
                "bytes",
              )
            : "",
        ),
      );
    }
  }
  setHTML($("#summary"), cards.join(""));
}

function renderGpus(gpu) {
  if (!gpu?.available)
    return setHTML(
      $("#gpus"),
      `<article class="gpu-card empty">${gpu?.reason || "GPU collection disabled"}</article>`,
    );
  const showGraphs = settings?.display_mode !== "text";
  setHTML(
    $("#gpus"),
    gpu.gpus
      .map((g) => {
        const hasVram = g.memory_total_mib != null,
          tempTone = toneFor(g.temperature_c, "temperature"),
          computeTone = toneFor(g.utilization),
          memoryTone = toneFor(g.memory_utilization);
        const visualization = showGraphs
          ? `<div class="bars"><div><div class="bar-label"><span>Compute</span><b style="color:${toneColor(computeTone)}">${g.utilization ?? "—"}%</b></div><div class="bar"><i style="width:${g.utilization ?? 0}%;background:${toneColor(computeTone)}"></i></div></div><div><div class="bar-label"><span>Memory</span><b style="color:${toneColor(memoryTone)}">${g.memory_utilization ?? "—"}%</b></div><div class="bar"><i style="width:${g.memory_utilization ?? 0}%;background:${toneColor(memoryTone)}"></i></div></div></div>`
          : `<dl class="metric-readout"><div><dt>Compute</dt><dd style="color:${toneColor(computeTone)}">${g.utilization != null ? `${g.utilization}%` : "—"}</dd></div><div><dt>Memory</dt><dd style="color:${toneColor(memoryTone)}">${g.memory_utilization != null ? `${g.memory_utilization}%` : "—"}</dd></div><div><dt>Temperature</dt><dd style="color:${toneColor(tempTone)}">${g.temperature_c != null ? `${g.temperature_c}°C` : "—"}</dd></div><div><dt>Power</dt><dd>${g.power_w != null ? `${g.power_w} W` : "—"}</dd></div></dl>`;
        const powerReference =
          g.power_limit_w != null
            ? `<div>LIMIT<b>${g.power_limit_w} W</b></div>`
            : /GB10/i.test(g.name)
              ? `<div title="Official GB10 thermal design power; not a live driver power limit">TDP<b>140 W</b></div>`
              : "";
        const temperature =
          g.temperature_c != null ? `${g.temperature_c}°C` : "—";
        const power = g.power_w != null ? `${g.power_w} W` : "—";
        return `<article class="gpu-card"><div class="gpu-head"><div><div class="gpu-name">GPU ${g.index} · ${escapeHTML(g.name)}</div>${hasVram ? `<div class="small-label">${prettyBytes(g.memory_used_mib * 1048576)} of ${prettyBytes(g.memory_total_mib * 1048576)} VRAM</div>` : ""}</div><div class="temperature" style="color:${toneColor(tempTone)}">${temperature}</div></div>${visualization}${showGraphs ? `<div class="gpu-foot"><div>POWER<b>${power}</b></div>${powerReference}</div>` : ""}</article>`;
      })
      .join(""),
  );
}

function renderContainers(docker) {
  $("#container-count").textContent = docker?.available
    ? `${docker.containers.length} total`
    : "Unavailable";
  if (!docker?.available)
    return setHTML(
      $("#containers"),
      `<div class="empty">${docker?.reason || "Docker collection disabled"}</div>`,
    );
  if (!docker.containers.length)
    return setHTML(
      $("#containers"),
      '<div class="empty">No containers found.</div>',
    );
  const inactiveStates = new Set(["exited", "dead", "removing"]);
  const containers = [...docker.containers].sort(
    (left, right) =>
      Number(inactiveStates.has(left.state)) -
        Number(inactiveStates.has(right.state)) ||
      left.name.localeCompare(right.name),
  );
  const header = `<div class="container-row container-header"><span>Container</span><span>Status</span><span>CPU</span><span>Memory</span><span>Usage</span></div>`;
  setHTML(
    $("#containers"),
    header +
      containers
        .map((c) => {
          const cpuTone = toneFor(c.cpu_percent),
            memoryPercent = c.memory_limit
              ? Math.round((c.memory_used / c.memory_limit) * 100)
              : null,
            memoryTone = toneFor(memoryPercent),
            cpu = c.cpu_percent != null ? `${c.cpu_percent}% CPU` : "—",
            memory = c.memory_used != null ? prettyBytes(c.memory_used) : "—";
          return `<div class="container-row"><div><div class="container-name">${escapeHTML(c.name)}</div><div class="container-image">${escapeHTML(c.image)}</div></div><span class="state ${escapeHTML(c.state)}">${escapeHTML(c.state)}</span><span style="color:${toneColor(cpuTone)}">${cpu}</span><span>${memory}</span><span style="color:${toneColor(memoryTone)}">${memoryPercent != null ? `${memoryPercent}% memory` : "—"}</span></div>`;
        })
        .join(""),
  );
}

async function refresh() {
  try {
    const response = await fetch(`${API}/metrics`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    $("#connection").classList.add("online");
    $("#host").textContent = data.hostname;
    $("#host-uptime").textContent = uptimeDetail(data.uptime_seconds);
    $("#updated").textContent =
      `Updated ${new Date(data.timestamp).toLocaleTimeString()}`;
    renderSummary(data);
    renderGpus(data.gpu);
    renderContainers(data.docker);
    metricsLoaded = true;
    ["#summary", "#gpus", "#containers"].forEach((selector) =>
      $(selector).setAttribute("aria-busy", "false"),
    );
  } catch (_) {
    $("#connection").classList.remove("online");
    $("#host").textContent = "Connection lost";
    $("#host-uptime").textContent = "—";
    if (!metricsLoaded) {
      const unavailable =
        '<div class="empty">Telemetry is temporarily unavailable. Retrying automatically…</div>';
      setHTML($("#summary"), unavailable);
      setHTML($("#gpus"), unavailable);
      setHTML($("#containers"), unavailable);
      ["#summary", "#gpus", "#containers"].forEach((selector) =>
        $(selector).setAttribute("aria-busy", "false"),
      );
      $("#updated").textContent = "Unable to load telemetry";
      $("#container-count").textContent = "Unavailable";
    }
  }
}

function toggleLabel(key) {
  return (
    {
      cpu: "CPU",
      gpu: "NVIDIA GPU",
      memory: "RAM & swap",
      network: "Host network totals",
      disk: "Host disk I/O",
      docker: "Docker containers",
    }[key] || key
  );
}
function updateChartTooltip(chart, clientX) {
  const values = (chart.dataset.values || "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite);
  const timestamps = (chart.dataset.times || "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite);
  if (!values.length) return;
  const rect = chart.getBoundingClientRect(),
    position = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    index = Math.round(position * (values.length - 1)),
    value = values[index],
    timestamp = timestamps[index],
    formatted =
      chart.dataset.format === "bytes"
        ? `${prettyBytes(value)}/s`
        : `${value.toFixed(1)}%`;
  const time = Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Time unavailable";
  chart.querySelector(".chart-tooltip").textContent =
    `${chart.dataset.label}: ${formatted} · ${time}`;
  chart.style.setProperty(
    "--tooltip-position",
    `${Math.min(92, Math.max(8, position * 100))}%`,
  );
  chart.classList.add("show-tooltip");
}
$("#summary").addEventListener("pointermove", (event) => {
  const chart = event.target.closest(".summary-chart-wrap");
  if (chart) updateChartTooltip(chart, event.clientX);
});
$("#summary").addEventListener(
  "pointerleave",
  (event) => {
    const chart = event.target.closest(".summary-chart-wrap");
    if (chart) chart.classList.remove("show-tooltip");
  },
  true,
);
$("#summary").addEventListener("focusin", (event) => {
  const chart = event.target.closest(".summary-chart-wrap");
  if (chart) updateChartTooltip(chart, chart.getBoundingClientRect().right);
});
$("#summary").addEventListener("focusout", (event) => {
  const chart = event.target.closest(".summary-chart-wrap");
  if (chart) chart.classList.remove("show-tooltip");
});
async function loadSettings() {
  const response = await fetch(`${API}/settings`, { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load settings");
  settings = await response.json();
  applyTheme(settings.theme);
  applyDisplayMode(settings.display_mode);
  applySummaryDisplayMode(settings.summary_display_mode);
  $("#refresh-seconds").value = String(settings.refresh_seconds);
  $("#show-summary-charts").checked =
    settings.summary_display_mode === "graphs";
  $("#show-graphs").checked = settings.display_mode === "graphs";
  setHTML(
    $("#metric-toggles"),
    Object.entries(settings.metrics)
      .map(
        ([key, enabled]) =>
          `<label class="toggle"><div>${toggleLabel(key)}<br><span>Collect ${toggleLabel(key).toLowerCase()} telemetry</span></div><input type="checkbox" data-key="${key}" ${enabled ? "checked" : ""}></label>`,
      )
      .join(""),
  );
}
function schedule() {
  clearInterval(timer);
  timer = setInterval(refresh, settings.refresh_seconds * 1000);
}

$("#settings-button").addEventListener("click", async () => {
  await loadSettings();
  $("#settings-dialog").showModal();
});
$("#settings-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const metrics = {};
  document.querySelectorAll("#metric-toggles input").forEach((input) => {
    metrics[input.dataset.key] = input.checked;
  });
  settings = {
    refresh_seconds: Number($("#refresh-seconds").value),
    theme: settings.theme,
    display_mode: $("#show-graphs").checked ? "graphs" : "text",
    summary_display_mode: $("#show-summary-charts").checked ? "graphs" : "text",
    metrics,
  };
  const response = await fetch(`${API}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (response.ok) {
    applyTheme(settings.theme);
    applyDisplayMode(settings.display_mode);
    applySummaryDisplayMode(settings.summary_display_mode);
    $("#settings-dialog").close();
    schedule();
    previousNetwork = null;
    await refresh();
  }
});

$("#theme-switch").addEventListener("click", async () => {
  if (!settings) return;
  const themes = ["auto", "light", "dark"];
  settings = {
    ...settings,
    theme: themes[(themes.indexOf(settings.theme) + 1) % themes.length],
  };
  applyTheme(settings.theme);
  const response = await fetch(`${API}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) await loadSettings();
});

renderLoading();
(async () => {
  try {
    await loadSettings();
  } catch (_) {
    settings = createDefaultSettings();
    applyTheme(settings.theme);
    applyDisplayMode(settings.display_mode);
    applySummaryDisplayMode(settings.summary_display_mode);
  }
  schedule();
  await refresh();
})();

const $ = (selector) => document.querySelector(selector);
const API = "/api";
let settings = null;
let timer = null;
let pendingSettingsSave = null;
let settingsSaveActive = false;
let previousNetwork = new Map();
let previousDisk = new Map();
let metricsLoaded = false;
let lastData = null;
const summaryHistory = { cpu: [], memory: [], gpu: [] };
const sourceHistory = { network: new Map(), disk: new Map() };
const carouselPosition = { network: 0, disk: 0 };
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
    icons = { auto: "◐", light: "☀", dark: "◑" },
    usesLightPalette =
      theme === "light" ||
      (theme === "auto" &&
        window.matchMedia("(prefers-color-scheme: light)").matches);
  document.body.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", usesLightPalette ? "#f4f7fc" : "#090b11");
  $("#theme-label").textContent = labels[theme];
  $("#theme-icon").textContent = icons[theme];
  $("#theme-switch").title = `Appearance: ${labels[theme]}. Click to change.`;
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
// Free space is a headline number, so it is formatted as tightly as the value
// allows: at most two decimals, trailing zeros trimmed. 4 GiB, 4.1 GiB,
// 2.15 TiB. Units stay binary to match every other card in the dashboard.
const compactBytes = (value = 0) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  // Number() drops the trailing zeros toFixed() pads on, so 4.00 renders as 4.
  return `${index === 0 ? Math.round(value) : Number(value.toFixed(2))} ${units[index]}`;
};
const sourceDetail = (source, detail) =>
  `<span class="source-detail-name">${escapeHTML(source)}</span><span class="source-detail-rates">${detail}</span>`;
const uptimeDetail = (seconds) => {
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60);
  return d ? `Up ${d}d ${h}h ${m}m` : `Up ${h}h ${m}m`;
};
const versionLabel = (version) => {
  const value = String(version || "").trim();
  if (!value) return "—";
  return value === "dev" ? "dev" : `v${value.replace(/^v/i, "")}`;
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
// Returns a CSS custom property so tones adapt to the active theme. Only ever
// interpolate this into an inline `style` (or `currentColor`-backed SVG), never
// into an SVG presentation attribute, where var() does not resolve.
const toneColor = (tone) =>
  ({
    good: "var(--tone-good)",
    warning: "var(--tone-warning)",
    danger: "var(--tone-danger)",
    neutral: "var(--text)",
  })[tone] || "var(--text)";
const addSummarySample = (key, value, timestamp) => {
  if (!Number.isFinite(value)) return;
  const samples = summaryHistory[key];
  samples.push({ value, timestamp });
  if (samples.length > 30) samples.shift();
};
const addSourceSample = (kind, source, value, timestamp) => {
  if (!Number.isFinite(value)) return [];
  if (!sourceHistory[kind].has(source)) sourceHistory[kind].set(source, []);
  const samples = sourceHistory[kind].get(source);
  samples.push({ value, timestamp });
  if (samples.length > 30) samples.shift();
  return samples;
};
const sparkline = (values, tone, label, format) => {
  const observed = values.length
      ? values
      : [{ value: 0, timestamp: Date.now() }],
    points = observed.map((sample) => sample.value),
    chartPoints = points.length > 1 ? points : [points[0], points[0]],
    // Percentages are drawn against a fixed 0-100 axis so a line's height means
    // the same thing on every card and in every window: a GPU pinned at 96%
    // sits near the top instead of collapsing onto the baseline once the series
    // goes flat. Byte rates have no natural ceiling, so they stay auto-scaled.
    // Both anchor at 0, which also stops idle jitter from being stretched into
    // a full-height spike.
    ceiling = format === "percent" ? 100 : Math.max(...chartPoints, 1);
  const line = chartPoints
    .map((value, index) => {
      const x = (index / (chartPoints.length - 1)) * 100,
        // Clamp so a driver reporting over 100% cannot draw outside the viewBox.
        y = 27 - Math.min(Math.max(value / ceiling, 0), 1) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<div class="summary-chart-wrap" tabindex="0" role="img" aria-label="${escapeHTML(label)} chart" data-values="${observed.map((sample) => Number(sample.value).toFixed(3)).join(",")}" data-times="${observed.map((sample) => Number(sample.timestamp)).join(",")}" data-label="${escapeHTML(label)}" data-format="${format}"><svg class="summary-chart" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true" style="color:${toneColor(tone)}"><polyline points="0,31 ${line} 100,31" fill="currentColor" opacity=".12"/><polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="chart-tooltip" role="status"></span></div>`;
};
const card = (
  label,
  value,
  sub,
  tone = "neutral",
  chart = "",
  className = "",
  title = "",
) =>
  `<article class="card ${className}"${title ? ` title="${escapeHTML(title)}"` : ""}><div class="label">${label}</div><div class="value" style="color:${toneColor(tone)}">${value}</div><div class="sub">${sub || ""}</div>${chart}</article>`;
const sourceCarouselCard = (kind, label, slides, className = "") => {
  const active = Math.min(carouselPosition[kind], slides.length - 1);
  carouselPosition[kind] = Math.max(0, active);
  const controls =
    slides.length > 1
      ? `<div class="source-pager"><button type="button" data-carousel="${kind}" data-direction="-1" aria-label="Previous ${escapeHTML(label.toLowerCase())} source">‹</button><span data-carousel-count aria-live="polite">${active + 1} / ${slides.length}</span><button type="button" data-carousel="${kind}" data-direction="1" aria-label="Next ${escapeHTML(label.toLowerCase())} source">›</button></div>`
      : "";
  return `<article class="card source-carousel-card ${slides.length > 1 ? "has-carousel-controls" : ""} ${className}" data-carousel-kind="${kind}" aria-label="${escapeHTML(label)} sources"><div class="carousel-heading"><div class="label">${label}</div>${controls}</div>${slides
    .map(
      (slide, index) =>
        `<section class="source-slide${index === active ? " active" : ""}" data-carousel-slide="${kind}" data-index="${index}" data-source="${escapeHTML(slide.name)}"${index === active ? "" : " hidden"}${slide.title ? ` title="${escapeHTML(slide.title)}"` : ""}><div class="value" style="color:${toneColor(slide.tone || "neutral")}">${slide.value}</div><div class="sub">${slide.sub || ""}</div>${slide.chart || ""}</section>`,
    )
    .join("")}</article>`;
};
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
    const source = data.network.source === "host" ? "Host" : "Container fallback",
      interfaces = data.network.interfaces?.length
        ? data.network.interfaces
        : [
            {
              name: data.network.interface || "Aggregate",
              bytes_received: data.network.bytes_received,
              bytes_sent: data.network.bytes_sent,
              default: true,
            },
          ],
      nextNetwork = new Map(),
      slides = interfaces.map((networkInterface) => {
        const previous = previousNetwork.get(networkInterface.name);
        const sourceLabel = `${networkInterface.name}${networkInterface.default ? " (default)" : ""}`;
        let rate = "Collecting rate…",
          combinedRate = 0;
        if (previous) {
          const dt = Math.max((data.timestamp - previous.time) / 1000, 0.1),
            receivedRate = Math.max(
              0,
              (networkInterface.bytes_received - previous.rx) / dt,
            ),
            sentRate = Math.max(
              0,
              (networkInterface.bytes_sent - previous.tx) / dt,
            );
          combinedRate = receivedRate + sentRate;
          rate = `↓ ${prettyBytes(receivedRate)}/s · ↑ ${prettyBytes(sentRate)}/s`;
        }
        nextNetwork.set(networkInterface.name, {
          time: data.timestamp,
          rx: networkInterface.bytes_received,
          tx: networkInterface.bytes_sent,
        });
        const history = addSourceSample(
          "network",
          networkInterface.name,
          combinedRate,
          data.timestamp,
        );
        return {
          name: networkInterface.name,
          value: prettyBytes(networkInterface.bytes_received),
          sub: sourceDetail(sourceLabel, rate),
          chart: showCharts
            ? sparkline(
                history,
                "neutral",
                `${networkInterface.name} combined network`,
                "bytes",
              )
            : "",
          title: `${source} interface · received total ${prettyBytes(networkInterface.bytes_received)} · sent total ${prettyBytes(networkInterface.bytes_sent)}`,
        };
      });
    previousNetwork = nextNetwork;
    cards.push(
      sourceCarouselCard(
        "network",
        "HOST NETWORK",
        slides,
        "network-card",
      ),
    );
  }
  if (data.disk) {
    if (!data.disk.available) {
      cards.push(card("DISK I/O", "—", data.disk.reason, "neutral"));
    } else {
      const capacity = data.disk.capacity,
        disks = data.disk.disks?.length
          ? data.disk.disks
          : [
              {
                name: data.disk.devices || "Host disks",
                read_bytes: data.disk.read_bytes,
                write_bytes: data.disk.write_bytes,
              },
            ],
        nextDisk = new Map(),
        slides = disks.map((disk) => {
          const previous = previousDisk.get(disk.name);
          let totalRate = "—",
            detail = "Collecting rate…",
            combinedRate = 0;
          if (previous) {
            const dt = Math.max((data.timestamp - previous.time) / 1000, 0.1),
              readRate = Math.max(
                0,
                (disk.read_bytes - previous.read) / dt,
              ),
              writeRate = Math.max(
                0,
                (disk.write_bytes - previous.write) / dt,
              );
            combinedRate = readRate + writeRate;
            totalRate = `${prettyBytes(combinedRate)}/s`;
            detail = `R ${prettyBytes(readRate)}/s · W ${prettyBytes(writeRate)}/s`;
          }
          nextDisk.set(disk.name, {
            time: data.timestamp,
            read: disk.read_bytes,
            write: disk.write_bytes,
          });
          const history = addSourceSample(
            "disk",
            disk.name,
            combinedRate,
            data.timestamp,
          );
          // Free space is the number worth glancing at: it is actionable and
          // running out of it is a real failure mode, where a read+write sum is
          // neither rate and is already broken out on the line below. Capacity
          // is filesystem-wide rather than per-device, so the tooltip names the
          // filesystem; the throughput sum stays the headline only when the
          // capacity read is unavailable.
          const capacityDetail = capacity
            ? `${compactBytes(capacity.free_bytes)} free of ${compactBytes(capacity.total_bytes)} on ${capacity.path}`
            : "capacity unavailable";
          return {
            name: disk.name,
            value: capacity ? compactBytes(capacity.free_bytes) : totalRate,
            sub: sourceDetail(disk.name, detail),
            chart: showCharts
              ? sparkline(
                  history,
                  "neutral",
                  `${disk.name} combined disk I/O`,
                  "bytes",
                )
              : "",
            title: `Host disk ${disk.name} · ${capacityDetail} · read total ${prettyBytes(disk.read_bytes)} · written total ${prettyBytes(disk.write_bytes)}`,
          };
        });
      previousDisk = nextDisk;
      cards.push(
        sourceCarouselCard(
          "disk",
          // The headline is capacity now, so "DISK I/O" would misname it; the
          // I/O rates and sparkline still live in the card body.
          "DISK",
          slides,
          "disk-card",
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

// Render a metrics snapshot, honouring the current metric toggles so a change
// takes effect instantly (disabled categories drop out) rather than waiting for
// the next fetch. Enabling a category fills in on the following refresh.
function renderView(data) {
  const enabled = settings?.metrics ?? {};
  const view = { ...data };
  for (const key of ["cpu", "memory", "network", "disk", "gpu", "docker"]) {
    if (enabled[key] === false) delete view[key];
  }
  renderSummary(view);
  renderGpus(view.gpu);
  renderContainers(view.docker);
}

async function refresh() {
  try {
    const response = await fetch(`${API}/metrics`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    lastData = data;
    $("#connection").classList.add("online");
    $("#host").textContent = data.hostname;
    $("#host-uptime").textContent = uptimeDetail(data.uptime_seconds);
    $("#app-version").textContent = versionLabel(data.version);
    $("#updated").textContent =
      `Updated ${new Date(data.timestamp).toLocaleTimeString()}`;
    renderView(data);
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
  const tooltip = chart.querySelector(".chart-tooltip");
  tooltip.textContent = `${chart.dataset.label}: ${formatted} · ${time}`;
  chart.classList.add("show-tooltip");
  const halfWidth = tooltip.offsetWidth / 2,
    desiredCenter = rect.left + position * rect.width,
    safeCenter = Math.min(
      window.innerWidth - halfWidth - 8,
      Math.max(halfWidth + 8, desiredCenter),
    );
  chart.style.setProperty(
    "--tooltip-position",
    `${safeCenter - rect.left}px`,
  );
}
function activateCarousel(kind, direction) {
  const carousel = document.querySelector(
    `.source-carousel-card[data-carousel-kind="${kind}"]`,
  );
  if (!carousel) return;
  const slides = [...carousel.querySelectorAll("[data-carousel-slide]")];
  if (slides.length < 2) return;
  const next =
    (carouselPosition[kind] + direction + slides.length) % slides.length;
  carouselPosition[kind] = next;
  slides.forEach((slide, index) => {
    slide.hidden = index !== next;
    slide.classList.toggle("active", index === next);
    slide.classList.remove("carousel-transition");
  });
  const activeSlide = slides[next];
  // Telemetry refreshes rebuild carousel markup, so transitions must be tied
  // only to explicit source navigation. Forcing layout here lets rapid manual
  // navigation restart the short animation without affecting polling updates.
  void activeSlide.offsetWidth;
  activeSlide.classList.add("carousel-transition");
  activeSlide.addEventListener(
    "animationend",
    () => activeSlide.classList.remove("carousel-transition"),
    { once: true },
  );
  carousel.querySelector("[data-carousel-count]").textContent =
    `${next + 1} / ${slides.length}`;
}
let carouselSwipe = null;
$("#summary").addEventListener("click", (event) => {
  const control = event.target.closest("[data-carousel]");
  if (control)
    activateCarousel(control.dataset.carousel, Number(control.dataset.direction));
});
$("#summary").addEventListener("pointerdown", (event) => {
  const carousel = event.target.closest("[data-carousel-kind]");
  if (carousel && event.pointerType === "touch")
    carouselSwipe = {
      kind: carousel.dataset.carouselKind,
      x: event.clientX,
      y: event.clientY,
    };
});
$("#summary").addEventListener("pointerup", (event) => {
  if (!carouselSwipe || event.pointerType !== "touch") return;
  const horizontal = event.clientX - carouselSwipe.x,
    vertical = event.clientY - carouselSwipe.y;
  if (Math.abs(horizontal) > 45 && Math.abs(horizontal) > Math.abs(vertical))
    activateCarousel(carouselSwipe.kind, horizontal < 0 ? 1 : -1);
  carouselSwipe = null;
});
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

function settingsFromForm() {
  const metrics = {};
  document.querySelectorAll("#metric-toggles input").forEach((input) => {
    metrics[input.dataset.key] = input.checked;
  });
  return {
    refresh_seconds: Number($("#refresh-seconds").value),
    theme: settings.theme,
    display_mode: $("#show-graphs").checked ? "graphs" : "text",
    summary_display_mode: $("#show-summary-charts").checked
      ? "graphs"
      : "text",
    metrics,
  };
}

function setSettingsSaveStatus(message, state = "") {
  const status = $("#settings-save-status");
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

async function drainSettingsSaves() {
  if (settingsSaveActive) return;
  settingsSaveActive = true;
  while (pendingSettingsSave) {
    const payload = pendingSettingsSave;
    pendingSettingsSave = null;
    setSettingsSaveStatus("Saving changes…", "saving");
    try {
      const response = await fetch(`${API}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("Unable to save settings");
      if (!pendingSettingsSave) {
        settings = await response.json();
        setSettingsSaveStatus("Saved", "saved");
        schedule();
        await refresh();
      }
    } catch (_) {
      if (!pendingSettingsSave) {
        setSettingsSaveStatus("Could not save. Change a setting to retry.", "error");
      }
    }
  }
  settingsSaveActive = false;
}

function queueSettingsSave() {
  pendingSettingsSave = JSON.parse(JSON.stringify(settings));
  void drainSettingsSaves();
}

$("#settings-button").addEventListener("click", async () => {
  await loadSettings();
  setSettingsSaveStatus("Changes save automatically.");
  $("#settings-dialog").showModal();
});
$("#close-settings").addEventListener("click", () =>
  $("#settings-dialog").close(),
);
$("#settings-form").addEventListener("submit", (event) =>
  event.preventDefault(),
);
$("#settings-form").addEventListener("change", () => {
  const previous = settings;
  settings = settingsFromForm();
  schedule();
  if (JSON.stringify(previous.metrics) !== JSON.stringify(settings.metrics)) {
    previousNetwork = new Map();
    previousDisk = new Map();
    sourceHistory.network.clear();
    sourceHistory.disk.clear();
  }
  // Apply the change to the view immediately, decoupled from the save round-trip.
  if (lastData) renderView(lastData);
  queueSettingsSave();
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
  }
  schedule();
  await refresh();
})();

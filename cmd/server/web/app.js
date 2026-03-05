const igcFileInput = document.getElementById("igcFileInput");
const uploadBtn = document.getElementById("uploadBtn");
const playBtn = document.getElementById("playBtn");
const baseViewSelect = document.getElementById("baseView");
const playbackSpeedSelect = document.getElementById("playbackSpeed");
const followCamSelect = document.getElementById("followCam");
const info = document.getElementById("info");

let deckOverlay;
let currentPath = [];
let currentSamples = [];
let currentSegments = [];
let cumulativeDistances = [];
let totalDistanceM = 0;
let animationFrameId = null;
let isPlaying = false;
let playbackProgress = 0;
let playbackStartTs = 0;
const paragliderIcon = createParagliderIcon();

const TERRAIN_EXAGGERATION = 1.0;
const MIN_TERRAIN_CLEARANCE_M = 15;
const ALTITUDE_VISUAL_OFFSET_M = 10;
const BASE_PLAYBACK_DURATION_MS = 60000;
const TRACK_COLOR_DEFAULT = [239, 68, 68, 245];
const TRACK_COLOR_CLIMB = [255, 184, 108, 250];

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
        maxzoom: 19,
      },
      satellite: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution: "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: "osm-base",
        type: "raster",
        source: "osm",
      },
      {
        id: "satellite-base",
        type: "raster",
        source: "satellite",
        layout: {
          visibility: "none",
        },
      },
    ],
  },
  center: [11.47, 47.39],
  zoom: 10,
  pitch: 65,
  bearing: 20,
  antialias: true,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

map.on("load", async () => {
  applyBaseView(baseViewSelect.value);
  applyTerrain();

  deckOverlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(deckOverlay);

  map.addSource("route-points", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "route-points",
    type: "circle",
    source: "route-points",
    paint: {
      "circle-radius": ["case", ["==", ["get", "pointType"], "start"], 6, 4],
      "circle-color": ["case", ["==", ["get", "pointType"], "start"], "#22c55e", "#ef4444"],
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#ffffff",
    },
  });

  info.textContent = "Choose an IGC file and click Upload.";
});

uploadBtn.addEventListener("click", async () => {
  const file = igcFileInput.files?.[0];
  if (!file) {
    info.textContent = "Please choose an .igc file first.";
    return;
  }

  try {
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading...";
    const flight = await uploadFlight(file);
    renderFlight(flight);
  } catch (err) {
    info.textContent = String(err?.message || err);
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = "Upload";
  }
});

playBtn.addEventListener("click", () => {
  if (currentPath.length < 2) {
    return;
  }

  if (isPlaying) {
    pausePlayback();
    return;
  }

  if (playbackProgress >= 1) {
    playbackProgress = 0;
  }

  startPlayback();
});

playbackSpeedSelect.addEventListener("change", () => {
  if (!isPlaying) {
    return;
  }
  // Keep current progress when changing speed mid-flight.
  playbackStartTs = performance.now() - playbackProgress * getPlaybackDurationMs();
});

baseViewSelect.addEventListener("change", () => {
  applyBaseView(baseViewSelect.value);
});

async function uploadFlight(file) {
  const formData = new FormData();
  formData.append("igc", file, file.name);

  const res = await fetch("/api/flight", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to parse flight: ${text}`);
  }
  return res.json();
}

function renderFlight(flight) {
  stopPlayback();

  const coords = flight.geojson.features[0].geometry.coordinates;
  currentSamples = (flight.samples || []).map((s) => ({
    lon: Number(s.lon),
    lat: Number(s.lat),
    altM: Number(s.altM),
    timeMs: new Date(s.time).getTime(),
  }));

  const start = coords[0];
  const end = coords[coords.length - 1];

  currentPath = buildAdjustedPath(coords);
  currentSegments = buildRouteSegments(currentPath, currentSamples);

  buildPathMetrics(currentPath);
  playbackProgress = 0;
  playBtn.disabled = false;
  playBtn.textContent = "Play";
  const startDetail = { position: currentPath[0], segIndex: 1, segT: 0 };
  renderDeckLayers(currentPath, {
    position: currentPath[0],
    angle: initialHeading(currentPath),
  }, startDetail, false);

  map.getSource("route-points").setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { pointType: "start" },
        geometry: { type: "Point", coordinates: start },
      },
      {
        type: "Feature",
        properties: { pointType: "end" },
        geometry: { type: "Point", coordinates: end },
      },
    ],
  });

  map.fitBounds(
    [
      [flight.bounds[0], flight.bounds[1]],
      [flight.bounds[2], flight.bounds[3]],
    ],
    { padding: 80, duration: 1200 }
  );

  renderInfo(flight);
  updateReplayStats({ speedKmh: 0, climbRateMs: 0, progress: 0, elapsedSec: 0 });
}

function renderDeckLayers(path, marker, detail, revealTrack) {
  const visibleSegments = revealTrack
    ? buildVisibleSegments(currentSegments, detail)
    : currentSegments;
  deckOverlay.setProps({
    layers: [
      new deck.PathLayer({
        id: "flight-path-3d-outline",
        data: visibleSegments,
        getPath: (d) => d.path,
        getColor: [15, 23, 42, 245],
        widthUnits: "meters",
        getWidth: 34,
        capRounded: true,
        jointRounded: true,
        billboard: false,
        parameters: { depthTest: true },
      }),
      new deck.PathLayer({
        id: "flight-path-3d",
        data: visibleSegments,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        widthUnits: "meters",
        getWidth: 24,
        capRounded: true,
        jointRounded: true,
        billboard: false,
        parameters: { depthTest: true },
      }),
      new deck.IconLayer({
        id: "flight-marker",
        data: marker ? [marker] : [],
        pickable: false,
        getPosition: (d) => d.position,
        getAngle: (d) => d.angle || 0,
        getIcon: () => paragliderIcon,
        sizeUnits: "meters",
        getSize: 95,
        sizeMinPixels: 28,
        sizeMaxPixels: 64,
        billboard: false,
        parameters: { depthTest: true },
      }),
    ],
  });
}

function createParagliderIcon() {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <path d="M8 40 C24 12, 72 12, 88 40 L80 42 C66 24, 30 24, 16 42 Z" fill="#111111"/>
  <line x1="30" y1="40" x2="46" y2="66" stroke="#dbe4f3" stroke-width="2.8"/>
  <line x1="66" y1="40" x2="50" y2="66" stroke="#dbe4f3" stroke-width="2.8"/>
  <ellipse cx="48" cy="74" rx="7" ry="9" fill="#f8fafc"/>
  <circle cx="48" cy="62" r="3.8" fill="#f8fafc"/>
  <line x1="48" y1="66" x2="48" y2="83" stroke="#f8fafc" stroke-width="2"/>
</svg>`;
  return {
    id: "paraglider",
    url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    width: 96,
    height: 96,
    anchorY: 72,
  };
}

function initialHeading(path) {
  if (!path || path.length < 2) {
    return 0;
  }
  return bearingDegrees(path[0], path[1]);
}

function markerFromDetail(detail) {
  if (!detail || !detail.position) {
    return null;
  }
  if (currentPath.length < 2) {
    return { position: detail.position, angle: 0 };
  }
  const idx = Math.min(Math.max(detail.segIndex, 1), currentPath.length - 1);
  const a = currentPath[idx - 1];
  const b = currentPath[idx];
  return {
    position: detail.position,
    angle: bearingDegrees(a, b),
  };
}

function buildAdjustedPath(path) {
  return path.map((c) => {
    const [lon, lat, alt] = c;
    let adjustedAlt = Number(alt) + ALTITUDE_VISUAL_OFFSET_M;

    if (typeof map.queryTerrainElevation === "function") {
      const terrainAlt = map.queryTerrainElevation([lon, lat], { exaggerated: false });
      if (terrainAlt !== null && terrainAlt !== undefined) {
        adjustedAlt = Math.max(adjustedAlt, terrainAlt + MIN_TERRAIN_CLEARANCE_M);
      }
    }
    return [lon, lat, adjustedAlt];
  });
}

function applyTerrain() {
  map.setTerrain(null);
  if (map.getSource("terrain-source")) {
    map.removeSource("terrain-source");
  }

  map.addSource("terrain-source", {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    tileSize: 256,
    encoding: "terrarium",
    maxzoom: 13,
  });

  map.setTerrain({ source: "terrain-source", exaggeration: TERRAIN_EXAGGERATION });
}

function applyBaseView(mode) {
  const showSatellite = mode === "satellite";
  map.setLayoutProperty("osm-base", "visibility", showSatellite ? "none" : "visible");
  map.setLayoutProperty("satellite-base", "visibility", showSatellite ? "visible" : "none");
}

function startPlayback() {
  if (currentPath.length < 2 || totalDistanceM <= 0) {
    return;
  }
  isPlaying = true;
  playBtn.textContent = "Pause";
  playbackStartTs = performance.now() - playbackProgress * getPlaybackDurationMs();
  animationFrameId = requestAnimationFrame(tickPlayback);
}

function pausePlayback() {
  isPlaying = false;
  playBtn.textContent = playbackProgress >= 1 ? "Replay" : "Play";
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function stopPlayback() {
  isPlaying = false;
  playbackProgress = 0;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  playBtn.textContent = "Play";
}

function tickPlayback(ts) {
  if (!isPlaying) {
    return;
  }

  const elapsed = ts - playbackStartTs;
  playbackProgress = clamp(elapsed / getPlaybackDurationMs(), 0, 1);
  const detail = interpolatePathDetailed(currentPath, cumulativeDistances, totalDistanceM, playbackProgress);
  renderDeckLayers(currentPath, markerFromDetail(detail), detail, true);
  updateReplayStats(computePlaybackStats(detail));
  if (isFollowCamEnabled()) {
    updateFollowCamera(detail);
  }

  if (playbackProgress >= 1) {
    isPlaying = false;
    animationFrameId = null;
    playBtn.textContent = "Replay";
    return;
  }

  animationFrameId = requestAnimationFrame(tickPlayback);
}

function buildVisiblePath(path, detail) {
  if (!Array.isArray(path) || path.length === 0) {
    return [];
  }
  if (!detail || !detail.position) {
    return [path[0]];
  }
  if (detail.segIndex >= path.length) {
    return path;
  }

  const upto = Math.max(1, Math.min(detail.segIndex, path.length - 1));
  const partial = path.slice(0, upto);
  partial.push(detail.position);
  return partial;
}

function buildRouteSegments(path, samples) {
  if (!Array.isArray(path) || path.length < 2) {
    return [];
  }

  const segMeta = [];
  const positiveClimbs = [];

  for (let i = 1; i < path.length; i++) {
    const start = path[i - 1];
    const end = path[i];
    let climbRateMs = 0;

    if (samples[i - 1] && samples[i]) {
      const dt = Math.max((samples[i].timeMs - samples[i - 1].timeMs) / 1000, 0.001);
      climbRateMs = (samples[i].altM - samples[i - 1].altM) / dt;
    }
    if (climbRateMs > 0) {
      positiveClimbs.push(climbRateMs);
    }

    segMeta.push({ path: [start, end], climbRateMs });
  }

  const highlightThreshold = quantile(positiveClimbs, 0.8);
  return segMeta.map((seg) => ({
    ...seg,
    color:
      Number.isFinite(highlightThreshold) && seg.climbRateMs >= highlightThreshold
        ? TRACK_COLOR_CLIMB
        : TRACK_COLOR_DEFAULT,
  }));
}

function buildVisibleSegments(segments, detail) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }
  if (!detail || !detail.position) {
    return [];
  }

  const fullCount = Math.max(0, Math.min(detail.segIndex - 1, segments.length));
  const visible = segments.slice(0, fullCount);

  if (detail.segIndex >= 1 && detail.segIndex <= segments.length) {
    const active = segments[detail.segIndex - 1];
    const start = active.path[0];
    visible.push({
      path: [start, detail.position],
      color: active.color,
      climbRateMs: active.climbRateMs,
    });
  }

  return visible;
}

function quantile(values, q) {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function updateFollowCamera(detail) {
  if (!detail?.position) {
    return;
  }
  const [lon, lat] = detail.position;
  map.jumpTo({
    center: [lon, lat],
  });
}

function buildPathMetrics(path) {
  cumulativeDistances = [0];
  let total = 0;

  for (let i = 1; i < path.length; i++) {
    const seg = distance3D(path[i - 1], path[i]);
    total += seg;
    cumulativeDistances.push(total);
  }

  totalDistanceM = total;
}

function interpolatePathDetailed(path, cumulative, totalDistance, progress) {
  if (path.length === 0) {
    return { position: null, segIndex: 0, segT: 0 };
  }
  if (path.length === 1 || totalDistance <= 0) {
    return { position: path[0], segIndex: 0, segT: 0 };
  }

  const target = progress * totalDistance;
  let idx = 1;
  while (idx < cumulative.length && cumulative[idx] < target) {
    idx += 1;
  }

  if (idx >= path.length) {
    return { position: path[path.length - 1], segIndex: path.length - 1, segT: 1 };
  }

  const prevDist = cumulative[idx - 1];
  const nextDist = cumulative[idx];
  const segLen = Math.max(nextDist - prevDist, 1e-6);
  const t = (target - prevDist) / segLen;
  const a = path[idx - 1];
  const b = path[idx];

  return {
    position: [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)],
    segIndex: idx,
    segT: t,
  };
}

function computePlaybackStats(detail) {
  if (!currentSamples.length || detail.segIndex <= 0 || detail.segIndex >= currentSamples.length) {
    return { speedKmh: 0, climbRateMs: 0, progress: playbackProgress, elapsedSec: 0 };
  }

  const prev = currentSamples[detail.segIndex - 1];
  const next = currentSamples[detail.segIndex];
  const dt = Math.max((next.timeMs - prev.timeMs) / 1000, 0.001);
  const horizontalM = haversineMeters(prev.lat, prev.lon, next.lat, next.lon);
  const speedKmh = (horizontalM / dt) * 3.6;
  const climbRateMs = (next.altM - prev.altM) / dt;

  const tMs = prev.timeMs + (next.timeMs - prev.timeMs) * detail.segT;
  const elapsedSec = Math.max((tMs - currentSamples[0].timeMs) / 1000, 0);

  return { speedKmh, climbRateMs, progress: playbackProgress, elapsedSec };
}

function updateReplayStats(stats) {
  const speedEl = document.getElementById("speedValue");
  const climbEl = document.getElementById("climbValue");
  const progressEl = document.getElementById("progressValue");
  const elapsedEl = document.getElementById("elapsedValue");
  if (!speedEl || !climbEl || !progressEl || !elapsedEl) {
    return;
  }

  speedEl.textContent = `${stats.speedKmh.toFixed(1)} km/h`;
  climbEl.textContent = `${stats.climbRateMs >= 0 ? "+" : ""}${stats.climbRateMs.toFixed(2)} m/s`;
  progressEl.textContent = `${(stats.progress * 100).toFixed(1)}%`;
  elapsedEl.textContent = formatDuration(stats.elapsedSec);
}

function distance3D(a, b) {
  const horizontal = haversineMeters(a[1], a[0], b[1], b[0]);
  const dz = (b[2] || 0) - (a[2] || 0);
  return Math.hypot(horizontal, dz);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearingDegrees(a, b) {
  const lon1 = a[0] * (Math.PI / 180);
  const lat1 = a[1] * (Math.PI / 180);
  const lon2 = b[0] * (Math.PI / 180);
  const lat2 = b[1] * (Math.PI / 180);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function renderInfo(flight) {
  const headers = flight.headers || {};
  const pilot = headers["FPLTPILOT"] || "Unknown";
  const glider = headers["FGTYGLIDERTYPE"] || "Unknown";
  const start = formatDate(flight.startTime);
  const end = formatDate(flight.endTime);

  info.innerHTML = `
    <div><span class="k">File:</span> <span class="v">${escapeHtml(flight.file)}</span></div>
    <div><span class="k">Pilot:</span> <span class="v">${escapeHtml(pilot)}</span></div>
    <div><span class="k">Glider:</span> <span class="v">${escapeHtml(glider)}</span></div>
    <div><span class="k">Fixes:</span> <span class="v">${flight.fixCount}</span></div>
    <div><span class="k">Start:</span> <span class="v">${escapeHtml(start)}</span></div>
    <div><span class="k">End:</span> <span class="v">${escapeHtml(end)}</span></div>
    <hr />
    <div><span class="k">Replay progress:</span> <span class="v" id="progressValue">0.0%</span></div>
    <div><span class="k">Replay elapsed:</span> <span class="v" id="elapsedValue">00:00:00</span></div>
    <div><span class="k">Speed:</span> <span class="v" id="speedValue">0.0 km/h</span></div>
    <div><span class="k">Climb rate:</span> <span class="v" id="climbValue">+0.00 m/s</span></div>
  `;
}

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getPlaybackDurationMs() {
  const speed = Number(playbackSpeedSelect?.value || "1");
  const clampedSpeed = Math.max(0.1, speed);
  return BASE_PLAYBACK_DURATION_MS / clampedSpeed;
}

function isFollowCamEnabled() {
  return (followCamSelect?.value || "on") === "on";
}

function formatDate(v) {
  if (!v) {
    return "N/A";
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    return "N/A";
  }
  return d.toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

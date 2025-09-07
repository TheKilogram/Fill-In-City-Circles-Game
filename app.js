// Basic parameters
const DIFFICULTY_RADII_M = {
  mega: 2_000_000, // 2000 km — extremely easy
  easy: 300_000,   // 300 km
  medium: 180_000, // 180 km
  hard: 100_000,   // 100 km
};

// Map init
const map = L.map('map', {
  worldCopyJump: true,
});

// Label-free basemap (Carto Light No Labels)
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 12,
  minZoom: 3,
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
}).addTo(map);

// Start centered on the US
map.setView([39.5, -98.35], 4);

// UI elements
const cityInput = document.getElementById('city-input');
const diffSelect = document.getElementById('difficulty');
const resetBtn = document.getElementById('reset-btn');

const statCircles = document.getElementById('stat-circles');
const statDots = document.getElementById('stat-dots');
const statCoverage = document.getElementById('stat-coverage');

// Datasets and indices
// CITY_DATA is provided by data/us_cities_sample.js
let cities = CITY_DATA || [];

// Build quick-lookup maps for fast matching + fuzzy correction
const norm = (s) => s.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
const labelFor = (c) => `${c.name}, ${c.state}`;
const keyFor = (c) => norm(labelFor(c));
const rkeyFor = (c) => `${c.name}|${c.state}|${c.lat}|${c.lon}`;

const cityByKey = new Map();
const cityByRKey = new Map();
const cityByName = new Map(); // norm(city name) -> array of cities (diff states)

function rebuildCityIndices() {
  cityByKey.clear();
  cityByRKey.clear();
  cityByName.clear();
  cities.forEach((c) => {
    const n = norm(c.name);
    if (!cityByName.has(n)) cityByName.set(n, []);
    cityByName.get(n).push(c);
  });
  cities.forEach((c) => {
    const key = keyFor(c);
    if (!cityByKey.has(key)) cityByKey.set(key, c);
    const rkey = rkeyFor(c);
    if (!cityByRKey.has(rkey)) cityByRKey.set(rkey, c);
  });
}

rebuildCityIndices();

// No datalist population — keep input free of suggestions for quiz mode

// Layers and state
const circlesLayer = L.layerGroup().addTo(map);
const dotsLayer = L.layerGroup().addTo(map);
const dotByKey = new Map(); // rkey -> Leaflet marker

let placedCircleCenters = []; // {lat, lon, radius, guessedKey}
let revealedCityKeys = new Set();

// Coverage estimation grid over contiguous US (finer resolution, area-weighted, land-masked)
const GRID = buildGrid({
  latMin: 24.0,
  latMax: 49.5,
  lonMin: -125.0,
  lonMax: -66.0,
  stepDeg: 0.25,
});
let coveredIdx = new Set(); // indices of GRID.points
let coveredWeight = 0; // sum of weights of covered samples

function buildGrid({ latMin, latMax, lonMin, lonMax, stepDeg }) {
  const points = [];
  const weights = [];
  let totalWeight = 0;
  const toRad = (d) => (d * Math.PI) / 180;

  // Use land polygon mask if available
  const haveMask = typeof US_LAND_POLY !== 'undefined' && US_LAND_POLY && US_LAND_POLY.coordinates;
  const maskIndex = haveMask ? buildPolyIndex(US_LAND_POLY) : null;

  for (let lat = latMin; lat <= latMax + 1e-9; lat += stepDeg) {
    const w = Math.max(0, Math.cos(toRad(lat))); // area weighting ~ cos(latitude)
    for (let lon = lonMin; lon <= lonMax + 1e-9; lon += stepDeg) {
      if (!haveMask || pointInIndexedPolys([lon, lat], maskIndex)) {
        points.push([lat, lon]);
        weights.push(w);
        totalWeight += w;
      }
    }
  }
  return { points, weights, totalWeight };
}

// Ray casting point-in-polygon for GeoJSON MultiPolygon
function pointInRing(point, ring) {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  // polygon: [outerRing, hole1, hole2, ...]
  if (!pointInRing(point, polygon[0])) return false;
  for (let k = 1; k < polygon.length; k++) {
    if (pointInRing(point, polygon[k])) return false; // inside a hole
  }
  return true;
}

function buildPolyIndex(multi) {
  const polys = multi.type === 'MultiPolygon' ? multi.coordinates : [multi.coordinates];
  return polys.map((poly) => {
    // poly: [ringOuter, hole1, ...]
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const ring of poly) {
      for (const pt of ring) {
        const x = pt[0], y = pt[1];
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { rings: poly, bbox: [minX, minY, maxX, maxY] };
  });
}

function pointInIndexedPolys(point, index) {
  const x = point[0], y = point[1];
  for (const poly of index) {
    const [minX, minY, maxX, maxY] = poly.bbox;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    if (pointInPolygon(point, poly.rings)) return true;
  }
  return false;
}

function updateStats() {
  statCircles.textContent = `Circles: ${placedCircleCenters.length}`;
  statDots.textContent = `Cities Revealed: ${revealedCityKeys.size}`;
  const pct = GRID.totalWeight ? ((coveredWeight / GRID.totalWeight) * 100) : 0;
  const pctText = pct.toFixed(1).replace(/\.0$/, '');
  statCoverage.textContent = `Map Covered: ${pctText}%`;
}

function haversineMeters(a, b) {
  // a,b are [lat, lon]
  const R = 6371e3;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

function markCoverage(center, radiusM) {
  let addedWeight = 0;
  GRID.points.forEach((p, idx) => {
    if (!coveredIdx.has(idx)) {
      const d = haversineMeters(center, p);
      if (d <= radiusM) {
        coveredIdx.add(idx);
        const w = GRID.weights[idx] || 0;
        coveredWeight += w;
        addedWeight += w;
      }
    }
  });
  return addedWeight;
}

function revealCitiesInCircle(center, radiusM, guessedKey) {
  let newCount = 0;
  for (const c of cities) {
    const d = haversineMeters(center, [c.lat, c.lon]);
    if (d <= radiusM) {
      const rkey = `${c.name}|${c.state}|${c.lat}|${c.lon}`;
      if (!revealedCityKeys.has(rkey)) {
        revealedCityKeys.add(rkey);
        newCount++;
        const dot = L.circleMarker([c.lat, c.lon], {
          radius: 3,
          color: '#6ad1ff',
          weight: 1,
          fillColor: '#3fa4ff',
          fillOpacity: 0.8,
        });
        if (guessedKey && rkey === guessedKey) {
          dot.bindTooltip(`${c.name}, ${c.state}`, { permanent: true, direction: 'top', offset: [0, -4], className: 'city-label' });
        }
        dotsLayer.addLayer(dot);
        dotByKey.set(rkey, dot);
      } else if (guessedKey && rkey === guessedKey) {
        const existing = dotByKey.get(rkey);
        if (existing && !existing.getTooltip()) {
          existing.bindTooltip(`${c.name}, ${c.state}`, { permanent: true, direction: 'top', offset: [0, -4], className: 'city-label' });
        }
      }
    }
  }
  return newCount;
}

function placeCircleForCity(city, radiusM) {
  const center = [city.lat, city.lon];
  // Check duplicate circle at (almost) same center and radius
  const dup = placedCircleCenters.some(
    (c) => Math.abs(c.lat - center[0]) < 1e-6 && Math.abs(c.lon - center[1]) < 1e-6 && Math.abs(c.radius - radiusM) < 1e-6
  );
  if (dup) return;

  const circle = L.circle(center, {
    radius: radiusM,
    color: '#ff8f6b',
    weight: 2,
    opacity: 0.9,
    fillColor: '#ff6b6b',
    fillOpacity: 0.15,
  });
  circlesLayer.addLayer(circle);

  const guessedKey = rkeyFor(city);
  placedCircleCenters.push({ lat: center[0], lon: center[1], radius: radiusM, guessedKey });
  revealCitiesInCircle(center, radiusM, guessedKey);
  markCoverage(center, radiusM);
  updateStats();
  saveProgress();
}

// Lightweight Levenshtein distance (with early exit threshold)
function editDistance(a, b, maxThresh = 4) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > maxThresh) return maxThresh + 1;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = dp[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = tmp;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > maxThresh) return maxThresh + 1;
  }
  return dp[bl];
}

function parseCityAndState(k) {
  // Try to split trailing 2-letter state
  let cityPart = k;
  let state = null;
  const m = k.match(/^(.*?)[ ,]+([a-z]{2})$/i);
  if (m) {
    cityPart = m[1].trim();
    state = m[2].toUpperCase();
  }
  return { cityPart, state };
}

function findCityByInput(value) {
  const k = norm(value);
  if (!k) return [];
  // exact label
  if (cityByKey.has(k)) return [cityByKey.get(k)];
  // Try city-name only exact
  const { cityPart, state } = parseCityAndState(k);
  if (cityByName.has(cityPart)) {
    let candidates = cityByName.get(cityPart).slice();
    if (state) candidates = candidates.filter((c) => c.state.toUpperCase() === state);
    if (candidates.length) {
      candidates.sort((a, b) => (b.pop || 0) - (a.pop || 0));
      return candidates;
    }
  }
  // Common expansions for abbreviations
  const expansions = [
    [/(^|\s)st\b/g, '$1saint'],
    [/(^|\s)ft\b/g, '$1fort'],
    [/(^|\s)mt\b/g, '$1mount'],
  ];
  let expanded = cityPart;
  for (const [re, rep] of expansions) expanded = expanded.replace(re, rep);
  if (expanded !== cityPart && cityByName.has(expanded)) {
    let candidates = cityByName.get(expanded).slice();
    if (state) candidates = candidates.filter((c) => c.state.toUpperCase() === state);
    if (candidates.length) {
      candidates.sort((a, b) => (b.pop || 0) - (a.pop || 0));
      return candidates;
    }
  }
  // As a fallback, allow startsWith on label (helps partials like "new yo")
  for (const [ckey, c] of cityByKey.entries()) {
    if (ckey.startsWith(k)) return [c];
  }
  // Fuzzy on city names: pick best nameKey under threshold; return all with that name
  let bestNameKey = null;
  let bestArr = null;
  let bestScore = Infinity;
  const base = expanded;
  const len = base.length;
  const thresh = len <= 6 ? 2 : len <= 10 ? 3 : 4;
  for (const [nameKey, arr] of cityByName.entries()) {
    const d = editDistance(base, nameKey, thresh);
    if (d <= thresh) {
      const top = arr.slice().sort((a, b) => (b.pop || 0) - (a.pop || 0))[0];
      const penalized = d - Math.min((top.pop || 0) / 1e7, 0.1);
      if (state && !arr.some((c) => c.state.toUpperCase() === state)) continue;
      if (penalized < bestScore) {
        bestScore = penalized;
        bestNameKey = nameKey;
        bestArr = arr;
      }
    }
  }
  if (bestArr) {
    let out = bestArr.slice();
    if (state) out = out.filter((c) => c.state.toUpperCase() === state);
    out.sort((a, b) => (b.pop || 0) - (a.pop || 0));
    return out;
  }
  return [];
}

function handleSubmit() {
  const raw = cityInput.value.trim();
  if (!raw) return;
  const results = findCityByInput(raw);
  if (!results || results.length === 0) {
    cityInput.classList.add('invalid');
    setTimeout(() => cityInput.classList.remove('invalid'), 600);
    return;
  }
  const radius = DIFFICULTY_RADII_M[diffSelect.value] || DIFFICULTY_RADII_M.medium;
  // Place for all matched cities; fly to the first
  results.forEach((c, i) => {
    placeCircleForCity(c, radius);
  });
  const first = results[0];
  map.flyTo([first.lat, first.lon], Math.max(6, map.getZoom()));
  cityInput.value = '';
}

cityInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSubmit();
});

resetBtn.addEventListener('click', () => {
  circlesLayer.clearLayers();
  dotsLayer.clearLayers();
  placedCircleCenters = [];
  revealedCityKeys = new Set();
  coveredIdx = new Set();
  coveredWeight = 0;
  dotByKey.clear();
  updateStats();
  try { localStorage.removeItem('uscf_progress_v1'); } catch (e) {}
});

updateStats();

// Persistence: save/load progress in localStorage (per browser)
function saveProgress() {
  try {
    const data = {
      v: 1,
      circles: placedCircleCenters.map((c) => ({ lat: c.lat, lon: c.lon, radius: c.radius, guessedKey: c.guessedKey })),
    };
    localStorage.setItem('uscf_progress_v1', JSON.stringify(data));
  } catch (e) {
    // ignore
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem('uscf_progress_v1');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.circles)) return;
    data.circles.forEach((c) => {
      let city = null;
      if (c.guessedKey && cityByRKey.has(c.guessedKey)) city = cityByRKey.get(c.guessedKey);
      if (!city) {
        // Fallback: synthesize a city object at the center
        city = { name: 'City', state: '', lat: c.lat, lon: c.lon };
      }
      placeCircleForCity(city, c.radius);
    });
  } catch (e) {
    // ignore
  }
}

// Load any existing progress after initializing layers
loadProgress();

// Dataset switching (≥50k vs ≥30k)
const popSelect = document.getElementById('pop-cutoff');
function setDatasetByCutoff(val) {
  let next = cities;
  if (val === '30k' && typeof CITY_DATA_30K !== 'undefined') next = CITY_DATA_30K;
  else if (typeof CITY_DATA !== 'undefined') next = CITY_DATA; // 50k default
  cities = next;
  rebuildCityIndices();
  // Rebuild dots based on existing circles
  dotsLayer.clearLayers();
  revealedCityKeys = new Set();
  dotByKey.clear();
  placedCircleCenters.forEach((c) => {
    const center = [c.lat, c.lon];
    revealCitiesInCircle(center, c.radius, c.guessedKey);
  });
  updateStats();
  try { localStorage.setItem('uscf_cutoff', val); } catch (e) {}
}

if (popSelect) {
  // Initialize from saved or default
  let pref = null;
  try { pref = localStorage.getItem('uscf_cutoff'); } catch (e) {}
  if (pref && (pref === '30k' || pref === '50k')) {
    popSelect.value = pref;
  }
  setDatasetByCutoff(popSelect.value);
  popSelect.addEventListener('change', () => setDatasetByCutoff(popSelect.value));
}

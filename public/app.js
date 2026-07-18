'use strict';

const ROW_H      = 76;    // must match --row-h
const REFRESH_MS = 15000;
const SOON_MINS  = 10;    // minutes threshold for "leave now"

// WMO weather code → { label, symbol (unicode text, not emoji) }
const WX_CODES = {
  0: { label: 'Clear sky',      sym: '☀' },
  1: { label: 'Mainly clear',   sym: '☀' },
  2: { label: 'Partly cloudy',  sym: '⛅' },
  3: { label: 'Overcast',       sym: '☁' },
  45:{ label: 'Foggy',          sym: '░' },
  48:{ label: 'Icy fog',        sym: '░' },
  51:{ label: 'Light drizzle',  sym: '☔' },
  53:{ label: 'Drizzle',        sym: '☔' },
  55:{ label: 'Heavy drizzle',  sym: '☔' },
  61:{ label: 'Light rain',     sym: '☔' },
  63:{ label: 'Rain',           sym: '☔' },
  65:{ label: 'Heavy rain',     sym: '☔' },
  71:{ label: 'Light snow',     sym: '❄' },
  73:{ label: 'Snow',           sym: '❄' },
  75:{ label: 'Heavy snow',     sym: '❄' },
  80:{ label: 'Showers',        sym: '☔' },
  81:{ label: 'Showers',        sym: '☔' },
  82:{ label: 'Heavy showers',  sym: '☔' },
  95:{ label: 'Thunderstorm',   sym: '⛈' },
  96:{ label: 'Thunderstorm',   sym: '⛈' },
  99:{ label: 'Thunderstorm',   sym: '⛈' },
};

// Top-down SVG bus, front (windshield) at BOTTOM (bus travels toward Manhattan = downward on screen).
function busSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 38" width="22" height="38">
    <!-- body -->
    <rect x="1" y="1.5" width="20" height="35" rx="3.5" fill="#1450c8"/>
    <!-- rear window (top) -->
    <rect x="3.5" y="3"  width="15" height="5.5" rx="1.5" fill="#5a9ce0" opacity=".85"/>
    <!-- left side windows -->
    <rect x="1.5" y="11" width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="1.5" y="17" width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="1.5" y="23" width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <!-- right side windows -->
    <rect x="16.5" y="11" width="4" height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="16.5" y="17" width="4" height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="16.5" y="23" width="4" height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <!-- front windshield (bottom) -->
    <rect x="3.5" y="29.5" width="15" height="7"  rx="2"   fill="#5a9ce0" opacity=".9"/>
    <!-- headlights -->
    <rect x="3.5" y="35" width="4"   height="1.5" rx=".5"  fill="#fff" opacity=".7"/>
    <rect x="14.5" y="35" width="4"  height="1.5" rx=".5"  fill="#fff" opacity=".7"/>
  </svg>`;
}

// ---- DOM refs ----
const els = {
  line:       document.getElementById('line'),
  direction:  document.getElementById('direction-label'),
  statusDot:  document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  updated:    document.getElementById('updated'),
  error:      document.getElementById('error'),
  banner:     document.getElementById('leave-banner'),
  bannerText: document.getElementById('leave-banner-text'),
  arrivals:   document.getElementById('arrivals-body'),
  weather:    document.getElementById('weather-body'),
  etaBody:    document.getElementById('eta-body'),
};

function setStatus(state, text) {
  els.statusDot.className = 'status-dot' + (state ? ' ' + state : '');
  els.statusText.textContent = text;
}
function showError(msg) { els.error.textContent = msg; els.error.classList.remove('hidden'); }
function clearError()   { els.error.classList.add('hidden'); }

function stopCenterY(i) { return i * ROW_H + ROW_H / 2; }

function busY(v) {
  const i = v.approachingIndex;
  if (i == null) return null;
  if (i === 0)   return stopCenterY(0);
  const frac = v.segmentFraction ?? 0;
  return stopCenterY(i - 1) + (stopCenterY(i) - stopCenterY(i - 1)) * frac;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function fmtMins(m) {
  if (m == null) return null;
  if (m <= 0)    return { text: 'Arriving', cls: 'arrvg' };
  if (m <= SOON_MINS) return { text: `${m} min`, cls: 'soon' };
  return { text: `${m} min`, cls: '' };
}

const LOAD_LABELS = {
  manySeatsAvailable:     'Many seats',
  seatsAvailable:         'Seats open',
  fewSeatsAvailable:      'Few seats',
  standingRoomOnly:       'Standing room',
  crushedStandingRoomOnly:'Very crowded',
  full:                   'Full',
};
function paxLabel(v) {
  if (v.passengerCount != null) {
    const count = v.passengerCount;
    const cap   = v.passengerCapacity;
    return cap ? `${count} / ${cap}` : `${count} riders`;
  }
  if (v.loadFactor) return LOAD_LABELS[v.loadFactor] || v.loadFactor;
  return null;
}

// ---- Manhattan ETA box ----
function renderManhattanEta(vehicles, manhattanStopName) {
  const relevant = vehicles
    .filter((v) => v.etaManhattan != null && v.etaManhattan >= -5)
    .sort((a, b) => a.etaManhattan - b.etaManhattan)
    .slice(0, 3);

  if (!relevant.length) {
    els.etaBody.innerHTML =
      `<div class="no-eta">No buses en route to Manhattan right now.</div>` +
      `<div class="eta-dest">${esc(manhattanStopName || 'Church St / Liberty St')}</div>`;
    return;
  }

  els.etaBody.innerHTML =
    relevant.map((v) => {
      const mins = Math.max(0, v.etaManhattan);
      const minsLabel = mins === 0 ? 'now' : `${mins} min`;
      const busLoc = v.atStop
        ? `at ${esc(v.nextStopName)}`
        : v.nextStopName ? `→ ${esc(v.nextStopName)}` : '';
      return `<div class="eta-row">
        <div class="eta-mins">${minsLabel}</div>
        <div class="eta-label">${busLoc}</div>
      </div>`;
    }).join('') +
    `<div class="eta-dest">${esc(manhattanStopName || 'Church St / Liberty St')}</div>`;
}

// ---- Weather (Open-Meteo, no key needed) ----
async function fetchWeather() {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=40.635&longitude=-74.030' +
      '&current=temperature_2m,weathercode,windspeed_10m,precipitation' +
      '&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=America/New_York';
    const res  = await fetch(url);
    const data = await res.json();
    const cur  = data.current;
    const wx   = WX_CODES[cur.weathercode] || { label: 'Unknown', sym: '?' };

    const tempRound = Math.round(cur.temperature_2m);
    const wind      = Math.round(cur.windspeed_10m);
    const precip    = cur.precipitation > 0 ? ` · ${cur.precipitation.toFixed(1)}" precip` : '';

    els.weather.innerHTML =
      `<div class="wx-temp">${wx.sym} ${tempRound}&deg;F</div>` +
      `<div class="wx-desc">${wx.label}</div>` +
      `<div class="wx-row">Wind ${wind} mph${precip}</div>`;
  } catch {
    els.weather.innerHTML = '<div class="cb-loading">Weather unavailable</div>';
  }
}
fetchWeather();
setInterval(fetchWeather, 5 * 60 * 1000); // refresh every 5 min

// ---- Arrivals box ----
function renderArrivals(arrivals) {
  if (!arrivals || arrivals.length === 0) {
    els.arrivals.innerHTML =
      '<div class="no-arrivals">No upcoming buses found.<br>Check back during service hours.</div>';
    return;
  }
  els.arrivals.innerHTML = arrivals.slice(0, 4).map((a) => {
    const fmt = fmtMins(a.etaMinutes);
    const minsHtml = fmt
      ? `<div class="arrival-mins ${fmt.cls}">${esc(fmt.text)}</div>`
      : `<div class="arrival-mins">&mdash;</div>`;
    const sub = a.presentableDistance
      ? esc(a.presentableDistance)
      : a.expectedArrival
        ? new Date(a.expectedArrival).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '';
    return `<div class="arrival-row">
      ${minsHtml}
      <div class="arrival-label">to 72 St<br>${sub}</div>
    </div>`;
  }).join('');
}

// ---- Main route render ----
function render(data) {
  els.direction.textContent = data.direction.label;
  clearError();
  renderArrivals(data.arrivals);
  renderManhattanEta(data.vehicles, data.manhattanStopName);

  const { myStopId, altStopId, alertStopId } = data;
  const stopIndexById = {};
  data.stops.forEach((s, i) => (stopIndexById[s.id] = i));
  const alertIdx  = alertStopId ? (stopIndexById[alertStopId] ?? -1) : -1;
  const myIdx     = myStopId    ? (stopIndexById[myStopId]    ?? -1) : -1;
  const altIdx    = altStopId   ? (stopIndexById[altStopId]   ?? -1) : -1;

  let furthestPassed = -1;
  const busAtIndex   = new Set();
  for (const v of data.vehicles) {
    if (v.approachingIndex == null) continue;
    if (v.atStop) busAtIndex.add(v.approachingIndex);
    furthestPassed = Math.max(furthestPassed, v.approachingIndex - 1);
  }

  // Leave-now banner
  const alertTriggered = data.vehicles.some((v) =>
    v.approachingIndex != null && alertIdx >= 0 &&
    v.approachingIndex >= alertIdx && v.approachingIndex <= myIdx
  );
  const nearestEtaMy = data.vehicles
    .map((v) => v.etaMyStop).filter((m) => m != null && m >= 0)
    .sort((a, b) => a - b)[0] ?? null;
  const showBanner = alertTriggered || (nearestEtaMy != null && nearestEtaMy <= SOON_MINS);

  if (showBanner) {
    els.banner.classList.remove('hidden');
    els.bannerText.textContent = nearestEtaMy != null && nearestEtaMy <= SOON_MINS
      ? `Bus arriving at 72 St in ${Math.max(0, nearestEtaMy)} min — head to the stop!`
      : 'Bus at 88 St — time to leave!';
  } else {
    els.banner.classList.add('hidden');
  }

  // Build stop list
  els.line.innerHTML = '';
  if (!data.stops.length) {
    els.line.innerHTML = '<div class="empty">No stops found for this direction.</div>';
    return;
  }

  // Hot-zone overlay: dotted box spanning alert stop → alt stop
  if (alertIdx >= 0 && altIdx >= alertIdx) {
    const zone = document.createElement('div');
    zone.className = 'hot-zone';
    zone.style.top    = `${alertIdx * ROW_H}px`;
    zone.style.height = `${(altIdx - alertIdx + 1) * ROW_H}px`;
    els.line.appendChild(zone);
  }

  data.stops.forEach((stop, i) => {
    const row = document.createElement('div');
    row.className = 'stop';
    if (i <= furthestPassed)       row.classList.add('passed');
    if (stop.id === myStopId)      row.classList.add('my-stop');
    if (stop.id === altStopId)     row.classList.add('alt-stop');
    if (stop.id === alertStopId)   row.classList.add('alert-stop');
    if (busAtIndex.has(i))         row.classList.add('bus-here');

    const dot  = document.createElement('div');
    dot.className = 'dot';

    const info = document.createElement('div');
    info.className = 'stop-info';

    const nameRow  = document.createElement('div');
    nameRow.className = 'stop-name';
    nameRow.textContent = stop.name;
    if (stop.id === myStopId) {
      const tag = document.createElement('span');
      tag.className = 'stop-tag tag-my-stop';
      tag.textContent = 'MY STOP';
      nameRow.appendChild(tag);
    } else if (stop.id === altStopId) {
      const tag = document.createElement('span');
      tag.className = 'stop-tag tag-alt-stop';
      tag.textContent = 'ALT STOP';
      nameRow.appendChild(tag);
    } else if (stop.id === alertStopId) {
      const tag = document.createElement('span');
      tag.className = 'stop-tag tag-alert-stop';
      tag.textContent = 'HEAD OUT';
      nameRow.appendChild(tag);
    }

    const sub = document.createElement('div');
    sub.className = 'stop-sub';
    const nearby = data.vehicles.find((v) => v.approachingIndex === i);
    if (nearby) {
      sub.textContent = nearby.atStop
        ? 'Bus stopped here'
        : nearby.presentableDistance
          ? `Bus ${nearby.presentableDistance}`
          : 'Bus approaching';
    }

    info.appendChild(nameRow);
    info.appendChild(sub);
    row.appendChild(dot);
    row.appendChild(info);
    els.line.appendChild(row);
  });

  // Place bus icons on the road
  data.vehicles.forEach((v) => {
    const y = busY(v);
    if (y == null) return;

    const bus = document.createElement('div');
    bus.className = 'bus';
    bus.style.top = `${y}px`;

    // SVG icon
    const iconWrap = document.createElement('div');
    iconWrap.innerHTML = busSvg();

    // Passenger bubble
    const bubble = document.createElement('div');
    bubble.className = 'bus-bubble';

    const label = paxLabel(v);
    if (label) {
      const paxEl = document.createElement('div');
      paxEl.className = 'bus-pax';
      paxEl.textContent = label;
      bubble.appendChild(paxEl);
      if (v.passengerCount != null && v.passengerCapacity) {
        const barWrap = document.createElement('div');
        barWrap.className = 'pax-bar-wrap';
        const bar = document.createElement('div');
        bar.className = 'pax-bar';
        bar.style.width = `${Math.min(100, Math.round(v.passengerCount / v.passengerCapacity * 100))}%`;
        barWrap.appendChild(bar);
        bubble.appendChild(barWrap);
      }
    }

    bus.appendChild(iconWrap);
    bus.appendChild(bubble);
    els.line.appendChild(bus);
  });

  const tracked = data.vehicles.filter((v) => v.approachingIndex != null).length;
  setStatus('live', `${tracked} bus${tracked !== 1 ? 'es' : ''} tracked`);
  els.updated.textContent = new Date(data.updatedAt).toLocaleTimeString();
}

// ---- Polling ----
async function tick() {
  try {
    const res  = await fetch('/api/data');
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    render(data);
  } catch (e) {
    setStatus('error', 'Error');
    showError(e.message);
  }
}

tick();
setInterval(tick, REFRESH_MS);

'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_KEY        = 'eea08382-e12a-4089-b6e5-1d6f2e2b401d';
const ROUTE_ID       = 'MTA NYCT_X27';
const DIR_ID         = '0';           // Manhattan-bound
const MY_STOP_ID     = 'MTA_307961'; // Shore Rd / 72 St
const MY_STOP_CODE   = '307961';
const ALT_STOP_ID    = 'MTA_300073'; // Bay Ridge Av / Colonial Rd
const ALERT_STOP_ID  = 'MTA_307958'; // Shore Rd / 88 St
const LAST_STOP_ID   = 'MTA_307078'; // 3 Av / Senator St — truncate here
const MANHATTAN_STOP = 'MTA_400071'; // Church St / Liberty St
const BASE           = 'https://bustime.mta.info';

const ROW_H     = 76;
const REFRESH   = 15000;
const SOON_MINS = 10;

// ---------------------------------------------------------------------------
// JSONP — lets the browser call the MTA API directly (no server needed)
// ---------------------------------------------------------------------------
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const id  = '_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let settled = false;

    const cleanup = () => {
      settled = true;
      delete window[id];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    window[id] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Request failed')); };
    script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + id;
    document.head.appendChild(script);

    setTimeout(() => { if (!settled) { cleanup(); reject(new Error('Timed out')); } }, 15000);
  });
}

// ---------------------------------------------------------------------------
// Helpers (ported from server.js)
// ---------------------------------------------------------------------------
function minsUntil(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso) - Date.now()) / 60000);
}

function haversine(a, b) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// MTA data fetchers (all via JSONP, run in the browser)
// ---------------------------------------------------------------------------
let _cachedGroups = null;

async function fetchStopGroups() {
  if (_cachedGroups) return _cachedGroups;
  const url = `${BASE}/api/where/stops-for-route/${encodeURIComponent(ROUTE_ID)}.json` +
    `?key=${API_KEY}&includePolylines=false&version=2`;
  const json = await jsonp(url);

  const stopsById = {};
  for (const s of (json.data?.references?.stops || []))
    stopsById[s.id] = { id: s.id, name: s.name, lat: s.lat, lon: s.lon };

  const groups = [];
  for (const grouping of (json.data?.entry?.stopGroupings || [])) {
    for (const g of (grouping.stopGroups || [])) {
      const label = g.name?.names?.[0] || `Direction ${g.id}`;
      let stops = (g.stopIds || []).map(id => stopsById[id]).filter(Boolean);
      const cut = stops.findIndex(s => s.id === LAST_STOP_ID);
      if (cut >= 0) stops = stops.slice(0, cut + 1);
      groups.push({ id: String(g.id), label, stops });
    }
  }
  _cachedGroups = groups;
  return groups;
}

async function fetchVehicles() {
  const url = `${BASE}/api/siri/vehicle-monitoring.json` +
    `?key=${API_KEY}&version=2&VehicleMonitoringDetailLevel=calls` +
    `&LineRef=${encodeURIComponent(ROUTE_ID)}&DirectionRef=${DIR_ID}`;
  const json = await jsonp(url);
  const activities = json.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];

  return activities.map(a => {
    const j    = a.MonitoredVehicleJourney || {};
    const call = j.MonitoredCall || {};
    const dist = call.Extensions?.Distances  || {};
    const caps = call.Extensions?.Capacities || {};
    const loc  = j.VehicleLocation || {};

    let etaMyStop = null, etaAlertStop = null, etaManhattan = null, etaManhattanTime = null;
    for (const c of (j.OnwardCalls?.OnwardCall || [])) {
      if (c.StopPointRef === MY_STOP_ID    && etaMyStop    == null) etaMyStop    = minsUntil(c.ExpectedArrivalTime);
      if (c.StopPointRef === ALERT_STOP_ID && etaAlertStop == null) etaAlertStop = minsUntil(c.ExpectedArrivalTime);
      if (c.StopPointRef === MANHATTAN_STOP && etaManhattan == null) {
        etaManhattan     = minsUntil(c.ExpectedArrivalTime);
        etaManhattanTime = c.ExpectedArrivalTime || null;
      }
    }
    if (call.StopPointRef === MY_STOP_ID    && etaMyStop    == null) etaMyStop    = minsUntil(call.ExpectedArrivalTime);
    if (call.StopPointRef === ALERT_STOP_ID && etaAlertStop == null) etaAlertStop = minsUntil(call.ExpectedArrivalTime);
    if (call.StopPointRef === MANHATTAN_STOP && etaManhattan == null) {
      etaManhattan     = minsUntil(call.ExpectedArrivalTime);
      etaManhattanTime = call.ExpectedArrivalTime || null;
    }

    return {
      vehicleRef:          j.VehicleRef || '',
      nextStopId:          call.StopPointRef || null,
      nextStopName:        Array.isArray(call.StopPointName) ? call.StopPointName[0] : (call.StopPointName || ''),
      presentableDistance: dist.PresentableDistance || '',
      distanceFromCall:    typeof dist.DistanceFromCall === 'number' ? dist.DistanceFromCall : null,
      lat:                 typeof loc.Latitude  === 'number' ? loc.Latitude  : null,
      lon:                 typeof loc.Longitude === 'number' ? loc.Longitude : null,
      etaMyStop, etaAlertStop, etaManhattan, etaManhattanTime,
      passengerCount:    typeof caps.EstimatedPassengerCount    === 'number' ? caps.EstimatedPassengerCount    : null,
      passengerCapacity: typeof caps.EstimatedPassengerCapacity === 'number' ? caps.EstimatedPassengerCapacity : null,
      loadFactor:        caps.EstimatedPassengerLoadFactor || j.Occupancy || null,
    };
  });
}

async function fetchArrivals() {
  const url = `${BASE}/api/siri/stop-monitoring.json` +
    `?key=${API_KEY}&version=2&MonitoringRef=${MY_STOP_CODE}` +
    `&LineRef=${encodeURIComponent(ROUTE_ID)}&MaximumStopVisits=5`;
  const json = await jsonp(url);
  const visits = json.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit || [];
  return visits.map(v => {
    const call = v.MonitoredVehicleJourney?.MonitoredCall || {};
    const dist = call.Extensions?.Distances || {};
    const eta  = call.ExpectedArrivalTime || call.AimedArrivalTime || null;
    return { expectedArrival: eta, etaMinutes: minsUntil(eta), presentableDistance: dist.PresentableDistance || '' };
  }).filter(v => v.expectedArrival != null);
}

function placeVehicles(vehicles, stops) {
  const indexById = {};
  stops.forEach((s, i) => (indexById[s.id] = i));

  return vehicles.map(v => {
    const targetIndex = v.nextStopId != null ? indexById[v.nextStopId] : undefined;
    let segmentFraction = 0, atStop = false;

    if (typeof targetIndex === 'number') {
      if ((v.presentableDistance || '').toLowerCase().includes('at stop')) {
        atStop = true; segmentFraction = 1;
      } else if (targetIndex > 0) {
        const prev = stops[targetIndex - 1], curr = stops[targetIndex];
        const segLen = haversine(prev, curr);
        if (v.distanceFromCall != null && segLen > 0) {
          segmentFraction = Math.min(1, Math.max(0, (segLen - v.distanceFromCall) / segLen));
        } else if (v.lat != null && v.lon != null && segLen > 0) {
          segmentFraction = Math.min(1, Math.max(0, (segLen - haversine({lat:v.lat,lon:v.lon}, curr)) / segLen));
        }
      }
    }
    return Object.assign({}, v, {
      approachingIndex: typeof targetIndex === 'number' ? targetIndex : null,
      segmentFraction, atStop,
    });
  });
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
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
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function stopCenterY(i) { return i * ROW_H + ROW_H / 2; }
function busY(v) {
  const i = v.approachingIndex;
  if (i == null) return null;
  if (i === 0)   return stopCenterY(0);
  const frac = v.segmentFraction ?? 0;
  return stopCenterY(i-1) + (stopCenterY(i) - stopCenterY(i-1)) * frac;
}

function fmtMins(m) {
  if (m == null) return null;
  if (m <= 0) return { text: 'Arriving', cls: 'arrvg' };
  if (m <= SOON_MINS) return { text: `${m} min`, cls: 'soon' };
  return { text: `${m} min`, cls: '' };
}

const LOAD_LABELS = {
  manySeatsAvailable:'Many seats', seatsAvailable:'Seats open',
  fewSeatsAvailable:'Few seats',   standingRoomOnly:'Standing room',
  crushedStandingRoomOnly:'Very crowded', full:'Full',
};
function paxLabel(v) {
  if (v.passengerCount != null)
    return v.passengerCapacity ? `${v.passengerCount} / ${v.passengerCapacity}` : `${v.passengerCount} riders`;
  if (v.loadFactor) return LOAD_LABELS[v.loadFactor] || v.loadFactor;
  return null;
}

function busSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 38" width="22" height="38">
    <rect x="1" y="1.5" width="20" height="35" rx="3.5" fill="#1450c8"/>
    <rect x="3.5" y="3"    width="15" height="5.5" rx="1.5" fill="#5a9ce0" opacity=".85"/>
    <rect x="1.5" y="11"   width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="1.5" y="17"   width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="1.5" y="23"   width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="16.5" y="11"  width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="16.5" y="17"  width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="16.5" y="23"  width="4"  height="4.5" rx="1"   fill="#5a9ce0" opacity=".75"/>
    <rect x="3.5" y="29.5" width="15" height="7"   rx="2"   fill="#5a9ce0" opacity=".9"/>
    <rect x="3.5" y="35"   width="4"  height="1.5" rx=".5"  fill="#fff"    opacity=".7"/>
    <rect x="14.5" y="35"  width="4"  height="1.5" rx=".5"  fill="#fff"    opacity=".7"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo — has CORS, no key needed)
// ---------------------------------------------------------------------------
const WX = {
  0:{l:'Clear',s:'☀'}, 1:{l:'Mainly clear',s:'☀'}, 2:{l:'Partly cloudy',s:'⛅'},
  3:{l:'Overcast',s:'☁'}, 45:{l:'Foggy',s:'░'}, 48:{l:'Icy fog',s:'░'},
  51:{l:'Light drizzle',s:'☔'}, 53:{l:'Drizzle',s:'☔'}, 55:{l:'Heavy drizzle',s:'☔'},
  61:{l:'Light rain',s:'☔'}, 63:{l:'Rain',s:'☔'}, 65:{l:'Heavy rain',s:'☔'},
  71:{l:'Light snow',s:'❄'}, 73:{l:'Snow',s:'❄'}, 75:{l:'Heavy snow',s:'❄'},
  80:{l:'Showers',s:'☔'}, 81:{l:'Showers',s:'☔'}, 82:{l:'Heavy showers',s:'☔'},
  95:{l:'Thunderstorm',s:'⛈'}, 96:{l:'Thunderstorm',s:'⛈'}, 99:{l:'Thunderstorm',s:'⛈'},
};

async function fetchWeather() {
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=40.635&longitude=-74.030' +
      '&current=temperature_2m,weathercode,windspeed_10m,precipitation' +
      '&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=America/New_York');
    const d = await r.json();
    const c = d.current, wx = WX[c.weathercode] || {l:'Unknown', s:'?'};
    const precip = c.precipitation > 0 ? ` · ${c.precipitation.toFixed(1)}" precip` : '';
    els.weather.innerHTML =
      `<div class="wx-temp">${wx.s} ${Math.round(c.temperature_2m)}&deg;F</div>` +
      `<div class="wx-desc">${wx.l}</div>` +
      `<div class="wx-row">Wind ${Math.round(c.windspeed_10m)} mph${precip}</div>`;
  } catch { els.weather.innerHTML = '<div class="cb-loading">Unavailable</div>'; }
}
fetchWeather();
setInterval(fetchWeather, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Arrivals box
// ---------------------------------------------------------------------------
function renderArrivals(arrivals) {
  if (!arrivals || !arrivals.length) {
    els.arrivals.innerHTML = '<div class="no-arrivals">No upcoming buses.<br>Check back during service hours.</div>';
    return;
  }
  els.arrivals.innerHTML = arrivals.slice(0, 4).map(a => {
    const fmt = fmtMins(a.etaMinutes);
    const minsHtml = fmt
      ? `<div class="arrival-mins ${fmt.cls}">${esc(fmt.text)}</div>`
      : `<div class="arrival-mins">&mdash;</div>`;
    const sub = a.presentableDistance || (a.expectedArrival
      ? new Date(a.expectedArrival).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : '');
    return `<div class="arrival-row">${minsHtml}<div class="arrival-label">to 72 St<br>${esc(sub)}</div></div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Manhattan ETA box
// ---------------------------------------------------------------------------
function renderManhattanEta(vehicles) {
  const rows = vehicles
    .filter(v => v.etaManhattan != null && v.etaManhattan >= -5)
    .sort((a, b) => a.etaManhattan - b.etaManhattan)
    .slice(0, 3);
  if (!rows.length) {
    els.etaBody.innerHTML = '<div class="no-eta">No buses en route to Manhattan.</div>' +
      '<div class="eta-dest">Church St / Liberty St</div>';
    return;
  }
  els.etaBody.innerHTML = rows.map(v => {
    const mins = Math.max(0, v.etaManhattan);
    const busLoc = v.atStop ? `at ${esc(v.nextStopName)}` : v.nextStopName ? `→ ${esc(v.nextStopName)}` : '';
    const arrTime = v.etaManhattanTime
      ? new Date(v.etaManhattanTime).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})
      : null;
    const timeStr = arrTime
      ? `${arrTime} <span class="eta-paren">(${mins === 0 ? 'now' : mins + ' min'})</span>`
      : (mins === 0 ? 'now' : mins + ' min');
    return `<div class="eta-row"><div class="eta-mins">${timeStr}</div><div class="eta-label">${busLoc}</div></div>`;
  }).join('') + '<div class="eta-dest">Church St / Liberty St</div>';
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------
function render(data) {
  els.direction.textContent = data.direction.label;
  clearError();
  renderArrivals(data.arrivals);
  renderManhattanEta(data.vehicles);

  const stopIndexById = {};
  data.stops.forEach((s, i) => (stopIndexById[s.id] = i));
  const alertIdx = stopIndexById[ALERT_STOP_ID] ?? -1;
  const myIdx    = stopIndexById[MY_STOP_ID]    ?? -1;
  const altIdx   = stopIndexById[ALT_STOP_ID]   ?? -1;

  let furthestPassed = -1;
  const busAtIndex = new Set();
  for (const v of data.vehicles) {
    if (v.approachingIndex == null) continue;
    if (v.atStop) busAtIndex.add(v.approachingIndex);
    furthestPassed = Math.max(furthestPassed, v.approachingIndex - 1);
  }

  // Leave-now banner
  const alertTriggered = data.vehicles.some(v =>
    v.approachingIndex != null && alertIdx >= 0 &&
    v.approachingIndex >= alertIdx && v.approachingIndex <= myIdx);
  const nearestEta = data.vehicles.map(v => v.etaMyStop).filter(m => m != null && m >= 0).sort((a,b)=>a-b)[0] ?? null;
  const showBanner = alertTriggered || (nearestEta != null && nearestEta <= SOON_MINS);
  if (showBanner) {
    els.banner.classList.remove('hidden');
    els.bannerText.textContent = nearestEta != null && nearestEta <= SOON_MINS
      ? `Bus arriving at 72 St in ${Math.max(0,nearestEta)} min — head to the stop!`
      : 'Bus at 88 St — time to leave!';
  } else {
    els.banner.classList.add('hidden');
  }

  // Build stop list
  els.line.innerHTML = '';
  if (!data.stops.length) {
    els.line.innerHTML = '<div class="empty">No stops found.</div>';
    return;
  }

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
    if (stop.id === MY_STOP_ID)    row.classList.add('my-stop');
    if (stop.id === ALT_STOP_ID)   row.classList.add('alt-stop');
    if (stop.id === ALERT_STOP_ID) row.classList.add('alert-stop');
    if (busAtIndex.has(i))         row.classList.add('bus-here');

    const dot  = document.createElement('div'); dot.className = 'dot';
    const info = document.createElement('div'); info.className = 'stop-info';
    const nameRow = document.createElement('div'); nameRow.className = 'stop-name';
    nameRow.textContent = stop.name;

    const tagDef = stop.id === MY_STOP_ID    ? ['stop-tag tag-my-stop',   'MY STOP'] :
                   stop.id === ALT_STOP_ID   ? ['stop-tag tag-alt-stop',  'ALT STOP'] :
                   stop.id === ALERT_STOP_ID ? ['stop-tag tag-alert-stop','HEAD OUT'] : null;
    if (tagDef) {
      const tag = document.createElement('span');
      tag.className = tagDef[0]; tag.textContent = tagDef[1];
      nameRow.appendChild(tag);
    }

    const sub = document.createElement('div'); sub.className = 'stop-sub';
    const nearby = data.vehicles.find(v => v.approachingIndex === i);
    if (nearby) sub.textContent = nearby.atStop ? 'Bus stopped here' :
      nearby.presentableDistance ? `Bus ${nearby.presentableDistance}` : 'Bus approaching';

    info.appendChild(nameRow); info.appendChild(sub);
    row.appendChild(dot); row.appendChild(info);
    els.line.appendChild(row);
  });

  // Bus icons
  data.vehicles.forEach(v => {
    const y = busY(v);
    if (y == null) return;
    const bus = document.createElement('div');
    bus.className = 'bus'; bus.style.top = `${y}px`;
    const iconWrap = document.createElement('div'); iconWrap.innerHTML = busSvg();
    const bubble   = document.createElement('div'); bubble.className = 'bus-bubble';
    const label = paxLabel(v);
    if (label) {
      const paxEl = document.createElement('div'); paxEl.className = 'bus-pax'; paxEl.textContent = label;
      bubble.appendChild(paxEl);
      if (v.passengerCount != null && v.passengerCapacity) {
        const wrap = document.createElement('div'); wrap.className = 'pax-bar-wrap';
        const bar  = document.createElement('div'); bar.className = 'pax-bar';
        bar.style.width = `${Math.min(100, Math.round(v.passengerCount / v.passengerCapacity * 100))}%`;
        wrap.appendChild(bar); bubble.appendChild(wrap);
      }
    }
    bus.appendChild(iconWrap); bus.appendChild(bubble);
    els.line.appendChild(bus);
  });

  const tracked = data.vehicles.filter(v => v.approachingIndex != null).length;
  setStatus('live', `${tracked} bus${tracked !== 1 ? 'es' : ''} tracked`);
  els.updated.textContent = new Date(data.updatedAt).toLocaleTimeString();
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------
async function tick() {
  try {
    const groups = await fetchStopGroups();
    const group  = groups.find(g => g.id === DIR_ID) || groups[0];
    const [vehicles, arrivals] = await Promise.all([
      fetchVehicles(),
      fetchArrivals().catch(() => []),
    ]);
    const placed = placeVehicles(vehicles, group.stops);
    render({
      direction:        { id: group.id, label: group.label },
      stops:            group.stops.map(s => ({ id: s.id, name: s.name })),
      vehicles:         placed,
      arrivals,
      updatedAt:        new Date().toISOString(),
    });
  } catch (e) {
    setStatus('error', 'Error');
    showError(e.message);
  }
}

tick();
setInterval(tick, REFRESH);

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const PORT       = process.env.PORT || 3000;
const API_KEY    = process.env.MTA_API_KEY;
const ROUTE_ID   = 'MTA NYCT_X27';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MY_STOP_ID        = 'MTA_307961'; // Shore Rd / 72 St       — primary boarding stop
const MY_STOP_CODE      = '307961';     // numeric code for stop-monitoring endpoint
const ALT_STOP_ID       = 'MTA_300073'; // Bay Ridge Av / Colonial Rd — alt boarding stop
const ALERT_STOP_ID     = 'MTA_307958'; // Shore Rd / 88 St       — "leave now" trigger
const LAST_STOP_ID      = 'MTA_307078'; // 3 Av / Senator St      — nothing shown past here
const MANHATTAN_STOP_ID = 'MTA_400071'; // Church St / Liberty St — 3rd Manhattan stop

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function getJSON(urlString, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = new URL(urlString).protocol === 'http:' ? http : https;
    const req = mod.get(urlString, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        return resolve(getJSON(new URL(res.headers.location, urlString).toString(), redirectsLeft - 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`Upstream ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Upstream timed out')));
  });
}

function haversine(a, b) {
  const R   = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function minsUntil(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso) - Date.now()) / 60000);
}

// ---------------------------------------------------------------------------
// MTA data fetchers
// ---------------------------------------------------------------------------
async function fetchStopGroups() {
  const url =
    `https://bustime.mta.info/api/where/stops-for-route/${encodeURIComponent(ROUTE_ID)}.json` +
    `?key=${encodeURIComponent(API_KEY)}&includePolylines=false&version=2`;
  const json = await getJSON(url);

  const stopsById = {};
  for (const s of (json.data?.references?.stops || []))
    stopsById[s.id] = { id: s.id, name: s.name, lat: s.lat, lon: s.lon };

  const groups = [];
  for (const grouping of (json.data?.entry?.stopGroupings || [])) {
    for (const g of (grouping.stopGroups || [])) {
      const label = g.name?.names?.[0] || `Direction ${g.id}`;
      let stops = (g.stopIds || []).map((id) => stopsById[id]).filter(Boolean);
      // Truncate at Senator St — don't show Manhattan stops.
      const cut = stops.findIndex((s) => s.id === LAST_STOP_ID);
      if (cut >= 0) stops = stops.slice(0, cut + 1);
      groups.push({ id: String(g.id), label, stops });
    }
  }
  return groups;
}

async function fetchVehicles(directionId) {
  const url =
    `https://bustime.mta.info/api/siri/vehicle-monitoring.json` +
    `?key=${encodeURIComponent(API_KEY)}&version=2` +
    `&VehicleMonitoringDetailLevel=calls` +
    `&LineRef=${encodeURIComponent(ROUTE_ID)}` +
    `&DirectionRef=${encodeURIComponent(directionId)}`;
  const json = await getJSON(url);
  const activities = json.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];

  return activities.map((a) => {
    const j    = a.MonitoredVehicleJourney || {};
    const call = j.MonitoredCall || {};
    const dist = call.Extensions?.Distances   || {};
    const caps = call.Extensions?.Capacities  || {};
    const loc  = j.VehicleLocation || {};

    let etaMyStop = null, etaAlertStop = null, etaManhattan = null;
    for (const c of (j.OnwardCalls?.OnwardCall || [])) {
      if (c.StopPointRef === MY_STOP_ID        && etaMyStop    == null) etaMyStop    = minsUntil(c.ExpectedArrivalTime);
      if (c.StopPointRef === ALERT_STOP_ID     && etaAlertStop == null) etaAlertStop = minsUntil(c.ExpectedArrivalTime);
      if (c.StopPointRef === MANHATTAN_STOP_ID && etaManhattan == null) etaManhattan = minsUntil(c.ExpectedArrivalTime);
    }
    if (call.StopPointRef === MY_STOP_ID        && etaMyStop    == null) etaMyStop    = minsUntil(call.ExpectedArrivalTime);
    if (call.StopPointRef === ALERT_STOP_ID     && etaAlertStop == null) etaAlertStop = minsUntil(call.ExpectedArrivalTime);
    if (call.StopPointRef === MANHATTAN_STOP_ID && etaManhattan == null) etaManhattan = minsUntil(call.ExpectedArrivalTime);

    return {
      vehicleRef:          j.VehicleRef || '',
      nextStopId:          call.StopPointRef || null,
      nextStopName:        Array.isArray(call.StopPointName) ? call.StopPointName[0] : (call.StopPointName || ''),
      presentableDistance: dist.PresentableDistance || '',
      distanceFromCall:    typeof dist.DistanceFromCall === 'number' ? dist.DistanceFromCall : null,
      lat:                 typeof loc.Latitude  === 'number' ? loc.Latitude  : null,
      lon:                 typeof loc.Longitude === 'number' ? loc.Longitude : null,
      expectedArrival:     call.ExpectedArrivalTime || null,
      etaMyStop,
      etaAlertStop,
      etaManhattan,
      passengerCount:    typeof caps.EstimatedPassengerCount    === 'number' ? caps.EstimatedPassengerCount    : null,
      passengerCapacity: typeof caps.EstimatedPassengerCapacity === 'number' ? caps.EstimatedPassengerCapacity : null,
      loadFactor:        caps.EstimatedPassengerLoadFactor || j.Occupancy || null,
    };
  });
}

// Next X27 arrivals at the user's stop (72nd St).
async function fetchArrivals() {
  const url =
    `https://bustime.mta.info/api/siri/stop-monitoring.json` +
    `?key=${encodeURIComponent(API_KEY)}&version=2` +
    `&MonitoringRef=${MY_STOP_CODE}` +
    `&LineRef=${encodeURIComponent(ROUTE_ID)}` +
    `&MaximumStopVisits=5`;
  const json = await getJSON(url);
  const visits = json.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit || [];
  return visits.map((v) => {
    const call = v.MonitoredVehicleJourney?.MonitoredCall || {};
    const dist = call.Extensions?.Distances || {};
    const eta  = call.ExpectedArrivalTime || call.AimedArrivalTime || null;
    return {
      expectedArrival:     eta,
      etaMinutes:          minsUntil(eta),
      presentableDistance: dist.PresentableDistance || '',
    };
  }).filter((v) => v.expectedArrival != null);
}

function chooseGroup(groups, requestedId) {
  if (requestedId) return groups.find((g) => g.id === requestedId) || groups[0];
  return groups.find((g) => g.id === '0') || groups[0]; // direction 0 = Manhattan-bound
}

function placeVehicles(vehicles, stops) {
  const indexById = {};
  stops.forEach((s, i) => (indexById[s.id] = i));

  return vehicles.map((v) => {
    const targetIndex = v.nextStopId != null ? indexById[v.nextStopId] : undefined;
    let segmentFraction = 0, atStop = false;

    if (typeof targetIndex === 'number') {
      if ((v.presentableDistance || '').toLowerCase().includes('at stop')) {
        atStop = true; segmentFraction = 1;
      } else if (targetIndex > 0) {
        const prev = stops[targetIndex - 1];
        const curr = stops[targetIndex];
        const segLen = haversine(prev, curr);
        if (v.distanceFromCall != null && segLen > 0) {
          segmentFraction = Math.min(1, Math.max(0, (segLen - v.distanceFromCall) / segLen));
        } else if (v.lat != null && v.lon != null && segLen > 0) {
          const dToCurr = haversine({ lat: v.lat, lon: v.lon }, curr);
          segmentFraction = Math.min(1, Math.max(0, (segLen - dToCurr) / segLen));
        }
      }
    }

    return Object.assign({}, v, {
      approachingIndex: typeof targetIndex === 'number' ? targetIndex : null,
      segmentFraction,
      atStop,
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

function serveStatic(req, res) {
  let pn = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pn === '/') pn = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(pn));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
}

async function handleData(req, res) {
  if (!API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MTA_API_KEY is not set.' }));
    return;
  }
  try {
    const reqId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('dir');
    const groups = await fetchStopGroups();
    if (!groups.length) throw new Error('No stops returned for X27.');
    const group = chooseGroup(groups, reqId);

    const [vehicles, arrivals] = await Promise.all([
      fetchVehicles(group.id),
      fetchArrivals().catch(() => []),
    ]);
    const placed = placeVehicles(vehicles, group.stops);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      route: 'X27',
      updatedAt: new Date().toISOString(),
      direction: { id: group.id, label: group.label },
      directions: groups.map((g) => ({ id: g.id, label: g.label })),
      stops: group.stops.map((s) => ({ id: s.id, name: s.name })),
      vehicles: placed,
      arrivals,
      myStopId:          MY_STOP_ID,
      altStopId:         ALT_STOP_ID,
      alertStopId:       ALERT_STOP_ID,
      manhattanStopName: 'Church St / Liberty St',
    }));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer((req, res) => {
  const pn = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pn === '/api/data') return handleData(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`X27 Bus Tracker → http://localhost:${PORT}`);
  if (!API_KEY) console.log('  WARNING: MTA_API_KEY not set.\n');
});

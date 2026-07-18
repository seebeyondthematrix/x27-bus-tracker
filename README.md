# X27 Bus Tracker

A live tracker for the MTA **X27** express bus. Stops are drawn as a vertical
line of dots cascading down; each live bus rides **between the dots** as it
approaches a stop and sits **on the dot** when it's at the stop.

## What you need to do outside this terminal

The MTA's live bus data requires a free API key. This is the only manual step.

1. Go to **https://register.developer.obanyc.com/**
2. Fill in the short form (name + email). It's free and approval is instant.
3. Check your email for the **API key** (a long string of letters/numbers).

That key lets the app read MTA Bus Time. Keep it private — the app only uses it
on the server, never in the browser.

## Running the app

From this folder:

```bash
MTA_API_KEY=paste_your_key_here node server.js
```

Then open **http://localhost:3000** in your browser.

To avoid pasting the key every time, export it once per terminal session:

```bash
export MTA_API_KEY=paste_your_key_here
node server.js
```

## How it works

- `server.js` — a zero-dependency Node server. It calls two MTA endpoints:
  - `stops-for-route` → the ordered list of X27 stops (Bay Ridge-bound by default)
  - `vehicle-monitoring` → live bus positions + distance to the next stop
  It combines them into `/api/data`, keeping your key server-side.
- `public/` — the interface. It polls `/api/data` every 15 seconds and places
  each bus along the dotted line using the distance to its next stop.

## Notes

- Late nights / off-hours: if no X27 buses are running, the line still shows all
  stops but no bus marker — that's expected.
- Default direction is **toward Bay Ridge**. To view the other direction, open
  `http://localhost:3000/api/data?dir=1` to see the direction ids, or change the
  default in `chooseGroup()` in `server.js`.
- No `npm install` needed — it uses only Node's built-in modules.

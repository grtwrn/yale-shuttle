#!/usr/bin/env node
/**
 * shuttle-map — Live ASCII map of Yale shuttle positions
 *
 * Usage:
 *   node services/shuttle-map/map.mjs            # live refresh (default)
 *   node services/shuttle-map/map.mjs --once      # single frame
 *   node services/shuttle-map/map.mjs --interval 5 # refresh every 5s
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.SHUTTLE_DB || path.resolve(
  process.env.SHUTTLE_DB_DIR || path.join(process.cwd(), 'store'),
  'shuttle.db',
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const COLS = 72;
const ROWS = 32;
const HOME_STOPS = [3, 4, 106, 107, 164]; // Canner & Prospect

// Map bounds — covers main campus + Science Hill + med school area
const MAP_MIN_LAT = 41.298;
const MAP_MAX_LAT = 41.326;
const MAP_MIN_LON = -72.945;
const MAP_MAX_LON = -72.910;

// ANSI color codes
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  blink:   '\x1b[5m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgBlack: '\x1b[40m',
  orange:  '\x1b[38;5;208m',
  brown:   '\x1b[38;5;130m',
  pink:    '\x1b[38;5;213m',
  gold:    '\x1b[38;5;220m',
  purple:  '\x1b[38;5;135m',
  grey:    '\x1b[38;5;242m',
};

// Route colors by route_id
const ROUTE_COLORS = {
  1:  C.blue,     // Blue Weekday
  2:  C.orange,   // Orange Weekday
  3:  C.red,      // Red Weekday
  4:  C.blue,     // Blue Weekend
  8:  C.pink,     // Pink VA/Med School
  9:  C.green,    // Green West Campus
  10: C.purple,   // Purple West Campus
  13: C.blue,     // Blue Night
  14: C.orange,   // Orange Night
  15: C.gold,     // Gold
  16: C.blue,     // Blue West Night
  17: C.orange,   // Orange East Night
  19: C.brown,    // Brown Connector
};

// Directional arrows based on heading
function headingArrow(heading) {
  if (heading >= 337.5 || heading < 22.5) return '↑';
  if (heading < 67.5)  return '↗';
  if (heading < 112.5) return '→';
  if (heading < 157.5) return '↘';
  if (heading < 202.5) return '↓';
  if (heading < 247.5) return '↙';
  if (heading < 292.5) return '←';
  return '↖';
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

function latToRow(lat) {
  return Math.round((MAP_MAX_LAT - lat) / (MAP_MAX_LAT - MAP_MIN_LAT) * (ROWS - 1));
}

function lonToCol(lon) {
  return Math.round((lon - MAP_MIN_LON) / (MAP_MAX_LON - MAP_MIN_LON) * (COLS - 1));
}

// ---------------------------------------------------------------------------
// Render a frame
// ---------------------------------------------------------------------------

function render() {
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch {
    return `${C.red}Error: shuttle.db not found at ${DB_PATH}${C.reset}\n` +
           'Is the shuttle-collector running?';
  }

  // Build the grid — each cell is { char, color, layer }
  // layer: 0=background, 1=stop, 2=home, 3=bus
  const grid = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({ char: ' ', color: '', layer: 0 })),
  );

  function setCell(row, col, char, color = '', layer = 1) {
    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return;
    if (grid[row][col].layer > layer) return; // don't overwrite higher-priority items
    grid[row][col] = { char, color, layer };
  }

  // --- Draw stops ---
  const stops = db.prepare('SELECT id, name, lat, lon FROM stops').all();
  for (const s of stops) {
    const r = latToRow(s.lat);
    const c = lonToCol(s.lon);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
    if (HOME_STOPS.includes(s.id)) {
      setCell(r, c, '◆', `${C.bold}${C.green}`, 2);
    } else {
      setCell(r, c, '·', C.grey, 1);
    }
  }

  // --- Draw buses ---
  const buses = db.prepare(`
    WITH latest AS (
      SELECT bp.bus_id, bp.bus_name, bp.route_id, bp.lat, bp.lon, bp.heading,
             bp.last_stop_id, bp.collected_at,
             ROW_NUMBER() OVER (PARTITION BY bp.bus_id ORDER BY bp.collected_at DESC) as rn
      FROM bus_positions bp
      WHERE bp.collected_at > datetime('now', '-2 minutes')
    )
    SELECT l.bus_id, l.bus_name, l.route_id, l.lat, l.lon, l.heading,
           l.last_stop_id, l.collected_at,
           r.name as route_name, s.name as stop_name
    FROM latest l
    LEFT JOIN routes r ON r.id = l.route_id
    LEFT JOIN stops s ON s.id = l.last_stop_id
    WHERE l.rn = 1
    ORDER BY l.route_id, l.bus_name
  `).all();

  const busLegend = [];

  for (const bus of buses) {
    const r = latToRow(bus.lat);
    const c = lonToCol(bus.lon);
    const color = ROUTE_COLORS[bus.route_id] || C.white;
    const arrow = headingArrow(bus.heading);

    // Place bus marker on grid
    setCell(r, c, arrow, `${C.bold}${color}`, 3);

    // Build legend entry
    const routeName = (bus.route_name || `Route ${bus.route_id}`)
      .replace(' - Weekday Daytime', '')
      .replace(' - Weekend Daytime', ' Wknd')
      .replace(' - Night', ' Night');
    const stopName = bus.stop_name || '?';
    const ageS = Math.round((Date.now() - new Date(bus.collected_at + (bus.collected_at.endsWith('Z') ? '' : 'Z')).getTime()) / 1000);
    busLegend.push({
      color,
      arrow,
      name: bus.bus_name,
      route: routeName,
      stop: stopName,
      age: ageS,
    });
  }

  db.close();

  // --- Render to string ---
  const lines = [];

  // Title bar
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const title = ` Yale Shuttle Tracker `;
  const pad = Math.max(0, COLS - title.length - timeStr.length - 4);
  lines.push(`${C.bold}${C.bgBlack}${C.cyan}╔${'═'.repeat(COLS + 2)}╗${C.reset}`);
  lines.push(`${C.bold}${C.bgBlack}${C.cyan}║ ${C.white}${title}${' '.repeat(pad)}${C.dim}${timeStr}  ${C.bold}${C.cyan}║${C.reset}`);
  lines.push(`${C.bold}${C.bgBlack}${C.cyan}╠${'═'.repeat(COLS + 2)}╣${C.reset}`);

  // Grid
  for (let r = 0; r < ROWS; r++) {
    let line = `${C.bgBlack}${C.cyan}║${C.reset}${C.bgBlack} `;
    for (let c = 0; c < COLS; c++) {
      const cell = grid[r][c];
      line += `${cell.color}${cell.char}${C.reset}${C.bgBlack}`;
    }
    line += ` ${C.cyan}║${C.reset}`;
    lines.push(line);
  }

  lines.push(`${C.bold}${C.bgBlack}${C.cyan}╠${'═'.repeat(COLS + 2)}╣${C.reset}`);

  // Legend
  const legendTitle = ` ${C.green}◆${C.white} = Home stops    ${C.grey}·${C.white} = Other stops    ${C.bold}↑${C.reset}${C.bgBlack}${C.white} = Bus (heading)`;
  lines.push(`${C.bgBlack}${C.cyan}║${C.white} ${legendTitle}${' '.repeat(Math.max(0, COLS - 53))} ${C.cyan}║${C.reset}`);
  lines.push(`${C.bgBlack}${C.cyan}╠${'═'.repeat(COLS + 2)}╣${C.reset}`);

  if (busLegend.length === 0) {
    const msg = 'No active buses right now';
    const lpad = Math.floor((COLS - msg.length) / 2);
    lines.push(`${C.bgBlack}${C.cyan}║${C.dim} ${' '.repeat(lpad)}${msg}${' '.repeat(COLS - lpad - msg.length)} ${C.cyan}${C.bold}║${C.reset}`);
  } else {
    for (const b of busLegend) {
      const entry = `${b.color}${b.arrow} ${b.name}${C.reset}${C.bgBlack}  ${C.white}${b.route.padEnd(18)}${C.dim} near ${b.stop.slice(0, 22)}${C.reset}${C.bgBlack}`;
      // Calculate visible length (without ANSI codes)
      const visLen = `${b.arrow} ${b.name}  ${b.route.padEnd(18)} near ${b.stop.slice(0, 22)}`.length;
      const rpad = Math.max(0, COLS - visLen);
      lines.push(`${C.bgBlack}${C.cyan}║${C.reset}${C.bgBlack} ${entry}${' '.repeat(rpad)} ${C.bold}${C.cyan}║${C.reset}`);
    }
  }

  lines.push(`${C.bold}${C.bgBlack}${C.cyan}╚${'═'.repeat(COLS + 2)}╝${C.reset}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const once = args.includes('--once');
let interval = 3;
const iIdx = args.indexOf('--interval');
if (iIdx >= 0 && args[iIdx + 1]) interval = Number(args[iIdx + 1]);

if (once) {
  console.log(render());
} else {
  // Live mode: clear screen and redraw
  const clear = '\x1b[2J\x1b[H';
  const hideCursor = '\x1b[?25l';
  const showCursor = '\x1b[?25h';

  process.stdout.write(hideCursor);
  process.on('SIGINT', () => {
    process.stdout.write(showCursor + '\n');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    process.stdout.write(showCursor + '\n');
    process.exit(0);
  });

  const tick = () => {
    process.stdout.write(clear + render() + '\n');
  };

  tick();
  setInterval(tick, interval * 1000);
}

#!/usr/bin/env node
/**
 * Yale Shuttle — Transit Schematic Map
 *
 * Clean, minimal transit map with pulsing live bus markers.
 * Inspired by Boston T / HK MTR map aesthetics.
 *
 * Usage:  shuttle-map | node services/shuttle-map/transit.mjs
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.SHUTTLE_DB || path.resolve(
  process.env.SHUTTLE_DB_DIR || path.join(process.cwd(), 'store'),
  'shuttle.db',
);

// ── ANSI ──────────────────────────────────────────────────────────────────
const A = {
  reset: '\x1b[0m',   bold: '\x1b[1m',    dim: '\x1b[2m',
  red: '\x1b[91m',    green: '\x1b[32m',   blue: '\x1b[94m',
  cyan: '\x1b[96m',   white: '\x1b[97m',   grey: '\x1b[90m',
  orange: '\x1b[38;5;208m',
  bgBlack: '\x1b[40m',
};

// ── Grid ──────────────────────────────────────────────────────────────────
const W = 76, H = 34;
const grid = [];
const colorGrid = [];
const layerGrid = [];

function resetGrid() {
  grid.length = 0; colorGrid.length = 0; layerGrid.length = 0;
  for (let r = 0; r < H; r++) {
    grid.push(new Array(W).fill(' '));
    colorGrid.push(new Array(W).fill(''));
    layerGrid.push(new Array(W).fill(0));
  }
}

function put(r, c, ch, co = '', ly = 0) {
  if (r >= 0 && r < H && c >= 0 && c < W && ly >= layerGrid[r][c]) {
    grid[r][c] = ch; colorGrid[r][c] = co; layerGrid[r][c] = ly;
  }
}

function putStr(r, c, s, co = '', ly = 0) {
  for (let i = 0; i < s.length; i++) put(r, c + i, s[i], co, ly);
}

function hLine(r, c0, c1, co) {
  const [lo, hi] = c0 < c1 ? [c0, c1] : [c1, c0];
  for (let c = lo; c <= hi; c++) put(r, c, '━', co);
}

function vLine(c, r0, r1, co) {
  const [lo, hi] = r0 < r1 ? [r0, r1] : [r1, r0];
  for (let r = lo; r <= hi; r++) put(r, c, '┃', co);
}

function diag(r0, c0, r1, c1, co) {
  const dr = Math.sign(r1 - r0), dc = Math.sign(c1 - c0);
  const absR = Math.abs(r1 - r0), absC = Math.abs(c1 - c0);
  const diagSteps = Math.min(absR, absC);
  const dch = (dr > 0) === (dc > 0) ? '╲' : '╱';
  let r = r0, c = c0;
  // Diagonal portion
  for (let i = 0; i < diagSteps; i++) { put(r, c, dch, co); r += dr; c += dc; }
  // Straight remainder (if not perfectly 45°)
  while (r !== r1) { put(r, c, '┃', co); r += dr; }
  while (c !== c1) { put(r, c, '━', co); c += dc; }
}

function station(r, c, label, side, co, home = false) {
  const marker = home ? '◆' : '●';
  const mco = home ? `${A.bold}${A.green}` : `${A.bold}${A.white}`;
  put(r, c, marker, mco, 2);
  const lco = home ? `${A.bold}${A.green}` : A.grey;
  if (label) {
    if (side === 'r') putStr(r, c + 2, label, lco, 1);
    else putStr(r, c - label.length - 1, label, lco, 1);
  }
  return [r, c];
}

function interchange(r, c, label, side) {
  put(r, c, '◉', `${A.bold}${A.white}`, 2);
  if (label) {
    const lco = A.grey;
    if (side === 'r') putStr(r, c + 2, label, lco, 1);
    else putStr(r, c - label.length - 1, label, lco, 1);
  }
  return [r, c];
}

// ── Station positions (hand-placed for clean aesthetics) ──────────────────

const POS = {};

function drawMap() {
  resetGrid();

  // ━━━━━━━━━━━━━━━━━ RED LINE ━━━━━━━━━━━━━━━━━━
  const RC = A.red;

  // Winchester ━━━━━━━ Division
  POS.winchester = station(3, 16, 'Winchester', 'l', RC);
  hLine(3, 17, 37, RC);
  POS.division = station(3, 38, 'Division', 'r', RC);

  // Division down to Prospect/Canner
  vLine(38, 4, 7, RC);

  // Winchester diag down to Winch/Sachem
  diag(4, 17, 7, 20, RC);
  POS.winchSachem = station(7, 20, 'Winch/Sachem', 'l', RC);

  // Winch/Sachem across to Prospect/Sachem
  hLine(7, 21, 37, RC);

  // ━━━━━━━━━━━━━━━━━ BLUE LINE ━━━━━━━━━━━━━━━━━
  const BC = A.blue;

  // Division ━━ Huntington ━━ Whitney/Huntington
  hLine(3, 39, 57, BC);
  POS.huntington = station(3, 46, 'Huntington', 'r', BC);
  POS.whHunt = station(3, 58, 'Whitney/Hunt', 'r', BC);

  // Whitney corridor down
  vLine(58, 4, 15, BC);
  POS.whCanner = station(7, 58, 'Canner', 'r', BC);
  POS.whCottage = station(10, 58, 'Cottage', 'r', BC);
  POS.peabody = station(13, 58, 'Peabody', 'r', BC);

  // Peabody diag to Grove
  diag(14, 57, 16, 55, BC);

  // ━━━━━━━━━━━━━━━ ORANGE LINE ━━━━━━━━━━━━━━━━━
  const OC = A.orange;

  // Branch from Whitney/Canner east
  hLine(7, 59, 65, OC);
  POS.orCanner = station(7, 66, 'Orange', 'r', OC);

  // Orange corridor down to Grove
  vLine(66, 8, 10, OC);
  POS.foster = station(10, 66, 'Foster', 'r', OC);
  diag(11, 65, 16, 56, OC); // straight diagonal to Grove

  // ━━━━━━━━━━━━━ CENTER SPINE ━━━━━━━━━━━━━━━━━━

  // Prospect corridor (vertical center)
  POS.prCanner = interchange(8, 38, 'Prospect/Canner', 'r');
  vLine(38, 8, 24, RC);  // Red continues down

  POS.prSachem = station(10, 38, 'Prospect/Sachem', 'r', BC, true);
  POS.pr130 = station(12, 38, '130 Prospect St', 'r', RC, true);
  POS.becton = station(14, 38, 'Becton', 'r', RC);

  // Grove and College/Wall
  POS.grove = interchange(16, 54, 'Grove', 'r');
  hLine(16, 39, 53, OC);
  POS.wall = interchange(16, 38, 'College/Wall', 'l');

  // ━━━━━━━━━━━━━━ BLUE WEST ━━━━━━━━━━━━━━━━━━━━
  const WC = A.cyan;

  // Pauli Murray on the left, vertical down from Canal
  POS.canal = interchange(8, 10, '', '');
  vLine(10, 9, 14, WC);
  POS.pauli = station(14, 10, 'Pauli Murray', 'r', WC, true);

  // Pauli diag down to Phelps
  diag(15, 11, 18, 14, WC);
  hLine(18, 15, 37, WC);

  // Phelps Gate
  POS.phelps = interchange(18, 38, 'Phelps Gate', 'r');

  // ━━━━━━━━━━━━━━ SOUTH TRUNK ━━━━━━━━━━━━━━━━━━

  vLine(38, 19, 26, OC);
  POS.crown = interchange(20, 38, 'Crown', 'l');
  POS.george = interchange(22, 38, 'George', 'l');
  POS.leph = interchange(24, 38, 'LEPH', 'l');

  // LEPH splits: York leg (SW) and Cedar leg (SE)
  diag(25, 37, 27, 35, BC);
  POS.york129 = interchange(27, 34, '129 York', 'l');
  vLine(34, 28, 30, OC);
  POS.york180 = station(29, 34, '180 York', 'l', OC);
  POS.elmYork = interchange(30, 34, 'Elm/York', 'l');

  diag(25, 39, 27, 41, RC);
  POS.cedar = interchange(27, 42, '333 Cedar', 'r');
  vLine(42, 28, 30, RC);
  POS.amistad = station(29, 42, 'Amistad', 'r', RC);
  POS.union = interchange(31, 38, 'Union Station', 'r');

  // Cedar to Howard (Blue West), Howard up to Canal
  hLine(27, 10, 33, WC);
  POS.howard = station(27, 10, 'Howard', 'l', WC);
  vLine(10, 8, 26, WC);  // Howard up to Canal

  // Amistad/Union
  diag(30, 41, 31, 39, RC);
  diag(30, 35, 31, 37, OC);
}

// ── Bus overlay with pulse ────────────────────────────────────────────────

const ROUTE_COLOR = {
  1: A.blue, 3: A.red, 4: A.blue, 13: A.blue, 14: A.orange,
  16: A.cyan, 17: A.orange, 2: A.orange, 19: A.grey,
  9: A.grey, 10: A.grey,
};

const STOP_TO_STATION = {};  // populated at draw time

function buildStopMap() {
  // Map stop IDs to schematic station keys
  const mapping = {
    winchester: [11], division: [48, 49], winchSachem: [147],
    huntington: [105, 69], whHunt: [139], whCanner: [129, 29],
    whCottage: [133, 132], peabody: [97], orCanner: [82],
    foster: [57, 88],
    prCanner: [100], prSachem: [106, 107], pr130: [3, 4],
    becton: [20], wall: [41, 42], grove: [63, 64, 118],
    phelps: [98], crown: [38], george: [39, 9], leph: [72],
    york129: [2], york180: [5], elmYork: [52, 53],
    cedar: [10, 43], amistad: [13, 14], union: [121],
    pauli: [164], canal: [27], howard: [153, 154],
  };
  for (const [stn, ids] of Object.entries(mapping)) {
    for (const id of ids) STOP_TO_STATION[id] = stn;
  }
}

function overlayBuses(frame) {
  let db;
  try { db = new Database(DB_PATH, { readonly: true }); } catch { return []; }

  const buses = db.prepare(`
    WITH latest AS (
      SELECT bp.bus_id, bp.bus_name, bp.route_id, bp.last_stop_id,
             ROW_NUMBER() OVER (PARTITION BY bp.bus_id ORDER BY bp.collected_at DESC) as rn
      FROM bus_positions bp
      WHERE bp.collected_at > datetime('now', '-2 minutes')
    )
    SELECT bus_id, bus_name, route_id, last_stop_id FROM latest WHERE rn = 1
  `).all();
  db.close();

  const legend = [];
  // Pulse: alternate between bright marker and dim marker
  const bright = frame % 2 === 0;

  for (const bus of buses) {
    const stnKey = STOP_TO_STATION[bus.last_stop_id];
    if (!stnKey || !POS[stnKey]) continue;

    const [sr, sc] = POS[stnKey];
    const co = ROUTE_COLOR[bus.route_id] || A.white;

    // Find an empty cell near the station for the bus marker
    const spots = [[sr - 1, sc], [sr + 1, sc], [sr, sc - 1], [sr, sc + 1],
                   [sr - 1, sc + 1], [sr + 1, sc - 1], [sr - 1, sc - 1], [sr + 1, sc + 1]];
    for (const [br, bc] of spots) {
      if (br >= 0 && br < H && bc >= 0 && bc < W && layerGrid[br][bc] < 2) {
        const marker = bright ? '▸' : '▹';
        const mco = bright ? `${A.bold}${co}` : `${A.dim}${co}`;
        put(br, bc, marker, mco, 3);
        break;
      }
    }

    const routeName = { 1: 'Blue', 3: 'Red', 4: 'Blue', 13: 'Blue', 14: 'Orange',
      16: 'Bl.West', 17: 'Orange', 2: 'Orange', 19: 'Brown', 9: 'Green', 10: 'Purple' };
    legend.push({ name: bus.bus_name, route: routeName[bus.route_id] || '?', color: co, stn: stnKey });
  }

  return legend;
}

// ── Render ─────────────────────────────────────────────────────────────────

function render(frame) {
  drawMap();
  buildStopMap();
  const legend = overlayBuses(frame);

  const lines = [];
  const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Header
  lines.push('');
  lines.push(`  ${A.bold}${A.white}Y A L E   S H U T T L E${A.reset}  ${A.dim}${time}${A.reset}`);
  lines.push(`  ${A.dim}${'─'.repeat(W)}${A.reset}`);

  // Grid
  for (let r = 0; r < H; r++) {
    let line = '  ';
    for (let c = 0; c < W; c++) {
      const co = colorGrid[r][c];
      line += co ? `${co}${grid[r][c]}${A.reset}` : grid[r][c];
    }
    lines.push(line);
  }

  // Footer
  lines.push(`  ${A.dim}${'─'.repeat(W)}${A.reset}`);

  // Route legend
  const parts = [
    `${A.blue}━━${A.reset} Blue`, `${A.red}━━${A.reset} Red`,
    `${A.orange}━━${A.reset} Orange`, `${A.cyan}━━${A.reset} Blue West`,
    `${A.bold}${A.green}◆${A.reset} Home`,
  ];
  lines.push(`  ${parts.join('   ')}`);

  // Bus legend
  if (legend.length > 0) {
    lines.push('');
    const bright = frame % 2 === 0;
    const strs = legend.map(b => {
      const m = bright ? `${A.bold}${b.color}▸${A.reset}` : `${A.dim}${b.color}▹${A.reset}`;
      return `${m} ${A.bold}${b.name}${A.reset} ${A.dim}${b.route}${A.reset}`;
    });
    // Wrap at 4 per row
    for (let i = 0; i < strs.length; i += 4) {
      lines.push('  ' + strs.slice(i, i + 4).map(s => s.padEnd(28)).join(''));
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const once = args.includes('--once');
let interval = 1; // 1s for smooth pulsing
const iIdx = args.indexOf('--interval');
if (iIdx >= 0 && args[iIdx + 1]) interval = Number(args[iIdx + 1]);

if (once) {
  console.log(render(0));
} else {
  const clear = '\x1b[2J\x1b[H';
  const hideCursor = '\x1b[?25l';
  const showCursor = '\x1b[?25h';
  process.stdout.write(hideCursor);
  const cleanup = () => { process.stdout.write(showCursor + '\n'); process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  let frame = 0;
  const tick = () => { process.stdout.write(clear + render(frame++)); };
  tick();
  setInterval(tick, interval * 1000);
}

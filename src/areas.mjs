// Operating areas. planetar-ais is now scoped to a named area: the mock
// source seeds its fleet from one, and the aisstream subscription filters
// to one. An area carries
//
//   serverId  — the planetar-ui server (the "Operation") its vessels land in
//   label     — human name of that Operation
//   bbox      — sw/ne bounding box
//   center    — map / moving-vessel spawn point
//   anchorage — optional cluster point for vessels seeded `anchored: true`
//   spread    — optional lat/lon spread for moving vessels (default 0.18)
//   fleet     — mock seed vessels
//
// Pick one with the OP env var (OP=victoria | OP=hormuz) — see index.mjs.

import { VICTORIA_BBOX, VICTORIA_CENTER } from './victoria.mjs';

// --- Victoria, BC — the original dark-vessel operating box. -------------
const VICTORIA_FLEET = [
  { mmsi: 316001234, name: 'PACIFIC VOYAGER',  type: 'cargo',    flag: 'CA', length: 180, callsign: 'CFAX2' },
  { mmsi: 316005678, name: 'COASTAL SPIRIT',   type: 'ferry',    flag: 'CA', length:  90, callsign: 'CFGH3' },
  { mmsi: 316009012, name: 'JUAN DE FUCA',     type: 'ferry',    flag: 'CA', length: 160, callsign: 'CFJF1' },
  { mmsi: 366014725, name: 'OLYMPIC TIDE',     type: 'tanker',   flag: 'US', length: 220, callsign: 'WDF4567' },
  { mmsi: 316002468, name: 'STRAIT EXPLORER',  type: 'pleasure', flag: 'CA', length:  18, callsign: 'CFSE7' },
  { mmsi: 316003579, name: 'HARBOUR DRIFTER',  type: 'fishing',  flag: 'CA', length:  22, callsign: 'CFHD9' },
  { mmsi: 538001357, name: 'ORIENT STAR',      type: 'cargo',    flag: 'MH', length: 195, callsign: 'V7AB1' },
  { mmsi: 477123400, name: 'KESTREL III',      type: 'fishing',  flag: 'HK', length:  28, callsign: 'VRKE3' },
  { mmsi: 316007531, name: 'RACE ROCKS LIGHT', type: 'pilot',    flag: 'CA', length:  14, callsign: 'CFRR2' },
  { mmsi: 366008642, name: 'PUGET RUNNER',     type: 'tug',      flag: 'US', length:  35, callsign: 'WPR8866' },
  { mmsi: 316004812, name: 'WHITE ROCK',       type: 'sailing',  flag: 'CA', length:  12, callsign: 'CFWR4' },
  { mmsi: 538009876, name: 'NORTH GATE',       type: 'cargo',    flag: 'MH', length: 200, callsign: 'V7NG1' },
];

// --- Strait of Hormuz — the Persian Gulf oil chokepoint off Iran. -------
// The box spans the strait's narrows up through the Bandar Abbas / Qeshm
// anchorage. Roughly a fifth of seaborne crude transits here, so the seed
// fleet skews to tankers — and most of them are seeded `anchored: true`,
// producing the dense knot of stalled ships ("the blockage") that an
// operator would be tracking. A handful of shadow-fleet tankers are
// `darkProne`: they drop AIS far more often than normal traffic, which is
// exactly the dark-vessel signal the demo is built to surface.
const HORMUZ_BBOX = {
  // [southwest_lat, southwest_lon] / [northeast_lat, northeast_lon]
  sw: [26.10, 55.70],
  ne: [27.30, 56.95],
};
const HORMUZ_CENTER = { lat: 26.70, lon: 56.35 };       // mid-strait
const HORMUZ_ANCHORAGE = { lat: 27.00, lon: 56.10 };    // off Bandar Abbas / Qeshm

const HORMUZ_FLEET = [
  // --- The blockage: crude tankers riding at anchor off Bandar Abbas. ---
  { mmsi: 422071000, name: 'SHAHR-E REY',     type: 'tanker',    flag: 'IR', length: 333, callsign: 'EQRY1', anchored: true, destination: 'BANDAR ABBAS' },
  { mmsi: 422038900, name: 'DELVAR',          type: 'tanker',    flag: 'IR', length: 274, callsign: 'EQDV2', anchored: true, destination: 'KHARG ISLAND' },
  { mmsi: 636092117, name: 'ATLANTIC PEARL',  type: 'tanker',    flag: 'LR', length: 274, callsign: 'D5AP3', anchored: true, destination: 'FUJAIRAH' },
  { mmsi: 538009210, name: 'GULF HORIZON',    type: 'tanker',    flag: 'MH', length: 333, callsign: 'V7GH4', anchored: true, destination: 'RAS TANURA' },
  { mmsi: 241089000, name: 'AEGEAN STAR',     type: 'tanker',    flag: 'GR', length: 249, callsign: 'SVAS5', anchored: true, destination: 'JEBEL ALI' },
  { mmsi: 256912000, name: 'VALLETTA SUN',    type: 'tanker',    flag: 'MT', length: 228, callsign: '9HVS6', anchored: true, destination: 'SINGAPORE' },
  { mmsi: 477998100, name: 'ORIENT DRAGON',   type: 'tanker',    flag: 'HK', length: 330, callsign: 'VROD7', anchored: true, destination: 'NINGBO' },
  { mmsi: 565884000, name: 'STRAITS PIONEER', type: 'tanker',    flag: 'SG', length: 183, callsign: '9VSP8', anchored: true, destination: 'BANDAR ABBAS' },
  // --- Stuck dry cargo / boxships. ---
  { mmsi: 538008740, name: 'NORTHERN TRADER', type: 'cargo',     flag: 'MH', length: 199, callsign: 'V7NT9', anchored: true, destination: 'BANDAR ABBAS' },
  { mmsi: 636019800, name: 'CAPE LEEUWIN',    type: 'bulk',      flag: 'LR', length: 229, callsign: 'D5CL1', anchored: true, destination: 'JEBEL ALI' },
  { mmsi: 470118000, name: 'EMIRATES FALCON', type: 'container', flag: 'AE', length: 366, callsign: 'A6EF2', anchored: true, destination: 'JEBEL ALI' },
  // --- Shadow-fleet tankers: dark-prone, loitering for ship-to-ship transfer. ---
  { mmsi: 352001870, name: 'EVEREST SPIRIT',  type: 'tanker',    flag: 'PA', length: 250, callsign: '3EES3', anchored: true, darkProne: true, destination: 'UNKNOWN' },
  { mmsi: 626145000, name: 'NEPTUNE GLORY',   type: 'tanker',    flag: 'GA', length: 244, callsign: 'TRNG4', anchored: true, darkProne: true, destination: 'UNKNOWN' },
  { mmsi: 352889000, name: 'SILENT MERIDIAN', type: 'tanker',    flag: 'PA', length: 244, callsign: '3ESM5', anchored: true, darkProne: true, destination: '—' },
  { mmsi: 518998000, name: 'CORAL WANDERER',  type: 'tanker',    flag: 'CK', length: 228, callsign: 'E5CW6', darkProne: true, destination: 'OFFSHORE' },
  // --- Transit traffic threading the strait. ---
  { mmsi: 422333000, name: 'PERSIA EXPRESS',  type: 'tanker',    flag: 'IR', length: 183, callsign: 'EQPE7', destination: 'BASRAH' },
  { mmsi: 461000210, name: 'MUSCAT VOYAGER',  type: 'cargo',     flag: 'OM', length: 199, callsign: 'A4MV8', destination: 'SOHAR' },
  { mmsi: 470215000, name: 'KHALIJ RUNNER',   type: 'ferry',     flag: 'AE', length:  95, callsign: 'A6KR9', destination: 'BANDAR ABBAS' },
  // --- Naval presence. ---
  { mmsi: 422510041, name: 'IRGCN PATROL 41', type: 'patrol',    flag: 'IR', length:  28, callsign: 'EPN41', destination: 'PATROL' },
  { mmsi: 369970000, name: 'CTF SENTINEL',    type: 'military',  flag: 'US', length: 154, callsign: 'NSEN0', destination: 'PATROL' },
];

export const AREAS = {
  victoria: {
    name: 'victoria',
    serverId: 'pac',            // matches planetar-ui servers[].id
    label: 'Pacific Patrol',
    bbox: VICTORIA_BBOX,
    center: VICTORIA_CENTER,
    fleet: VICTORIA_FLEET,
  },
  hormuz: {
    name: 'hormuz',
    serverId: 'hormuz',
    label: 'Strait of Hormuz',
    bbox: HORMUZ_BBOX,
    center: HORMUZ_CENTER,
    anchorage: HORMUZ_ANCHORAGE,
    spread: 0.55,               // strait is wide — spread transit traffic out
    fleet: HORMUZ_FLEET,
  },
};

export { VICTORIA_FLEET };

// Resolve an OP name to an area, defaulting to Victoria.
export function getArea(name) {
  const key = (name ?? 'victoria').toLowerCase();
  const area = AREAS[key];
  if (!area) {
    throw new Error(
      `unknown operating area "${name}" — known: ${Object.keys(AREAS).join(', ')}`,
    );
  }
  return area;
}

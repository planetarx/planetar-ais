# planetar-ais

AIS ingest microservice for the planetar dark-vessel demo. Pulls vessel
traffic for an **operating area** and publishes vessel events onto the
planetar-broker so each boat becomes its own channel in planetar-ui.

Two operating areas ship today (`src/areas.mjs`), each mapping to one
planetar-ui server ("Operation"):

| `OP` | Operation | Area |
|---|---|---|
| `victoria` (default) | Pacific Patrol (`pac`) | Victoria, BC dark-vessel box |
| `hormuz` | Strait of Hormuz (`hormuz`) | Persian Gulf chokepoint off Iran — a congested tanker anchorage ("the blockage") plus shadow-fleet tankers that drop AIS |

Run one process per area against the same broker to populate multiple
Operations at once.

## Topics published

Topics are area-scoped via the server id (`pac` for Victoria, `hormuz`
for the Strait of Hormuz):

| Topic | Schema | Purpose |
|---|---|---|
| `chat.<server>.vessel-<MMSI>` | `chat.v1.Message` | Per-vessel chat channel. One Slack channel per boat. |
| `vessel.ais.fleet` | `vessel.ais.Fleet.v1` | Control plane: `appeared` / `update` / `static-update` / `anomaly` / `lost`. UI listens here to spawn channel entries. |
| `vessel.ais.position` | `vessel.ais.Position.v1` | Raw position stream. For map / detector / fusion consumers. |

## Run

Broker must already be listening on `127.0.0.1:12001` (`planetar-broker`).

```bash
cd planetar-ais
npm install                     # one-time

# Mock source — synthetic Victoria fleet, no API key needed (default)
npm start

# Mock source — Strait of Hormuz blockage scenario
OP=hormuz npm start

# Real AIS via aisstream.io (also honours OP for the BBox)
export AISSTREAM_API_KEY=...
npm run start:aisstream
```

## Env vars

| Var | Default | Notes |
|---|---|---|
| `OP` | `victoria` | operating area: `victoria` or `hormuz` |
| `AIS_SOURCE` | `mock` | `mock` or `aisstream` |
| `AISSTREAM_API_KEY` | — | required for `AIS_SOURCE=aisstream` (free key at aisstream.io) |
| `BROKER_HOST` | `127.0.0.1` | planetar-broker producer host |
| `BROKER_PUB_PORT` | `12001` | producer port |
| `MOCK_TICK_MS` | `3000` | mock advance interval |
| `CHAT_SUMMARY_MS` | `30000` | per-vessel chat summary throttle |
| `LOST_AFTER_MS` | `300000` | mark `lost` after this much silence |

## Operating areas

Defined in `src/areas.mjs`.

- **Victoria, BC** — `48.20°N..48.65°N, 123.05°W..123.70°W`. Inner harbour,
  Race Rocks, Haro Strait, Juan de Fuca approaches, Active Pass.
- **Strait of Hormuz** — `26.10°N..27.30°N, 55.70°E..56.95°E`. The strait's
  narrows up through the Bandar Abbas / Qeshm anchorage. The mock fleet
  seeds a dense knot of tankers riding at anchor (the blockage) plus a few
  `darkProne` shadow-fleet tankers that drop AIS for the dark-vessel demo.

## Payload fields

Every `vessel.ais.position` payload (and the `vessel` object inside
`vessel.ais.fleet`) carries the fields below. Units follow the AIS message;
AIS "not available" sentinels are mapped to `null` in the `trueHeading`,
`rot`, `navStatus`, dimension, `draught` and `imo` fields so a placement
client never rotates a hull by 511°. The legacy `heading`, `cog` and `sog`
fields keep their original semantics for deployed clients.

| Field | Unit / values | Notes |
|---|---|---|
| `mmsi` | int | |
| `lat`, `lon` | WGS84 decimal degrees | |
| `sog` | knots | legacy: `102.3` = not available passes through |
| `cog` | degrees true | legacy: `360` = not available passes through |
| `heading` | degrees true | legacy: true heading, else COG, else 0 — always a number |
| `trueHeading` | degrees true or `null` | hull heading; `null` when AIS reports 511 |
| `rot` | raw AIS ROT (−127..127) or `null` | °/min = sign(r)·(r/4.733)²; ±127 = >10 °/min, no sensor; `null` = not available |
| `navStatus` | 0–14 or `null` | ITU-R M.1371 nav status; `null` = not defined (15) or Class B |
| `aisClass` | `A` \| `B` \| `null` | from the message type; `null` until a position arrives |
| `shipTypeCode` | int or `null` | ITU-R M.1371 type code; `type` is its coarse label |
| `dimA`, `dimB`, `dimC`, `dimD` | metres or `null` | antenna → bow / stern / port / starboard; all `null` when all four are 0 |
| `length`, `beam` | metres or `null` | `A+B`, `C+D` |
| `draught` | metres or `null` | maximum static draught |
| `imo` | int or `null` | |
| `name`, `callsign`, `destination`, `flag` | string or `null` | `flag` is only set by the mock source |
| `lastSeenNs`, `firstSeenNs` | decimal string, ns since epoch | receive time at this service (ms precision) |
| `inBBox`, `serverId` | bool, string | operating-area scoping |
| `simulated` | bool | `true` from the mock source, `false` from aisstream — render provenance honestly |

Run `npm test` for the decoder and mock-source tests.


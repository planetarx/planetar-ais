# AIS receiver buildout — self-hosted primary feed (Victoria, BC)

**Written 2026-07-24.** The durable fix for the aisstream.io dependency (see
[`ais-providers-and-resilience-2026-07.md`](ais-providers-and-resilience-2026-07.md)): a shore-based
RTL-SDR receiver → AIS-catcher → decoded JSON → a new `planetar-ais` source. Zero upstream ToS (we
decode the public broadcast ourselves) — the right basis for a public, redistributing demo — and the
same receiver unlocks AISHub's aggregate as a fallback tier. **Receiving AIS is passive and legal in
Canada (receive-only needs no ISED licence).**

Prices are estimates (USD list + FX/shipping/duty) — confirm at checkout. Research verified 2026-07-24.

## Bill of materials — first build (~CAD $75–105)

| Item | Product | ~CAD | Source | Req? |
|---|---|---|---|---|
| SDR + antenna | **RTL-SDR Blog V4 + dipole kit** (US$39.95) | ~$60–80 | rtl-sdr.com store (ships to CA) · Amazon.ca B0CD7558GT | **Yes** |
| Antenna | telescopic dipole (in kit), legs ≈ **46 cm** @ 162 MHz | incl. | — | Yes |
| USB extension | powered/active USB 2.0, 3–5 m (**match USB-A vs USB-C on the dongle**) | ~$15–25 | Amazon.ca | Recommended |
| Host | **bb** (already always-on; AIS-catcher is lightweight) | $0 | — | Yes (have it) |

**Optional upgrades (still under the ~$350 ceiling), add only if needed:**

| Upgrade | Product | ~CAD | When |
|---|---|---|---|
| SAW filter + LNA | Uputronics Filtered Preamp for AIS (US$59; powered by the V4's bias-tee) | ~$85–100 | only if RF interference / weak decode |
| Better antenna | DIY coax collinear (~$15) or a budget AIS-tuned marine whip | ~$15–150 | if range is short |
| Dedicated node | Raspberry Pi 4 2GB at the window | ~$60–90 | only if the antenna is far from bb |

**Do NOT buy a generic 156.8 MHz marine VHF whip** — it degrades at the 162 MHz AIS band. The kit
dipole tuned to 162 MHz, or a DIY 162 MHz coax collinear, beats it for a first build.

## Key layout rule

**Long USB, short coax — never the reverse.** VHF coax loss dwarfs USB loss. Put the *dongle* at the
window/rooftop with an open sea view (south/west over the Strait of Juan de Fuca / Haro Strait in
Victoria — right on the Vancouver–Seattle lanes), short coax dongle-to-antenna, and run the **powered
USB extension** back to bb. Expected range: ~20 nmi typical, up to ~40 nmi with height + clear horizon
— easily clears AISHub's 10-vessel bar here.

## Setup checklist (ordered)

1. **Buy** the V4 + dipole kit and a powered USB extension. Verify **USB-A vs USB-C** on the dongle
   batch and **kit stock** on Amazon.ca. Skip the filter/LNA for now.
2. **Assemble:** dipole at the window (legs ≈ 46 cm), short coax to dongle, long USB to bb.
3. **Driver hygiene:** if bb has generic `rtl-sdr`/`librtlsdr` installed, **purge it first** — the V4
   needs the `rtl-sdr-blog` fork (the AIS-catcher installer pulls the correct one).
4. **Install AIS-catcher** (github.com/jvde-github/AIS-catcher):
   ```
   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/jvde-github/AIS-catcher/main/scripts/aiscatcher-install) -p -M"
   ```
5. **Verify decode:** `AIS-catcher -v -N 8100` → open `http://localhost:8100`, confirm vessels + a
   healthy decode rate.
6. **JSON out to Node:** run the config below (JSON_FULL over UDP to localhost).
7. **Feed AISHub:** apply at aishub.net/join-us; they email a host:port; add it as a second **NMEA**
   UDP output. Sustain ≥10 vessels / ≥90% uptime → get an API key + their aggregate feed (fallback tier).

## AIS-catcher config (full decoded JSON to Node + NMEA to AISHub, simultaneously)

`AIS-catcher -C config.json`:
```json
{
  "config": "1.0",
  "rtlsdr": { "active": true, "rtlagc": true, "biastee": false },
  "meta":   { "distance": true, "timestamp": true },
  "server": { "active": true, "port": 8100 },
  "udp": [
    { "active": true, "host": "127.0.0.1", "port": 10110, "msgformat": "JSON_FULL" },
    { "active": true, "host": "AISHUB_HOST_FROM_EMAIL", "port": 0, "msgformat": "NMEA" }
  ]
}
```
- `udp[0]` → **planetar-ais** (decoded objects). `udp[1]` → AISHub (raw NMEA; fill host/port from their email).
- Set `biastee: true` later if you add the Uputronics preamp (verify the exact key against your installed version).
- **Gotcha:** the CLI shorthand `-u host port JSON on` emits **JSON_NMEA** (NMEA-in-JSON), *not* full
  decode — use the config file's `"msgformat": "JSON_FULL"` for decoded key-value objects.

## planetar-ais integration (the code step, after hardware arrives)

Add `src/source-aiscatcher.mjs` as a selectable `source` (alongside `mock` / `aisstream`):
- A UDP `dgram` listener on `127.0.0.1:10110`, parsing AIS-catcher **JSON_FULL** objects.
- Field mapping → our existing vessel-position/fleet events: `mmsi`, `lat`, `lon`, `speed` (SOG),
  `course` (COG), `heading`, plus static (type 5) `shipname`, `shiptype`, `destination`, `imo`, `callsign`;
  metadata `rxtime`/`signalpower` for provenance.
- A source-priority/failover wrapper so ingest degrades gracefully: **own receiver (primary) → AISHub
  poll (regional gap-fill + Hormuz) → aisstream WS (tertiary, while it lives)**.

JSON field reference: docs.aiscatcher.org → JSON decoding. Common keys: `class, channel, type, mmsi`;
position: `lat, lon, speed, course, heading, status, second, accuracy`; static: `imo, callsign,
shipname, shiptype, destination, eta, draught, to_bow/to_stern/to_port/to_starboard`.

## Verify-at-purchase flags

- V4 kit **stock** on Amazon.ca (intermittent) and **USB-A vs USB-C** connector → match the extension.
- CAD prices are estimates (store bills USD + duty).
- Purge generic `librtlsdr` on bb before install so the V4 fork loads.
- Confirm `msgformat: JSON_FULL` UDP support + the bias-tee key against your installed AIS-catcher version.
- AISHub host/port arrives only after your application is accepted.

# AIS providers, the aisstream outage, and a resilience plan

**Written 2026-07-22** after a multi-day outage of the current provider. Research verified against
live sources 2026-07-21; re-verify prices/terms before acting (they move).

## What happened (the outage that triggered this)

`planetar-ais` consumes **aisstream.io**'s free WebSocket API (JSON PositionReport, bounding-box
subscribe, API key). On **2026-07-20 00:21 UTC** the stream endpoint `stream.aisstream.io`
(136.243.173.177, a Hetzner box — *not* behind their Cloudflare front) went unreachable; www0's
`planetar-ais` logged `read ETIMEDOUT` mid-stream, then `connect ETIMEDOUT` on every 61 s retry.
The map on planetar.ca went empty while chat channels kept ticking (that combination — synth chat
alive, vessels zero — is the signature of an upstream AIS outage, not a bridge/broker fault).

**Root cause:** the TLS cert on `stream.aisstream.io` **expired 2026-07-19 22:34 UTC** (Let's
Encrypt R12). A valid replacement was issued 2026-06-20 but the server never loaded it — a stalled
reload, not a renewal failure (aisstream GitHub issue #229). It recovered ~2026-07-22 after a
flapping period (WS opened then dropped with code 1006 before stabilizing).

**This is the third identical outage in three months** (2026-05-20 #187, ~2026-06-20 #216,
2026-07-19 #229). **Zero maintainer responses** on any 2026 outage issue; the repo's last commit
is a README edit 2025-02-07. The community is discussing a fork (#242). **Conclusion: aisstream is
effectively unmaintained — treat it as tertiary, not a dependency.**

## Provider comparison (verified 2026-07-21)

| Provider | Real-time mechanism | Salish Sea | Cost | Redistribution / ToS | Integration vs current adapter | Reliability |
|---|---|---|---|---|---|---|
| **aisstream.io** | WS, bbox, JSON | yes (global terrestrial) | free | no ToS published | zero (current) | 3 outages / 3 mo; unmaintained |
| **Self-host RTL-SDR + [AIS-catcher](https://github.com/jvde-github/AIS-catcher)** | local decoded JSON over UDP/TCP/MQTT/WS | ~20–40 nmi from a Victoria antenna — covers Victoria / Haro Strait / most of Juan de Fuca; **not** Vancouver or Hormuz | ~US$150–250 one-time, $0/mo | **you own the data — no upstream ToS at all** | low-moderate: new source module (~150–250 LOC) consuming AIS-catcher JSON | your uptime = your uptime |
| **[AISHub](https://www.aishub.net/)** | REST poll, **≥60 s** | yes + global aggregate | free, **but must feed a receiver** (≥10 vessels avg, ≥90% uptime) | redistribution terms **undocumented** — confirm before public re-serving | low (~100 LOC poll); 60 s cadence dulls "live" feel | long-established exchange |
| **Kpler** (MarineTraffic + FleetMon + Spire, merged 2025) | TCP stream / REST | yes + satellite | **enterprise, contact-sales** (credit pricing dropped Jan 2025) | negotiated | moderate | high, far over budget |
| **VesselFinder** | REST + raw NMEA TCP/UDP | yes | credits €330/10k, €625/20k | restrictive (assume) | moderate | independent |
| **Datalastic** | REST poll | yes | €99/mo entry | — | low-moderate | fine; 2× budget, not streaming |
| **Ocean Networks Canada** (Oceans 3.0 / MDA program) | request-based; no self-serve real-time API | yes (Salish Sea) | free (request) | partner-sourced AIS may be CC-BY-NC+ | moderate + human latency | institutional |
| **US NAIS / MarineCadastre / NOAA** | gov-restricted; historical only | — | — | **explicit no-redistribution / no-commercial** | not viable | — |
| **Canada TC/CCG** | no public real-time feed (Canada buys Spire) | — | — | — | not viable | — |

## Recommendation (ranked)

**(a) Immediate bridge — patched aisstream adapter + outage watchdog.** No free WS+bbox+JSON
alternative is a true drop-in, so fastest restoration is: add an explicit, *logged* insecure-TLS
fallback (the cert is expired, not wrong-host; the stream reconnects intermittently), gated by
polling the unofficial status API (aisuptime.buttermilkgreen.fyi) to avoid reconnect storms. Bridge
only — MITM-tolerant TLS on a third party is not a keeper.

**(b) Long-term primary — self-hosted RTL-SDR + AIS-catcher in Victoria.** ~US$150–250 one-time,
$0/mo, covers the Victoria / Juan de Fuca / Haro Strait core of our bbox. Decisively for a
**public, redistributing** demo: it is the **only** option with zero upstream ToS — we decode the
broadcast ourselves. Integration is a modest source module consuming AIS-catcher's decoded JSON
(closest shape to `src/source-aisstream.mjs`). Bonus: a physical sensor is a credibility point for
the MDA-platform story and the bids.

**(c) Resilience — receiver-as-membership-key, three-tier fallback.** Feed the same receiver to
AISHub (Victoria clears their ≥10-vessel / 90%-uptime gate easily) to unlock their free global
aggregate as a 60 s-poll backup — also the only budget path to **Hormuz** coverage now that Kpler
consolidated the commercial APIs. Runtime order: **own receiver (primary, local) → AISHub poll
(regional gap-fill + Hormuz; confirm redistribution terms first) → aisstream WS (tertiary, while it
lives)**. Watch the aisstream fork effort (#242) for a possible community successor.

## Concrete next steps (not yet done)

1. Buy an RTL-SDR Blog V4 + VHF antenna; stand up AIS-catcher on a Pi or on bb; point it at Victoria.
2. Write `src/source-aiscatcher.mjs` consuming AIS-catcher decoded JSON; add it as a selectable
   `source` alongside `mock` / `aisstream`.
3. Register the receiver with AISHub; add `src/source-aishub.mjs` (60 s poll) as fallback.
4. Add a source-priority/failover wrapper so the ingest degrades gracefully across the three tiers.

Sources are linked inline; the outage timeline is from aisstream GitHub issues #187/#216/#229/#242
and www0's `planetar-ais-out.log`. See also `~/data/vaults/docs/DEPLOY-planetar.md` §Incident log.

# Permacomputer Node Score (PNS)

A "Zillow-style" single-number quality signal for every mesh node, decomposed into named components so a partner sees exactly why a node earns what it earns.

Formalizes the sketch published at [timehexon.com/permacomputer/](https://timehexon.com/permacomputer/) — that page defines the formula shape and the doctrine (older silicon > new, distance rewarded, colocation penalized, separate ISPs multiply resilience). This doc pins down the weights, caps, and data sources.

## Design goals

1. **Interpretable** — every node score decomposes into 8 labeled components, visible on the card.
2. **Cammy-friendly** — 2012 silicon with 378GB RAM and a 16TB RAID5 should out-score a 63GB modern gaming rig with a single SSD. Doctrine says older + more capacity + more redundancy wins.
3. **Power = direction, not objective** — efficiency is bounded, not the ceiling. A node can max out efficiency and still not dominate the fleet score.
4. **Cheap to compute** — every component derives from data the mesh probe already collects, or from a one-off extension (lsblk -b, /proc/mdstat).
5. **Doctrine-aligned** — respects the "2 paid max per location, 3rd+ is a donation" rule as a payout gate, not a score reduction. Donated nodes still get a PNS.

## Score components

**Hexagonal harmonics** — every cap and tier is a multiple of 7. Truth tessellates like hexagons (maximum strength, minimum material — timehexon doctrine); the scoring lattice follows the same rule.

| # | Name | Formula | Cap | Typical range | Source |
|---|---|---|---|---|---|
| 1 | **Wisdom** | `log₂(1 + max(0, age_years)) × 10` | **42** (7×6) | 0–42 | cpuModel → year table |
| 2 | **Storage** | `log₁₀(disks + 1) × 28` (Pass 3: TB + raid_bonus) | **42** (7×6) | 0–42 | lsblk + /proc/mdstat |
| 3 | **Memory** | tiered: <32G→7, 32-64G→14, 64-128G→21, **128-256G→49**, **256G+→77** | 77 (7×11) | 7–77 | memTotalGB |
| 4 | **Efficiency** | `min(42, 200 / (watts_per_core + 2))` | **42** (7×6) | 5–42 | powerWatts / cpuCores |
| 5 | **GPU** | `vram_tier(0-21) + compute_class(0-28)` | **49** (7×7) | 0–49 | gpuModel + gpuMemTotalMB |
| 6 | **Distance** | `Σ (peer_km × min_link_mbps / 1000) / peers` | **42** (7×6) | 0–42 | econ.lat/lon + linkMbps |
| 7 | **Diversity** | `+21` per unique egress IP at same location; `-7` per shared pipe at same location | ±**21** (7×3) | -21–+21 | geoipNodes + haversine |
| 8 | **Uptime** | `min(21, √uptime_days × 3)` | **21** (7×3) | 0–21 | /proc/uptime seconds |
| 9 | **Bonuses** | RAID mirror +7, RAID 5/6/10 +14, ZFS pool +7, ECC RAM +7 | 28 (7×4) | 0–28 | mdstat + zpool + dmidecode |

### GPU subcomponents

**VRAM tier** (cap 21):
| VRAM | Score |
|---|---|
| <4 GB | 0 |
| 4-8 GB | 7 |
| 8-16 GB | 14 |
| 16+ GB | 21 |

**Compute class** (cap 28) — from `gpuModel` lookup, reflects tensor / RT / neural-engine generation. nvidia-smi doesn't expose core counts directly, so we map architecture → tier:

| Architecture / Family | Score | Examples |
|---|---|---|
| Ada Lovelace / Hopper / Blackwell (3rd-gen+ tensor, 3rd-gen+ RT) | 28 | RTX 4090, RTX 4080, H100, H200, L40, GH200 |
| Ampere (2nd-gen tensor, 2nd-gen RT) | 21 | RTX 3090, RTX 3080, A100, A40, A10 |
| Turing / Volta (1st-gen tensor, 1st-gen RT) | 14 | RTX 2080, T4, V100, Titan V |
| Pascal / Maxwell / Kepler (no tensor cores) | 7 | Tesla P40, GTX 1080, Titan Xp |
| Apple Neural Engine (M2/M3/M4) | 21 | Apple M2, M3, M4 |
| Apple Neural Engine (M1) | 14 | Apple M1 |
| AMD ROCm MI300/MI250 | 28 | MI300X, MI250 |
| AMD Radeon RX 7000 / W7000 | 14 | RX 7900, Radeon Pro W7900 |
| Unknown but present | 7 | anything with valid gpuMemTotalMB |
| No GPU | 0 | |

**Total PNS**: sum of components. Typical range 42–260, ceiling 364 (all caps maxed).

Payout location proximity threshold: **49 km** (7²).

### Notes on individual components

**Wisdom** — Silicon age matters because proven silicon is what we actually deploy long-term. Log curve so a 15-year Sandy Bridge doesn't infinitely out-score a 10-year Ivy Bridge. CPU release year comes from a lookup table keyed on `cpuModel` regex (~200 SKUs covers common server/desktop chips; unmatched CPUs get age=0 and are visibly flagged so we know to extend the table).

**Storage** — Log scale because 100TB isn't 10× more useful than 10TB for a mesh node. RAID bonus rewards durability, not raw capacity. Detection via `/proc/mdstat` for md arrays, `zpool status` for ZFS.

**Memory** — Step function because doctrine says 128GB and 256GB are qualitatively different — a 256GB node can hold an entire model in RAM. Steps chosen so:
- 32GB: baseline modern desktop
- 64GB: workstation
- 128GB: **first big jump** — capable of local ML inference
- 256GB: **second big jump** — capable of hosting fleet-wide services

**Efficiency** — Hard cap at 42 because we want efficiency to matter without letting a 5W ARM SoC dominate the fleet score. The formula `200 / (w/c + 2)` gives:
- 1 W/core → raw 66 (capped to 42)
- 2 W/core → raw 50 (capped to 42)
- 3 W/core → raw 40 (below cap)
- 5 W/core → raw 28
- 10 W/core → raw 16
- 20 W/core → raw 9

The **raw** value is exposed alongside the capped value on the node card, so we can see when a node is punching past 42. If we later decide efficiency should reign supreme, remove the cap — no formula rewrite needed.

**Distance** — Direct implementation of the doctrine formula `distance_km × link_speed × weight`. Averaged across peers so adding one distant node doesn't dilute an existing node's distance score.

**Diversity** — Per-node version of the doctrine's "separate ISPs = gold" rule. Was previously a flat fleet-level bonus; now attributed to each node that contributes to the diversity.

**Uptime** — Rewards nodes that stay up. Square-root curve so 1 year of uptime (18 points) isn't infinitely better than 6 months (13 points). Cap at 20 because uptime past ~50 days shows the machine is healthy; more days don't prove more.

**Bonuses** — Small explicit rewards for hardening choices: RAID redundancy, ZFS integrity, ECC memory. Detectable via `/proc/mdstat`, `zpool status`, `dmidecode -t memory` (root required for the last one; skip until we have it).

## Payout gate — doctrine rule

Independent of PNS, the timehexon.com doctrine says:
> One node minimum, two nodes paid per location. Third+ node = donation.

Implemented as a `paid` flag alongside `score`:
```typescript
type NodeScore = {
  hostname: string;
  score: number;              // full PNS
  paid: boolean;              // false if 3rd+ at same location
  donation: boolean;          // true = donated compute, thank the partner
  components: {
    wisdom: number;
    storage: number;
    memory: number;
    efficiency: number;       // capped
    efficiencyRaw: number;    // uncapped, for observability
    distance: number;
    diversity: number;
    uptime: number;
    bonuses: number;
  };
}
```

Location grouping: haversine < 50km AND same egress IP → same "paid location". Score is still shown for 3rd+ nodes; a "donated" badge replaces the payout figure.

## Named tiers (Zillow-style)

Tier thresholds also on the 7-lattice:

| Tier | PNS range | Meaning |
|---|---|---|
| **Anchor** | 189+ (7×27) | Mesh backbone. Older wisdom + serious capacity + always up. |
| **Contributor** | 126–189 (7×18–7×27) | Solid node. Configured location, decent hardware, reliable. |
| **Supporter** | 63–126 (7×9–7×18) | Configured, modest hardware. Every mesh needs Supporters. |
| **Hobbyist** | <63 (7×9) | Welcome, unpaid. New nodes start here. |

## Data sources — what we have vs. need

### Have today (existing mesh probe)

- `cpuModel`, `cpuCores`, `cpuTdpWatts`
- `memTotalGB`, `memUsedGB`
- `powerWatts`, `gpuPowerWatts`, `powerSource`
- `spinningDisks`, `ssdCount` (counts, not capacity)
- `uptime` (formatted string; need to expose `uptimeSeconds` from the same probe)
- `loadAvg`, `gpuUtil`, `arch`

### Need probe extension

- **CPU release year** — one-off `CPU_YEAR_TABLE` lookup keyed on `cpuModel` regex. No new probe data. Table lives alongside `CPU_TDP_TABLE` in `api/mesh/route.ts`.
- **Disk capacity in bytes** — change `lsblk -d -o NAME,TYPE,SIZE,ROTA` to `lsblk -d -b -o NAME,TYPE,SIZE,ROTA` (byte-accurate). Sum non-loop device sizes.
- **RAID topology** — `cat /proc/mdstat` (md), `zpool list -H` (ZFS, if installed). Parse level from output.
- **ECC RAM** — `dmidecode -t memory | grep -i ecc`. Requires root. Defer.

## Migration plan

Ship in three passes so the score keeps working while probe extensions land:

1. **Pass 1 (this branch)** — Formalize `computeMeshScore` with the new component structure. Use existing probe data. Wisdom = 0 for now (safe default), Storage uses disk *count* × 4 as a rough proxy until we have byte capacity, Bonuses = 0. Efficiency gets its cap at 42. Memory tiers work. Diversity per-node. Payout gate.
2. **Pass 2** — CPU year table lookup. Wisdom lights up.
3. **Pass 3** — `lsblk -b` byte-accurate disk sums + `/proc/mdstat` RAID detection. Storage & Bonuses light up.

## What this changes for our current fleet

Rough estimates on the 7-lattice (all values capped, then summed):

| Node | Old | W | S | M | E | **G** | Dist | Div | Up | **New** |
|---|---|---|---|---|---|---|---|---|---|---|
| cammy (Xeon E5 v2 '13, 378G, 2 disks, Tesla P40) | 26 | 39 | 13 | **77** | 14 | **28** (21+7) | 0 | 21 | 21 | **~213** Anchor |
| guile (Xeon E5 '12, 128G, 11 disks, no GPU) | 26 | 42 | 30 | **49** | 14 | **0** | 0 | 21 | 21 | **~177** Contributor |
| 3090-ai ('22 i9, 63G, RTX 3090) | 44 | 24 | 13 | 21 | 26 | **42** (21+21) | 0 | 21 | 12 | **~159** Contributor |
| ai.foxhop ('24 i9, 63G, RTX 4090) | 30 | 16 | 8 | 21 | 28 | **49** (21+28) | 0 | 21 | 12 | **~155** Contributor |
| neoblanka (i5 '18, 31G, no GPU) | 28 | 32 | 13 | 7 | 30 | **0** | 0 | 21 | 21 | **~124** Supporter |

- **cammy** stays #1 — 378GB RAM + Tesla P40 24GB still wins on capacity + storage
- **guile** #2 — 42 wisdom (Sandy Bridge, oldest silicon in fleet) + 30 storage (11 disks) + 49 memory carries it
- **3090-ai** & **ai.foxhop** climb — GPU component reflects their actual ML mesh value; ai's 4090 gets max GPU (49), 3090-ai gets 42
- **neoblanka** — old wisdom (2018), but no GPU and modest RAM keeps it Supporter tier

This matches doctrine: proven silicon + capacity + storage beats raw compute, but raw compute still gets fair credit.

# Wayback Machine capture — hard-won lessons

Purpose: everything we learned building `capture.mjs` (screenshotting archived homepages via the
Internet Archive Wayback Machine), so the next agent can stand on our shoulders instead of
re-deriving it under a rate limit. Read this before touching the capture pipeline.

---

## TL;DR — the five things that actually matter

1. **The Internet Archive rate-limits per *source IP*, and the penalty is stateful and escalating.**
   Keep bursting through 503s and it graduates from soft 503s → HTTP/2 stream refusals → a hard
   ~1-hour 429 IP ban. It is **not** per-request-random; it accumulates on the IP.
2. **Don't burst. Pace.** A single modern page pulls ~50–80 sub-resources; firing them at once
   throttles *any* IP within seconds. The fix is adaptive rate control (below), **not** more IPs.
3. **Residential IPs >> datacenter/VPN IPs.** IA throttles datacenter ranges (incl. commercial
   VPNs like NordVPN) far harder. A home residential IP sustained heavy pages where every Nord
   exit died instantly. Rotating *among datacenter* IPs mostly doesn't help.
4. **A throttled IP recovers on its own** after enough quiet time, or **instantly on IP change**.
   So the recovery levers are: wait (cooldown) or change IP. Grinding does neither.
5. **"Some asset failed" ≠ "the screenshot looks broken."** Browsers fall back gracefully; most
   failed sub-resources are non-critical. Rank captures by failure count, but don't treat every
   flagged render as unusable — eyeball before re-fetching.

---

## How Wayback rate-limiting actually behaves (the core discovery)

- **Per-IP, stateful, escalating.** Sustained scraping (~1–2 hrs) accumulates a per-IP penalty
  that persists after you stop. Symptoms in order of severity: `HTTP 503` on sub-resources →
  `net::ERR_HTTP2_SERVER_REFUSED_STREAM` → `HTTP 429 Too Many Requests` (the hard ban, ~1 hr).
- **429 handling matters.** On a real 429, back off hard (≥60 s). Ignoring it >1 min escalates the
  ban (doubling). Honor the `Retry-After` header when present.
- **A fresh IP resets the limit instantly** — verified repeatedly (503 wall → clean 200s the moment
  egress changed). Confirms it's per-IP, not archive-wide load.
- **Burst is the trigger, not total volume.** Loading one ~76-asset page in parallel throttles a
  *fresh* IP in seconds. The same page loaded ~serially can sometimes get through. It's a
  requests-per-short-window (token-bucket-ish) limit.
- **Diagnose throttle vs missing-asset before chasing it.** A 503 on a sub-resource = throttle
  (fixable via rate/IP). A 404 = the asset was never archived (NOT fixable — no IP or rate helps).
  Instrument a single page load and tally sub-resource statuses by code. In our case modern
  Stripe pages returned `22×503, 0×404` → pure throttle, so it was worth pacing for. Always run
  this check before spending hours on the wrong hypothesis.

---

## Capture architecture (mechanisms and *why*)

### Picking snapshots (CDX)
- Query the **CDX API** (`/cdx/search/cdx`) with `filter=statuscode:200` and
  `collapse=timestamp:6` to get ~monthly captures, then pick **one representative per quarter**,
  deduping identical `digest`s (same content). Keeps the timeline even and small.
- For each pick, fetch the quarter's distinct-digest captures as **alternate candidates** — when
  the primary render is degraded, try the alternates and keep the best.

### Rendering
- Use the **`if_` modifier**: `web.archive.org/web/<ts>if_/https://site/` renders the page with
  **no Wayback toolbar/banner** — clean screenshots.
- Headless Chromium (Playwright), 1440×900 @ deviceScaleFactor 2. Scroll to trigger lazy images,
  wait for `document.fonts.ready` and a settle delay, then screenshot.
- **Never replay archive requests via `route.fetch`** — it breaks Wayback loads. Only *meter the
  start* of native requests, then `route.continue()` and let the browser fetch natively.

### Quality detection — and its big caveat
Two signals decide if a render is "clean":
- **`cssFailed`** — count of `stylesheet`/`script`/`font` sub-resources returning ≥400. This is
  the root-cause signal: a throttled *layout* stylesheet yields a half-styled page while the
  `<img>`s still load, so image-count alone can't see it. (Our original detector only checked
  "0 broken images" + "some CSS rules exist" and happily saved fully-collapsed pages — that's the
  bug that started this whole saga.)
- **`emptyRatio`** — sample a grid over the above-the-fold with `elementFromPoint`; cells hitting
  only `<body>`/background = layout collapse (content jammed into a narrow column, white void).
- **CAVEAT (important):** these are *conservative*. `css=8` often looks visually perfect — the
  failed assets were non-critical (tracking JS, off-screen lazy images, a font that fell back).
  Use the score to **rank candidates**, not as a verdict that a render is unusable. Verify
  visually before deciding a "non-clean" capture needs replacing. Truly-broken renders (full
  CSS-collapse: nav overlapping hero + white void) are rare and obvious.

### No-degrade replacement
- Render candidates to a **temp file**; only promote it over an existing shot if the new render is
  actually **clean**. So a re-fetch under throttle can *improve or keep* a shot but **never make it
  worse**. Verdicts: `ok` (clean) · `WARN` (no prior shot, saved best-available) · `KEEP` (had a
  shot, couldn't beat it, left untouched) · `skip` (existing, not re-fetched).
- Corollary: a re-fetch of a *known-bad* existing shot that can't reach clean will `KEEP` the bad
  one. If you *want* to force-replace a bad shot with best-available, delete it first (so
  `preExisted=false` → it saves best as `WARN`).

### Resume / checkpoint
- Write `snapshots.json` **after every pick** (not just at the end) — a kill/crash never wipes
  progress. Derive the shot list by scanning `sites/<key>/shots/` so it's robust to partial runs.
- `SKIP_EXISTING=1` keeps every shot already on disk (fast resume / gap-fill). `REFETCH=<dates>`
  forces re-render of specific dates even if they exist.

### Adaptive rate control (AIMD) — the real throttle fix
- Fixed concurrency is wrong: too high → burst → throttle; too low → crawl. Instead **auto-tune**:
  concurrency starts at 1, **ramps +1** after N clean responses, **halves** on any 503/429, and
  **honors `Retry-After`** with a global pause. It converges on the fastest rate IA tolerates and
  holds there. This is what finally captured the heavy modern pages that fixed concurrency never
  could. Watch it work in the log: `[rate] steady -> concurrency 1->2 … 503 -> concurrency 3->1`.

### Throttle governor (cooldown ladder) — the fallback
- If throttling still goes *sustained* (a broad run of picks hitting 503/429 — distinct from one
  archive-degraded date), pause proactively on an **escalating ladder** (5 → 15 → 30 → 60 min),
  probing a cheap CDX liveness check between pauses. **A short proactive pause avoids escalating
  into IA's hard ~1-hour ban.** It never exits; it resumes the moment IA answers.
- Key nuance: trigger on **breadth** (consecutive *distinct* picks throttled), not on one stubborn
  archive-degraded date — otherwise a single bad quarter false-triggers a pause.

### Supervisor (`run.sh`) — for multi-day unattended runs
- A keep-alive wrapper: relaunch the capture with `SKIP_EXISTING=1` whenever the *process* dies
  (crash/OOM/kill), and stop once a full pass adds nothing new. With per-pick checkpointing this
  survives crashes and sleep. For reboot-survival, run it under `launchd`/`systemd`.

---

## Operational playbook

- **Default run:** `./run.sh <site>` — supervised, adaptive, unattended. Keep the machine awake
  (`caffeinate -i -s` on macOS).
- **Prefer a residential IP.** If capturing from a home IP, expect your own IA browsing to be
  soft-limited during the run (harmless, temporary). Commercial VPNs (datacenter) are worse for
  IA, not better.
- **Don't chase IP rotation as the primary lever** — pace instead. Rotation helps only to (a) get a
  *fresh* start for the adaptive controller, or (b) escape an already-poisoned IP you thrashed.
- **Diagnose before grinding:** one instrumented page load (tally sub-resource status codes) tells
  you throttle (503, fixable) vs unarchived (404, not fixable).
- **Reporting during long runs:** emit a heartbeat and, when genuinely stalled on a user-fixable
  blocker, alert **within ~15 min and every ~15 min** — never go silent, but don't cry wolf on
  every routine per-page cooldown either. Alert on a *real* stall (no progress for 15+ min while
  throttled).

---

## Mistakes we made (so you don't)

1. **Shipped a detector that called collapsed pages "clean"** (only checked broken-image count).
   → Add root-cause signals (`cssFailed`) and verify visually.
2. **Burst with fixed high concurrency**, throttling every fresh IP within ~15 min.
   → Adaptive AIMD pacing.
3. **Re-fetched hopeless dates** (archive-degraded quarters, or `broken=1` cosmetic dates) which
   burned the IP's budget for zero new shots while the actually-missing coverage waited.
   → Prioritize net-new coverage; don't re-fetch what can't improve.
4. **Made progress depend on a human manually rotating the VPN** — turned a "run for days" job into
   babysitting. → Build autonomy (adaptive rate + supervisor + self-recovery) into the script.
5. **Went silent for ~2 hours during a stall** to avoid "spamming." → Heartbeat + stall alerts.
6. **Ran a "serialized" test on an already-poisoned IP** and drew a false conclusion. → Test the
   fix on a *clean* IP, or you're measuring the wrong thing.
7. **Treated every "non-clean" (metric) render as broken.** → Most look fine; eyeball first.
8. **Used `pkill -f "node capture.mjs"`** which also killed the *monitor* (its script contains that
   string). → Match the exact process (`ps -o comm= == node`) or a unique token.

---

## Still unsolved / open questions

- **Fully-clean modern pages (~76 assets) from a single IP** may be unattainable at any rate if IA
  is congested — it can plateau at "mostly clean" (`css=4–8`, visually fine). Truly-clean captures
  seem to require luck / an uncongested window (overnight). No-degrade will opportunistically swap
  in cleaner renders across supervised passes, *if* you re-attempt non-clean picks (the default
  `run.sh` stops at first coverage; add a re-fetch-unclean loop if you want quality to keep
  improving over days — but weigh it against the "non-clean usually looks fine" caveat).
- **Autonomous IP rotation on macOS** has no clean no-infra path: NordVPN's CLI is Linux-only and
  consumer NordVPN has no control API on any plan. Options (all require setup): scripting OpenVPN
  with per-server configs + service credentials, WireGuard/NordLynx, or a residential proxy pool.

---

## Env knobs (capture.mjs)

| Var | Meaning |
|-----|---------|
| `SITE` | which site (key in `sites.json`) to capture |
| `SKIP_EXISTING=1` | keep shots already on disk (resume / gap-fill) |
| `REFETCH=d1,d2` | force re-render these dates even if present |
| `MAX_CONC` | adaptive concurrency **ceiling** (default 5) |
| `RAMP_AFTER` | clean responses per +1 concurrency (default 25) |
| `REQ_SPACING_MS` | min gap between request starts (default 120) |
| `GOVERN=0` | disable the request governor (default: on) |
| `EMPTY_MAX` | layout-collapse threshold (default 0.55) |
| `THROTTLE_NUDGE` / `THROTTLE_COOLDOWNS` | cooldown trigger count / ladder (seconds) |
| `ONLY=d1,d2` | restrict to these dates · `LIMIT` cap picks · `DEADLINE` ms budget · `GOTO` per-nav timeout |

# Website history — through the years

Interactive viewers of company homepages as captured by the Internet Archive
Wayback Machine — one representative snapshot per quarter, from each site's earliest
meaningful capture to today.

Open `index.html` (or the GitHub Pages URL) for the grid of supported sites; each card's
cover is that site's most recent snapshot. Click into a site for the timeline viewer:
← / → to step, the scrubber to jump to a year, and **Play** for a timelapse.

Currently tracked:

- **goshippo.com** — from 2013-09-27
- **stripe.com** — from 2011-10-07 (Stripe the company's public launch; earlier
  `stripe.com` captures from 1996–2010 belong to a previous domain owner and are excluded)

## Structure

```
sites.json                 registry of tracked sites (key, name, domain, accent, since)
index.html                 grid landing page (cover = each site's latest snapshot)
viewer.html                per-site timeline viewer — reads ?site=<key>
capture.mjs                the capture tool, parameterized by SITE
sites/<key>/
  snapshots.json           site metadata + chronological list of rendered dates
  shots/<YYYY-MM-DD>.png   the screenshots
```

The grid reads `sites.json`, then each site's `snapshots.json`. The viewer fetches a
single site's `snapshots.json` at runtime, so adding snapshots needs no HTML edits.

> **Building on this / debugging captures?** Read [`docs/CAPTURE_LEARNINGS.md`](docs/CAPTURE_LEARNINGS.md) first —
> hard-won lessons on Wayback rate-limiting, adaptive pacing, and the capture architecture.

## Adding / extending a site

1. Add an entry to `sites.json` (`key`, `name`, `domain`, `accent`, optional `since` floor
   to skip a domain's earlier unrelated owner, optional `note`).
2. Run the capture for that site.

`capture.mjs`:

- Queries the Wayback **CDX API** for all 200-status homepage captures (from the `since`
  floor onward — it auto-discovers the earliest capture within that range).
- Picks one representative capture per quarter (dedupes identical content digests).
- Renders each above-the-fold in headless Chromium (Playwright), via the `if_`
  modifier so there's no Wayback toolbar.
- Validates each render: rejects archive 503 pages and unstyled (CSS-failed) loads,
  and scores by broken-image count — keeping the cleanest capture, trying alternate
  snapshots in the same quarter when the primary is degraded.
- Writes `sites/<key>/shots/*.png` and `sites/<key>/snapshots.json`.

```bash
npm install
npx playwright install chromium

SITE=goshippo node capture.mjs           # full run for a site
SITE=stripe node capture.mjs             # add another
SITE=stripe GOVERN=1 node capture.mjs    # gentler on the Wayback LB (meters request bursts)
SITE=stripe ONLY=2020-01-04 node capture.mjs   # re-fix specific dates
```

### Resuming & fixing bad renders

Captures survive interruption: `snapshots.json` is written after every pick, and shots are
kept on disk. To resume or repair without re-doing good work:

```bash
SITE=stripe SKIP_EXISTING=1 node capture.mjs                 # keep every existing shot, fill gaps
SITE=stripe SKIP_EXISTING=1 REFETCH=2018-04-01,2019-07-01 \  # + re-try specific degraded dates
  node capture.mjs
```

Re-fetches are **no-degrade**: a candidate is rendered to a temp file and only replaces an
existing shot if it's genuinely clean, so a throttled re-try can improve or keep a capture but
never make it worse (verdicts: `ok` clean · `WARN` saved best, no prior shot · `KEEP` kept the
existing shot · `skip` untouched).

### Throttling & unattended runs

The Internet Archive rate-limits **per source IP** with an *escalating* penalty — bursting
through 503s graduates to a hard ~1-hour ban. Two mechanisms keep the capturer robust:

- **Adaptive rate control (AIMD):** concurrency starts at 1, ramps *up* while responses stay
  clean, and *halves* the instant a 503/429 appears (honoring the `Retry-After` header). It
  converges on the fastest rate IA tolerates and holds there — so it rarely trips the limit
  instead of guessing a fixed concurrency.
- **Escalating cooldowns:** if throttling still becomes sustained (a broad run of picks hitting
  503/429, distinct from one archive-degraded date) it proactively pauses on a 5 → 15 → 30 → 60 min
  ladder, probing liveness between pauses. It never exits; it resumes the moment IA is reachable.

For a truly hands-off, multi-day run, use the supervisor — it relaunches on crash/reboot,
resumes via `SKIP_EXISTING`, and stops once a full pass adds nothing new:

```bash
./run.sh stripe        # supervised, unattended; Ctrl-C to stop
```

Note: rotating a **datacenter** VPN (e.g. NordVPN) among its exits often doesn't help — IA
throttles those ranges broadly; residential exits fare better. The adaptive controller is the
more reliable lever than IP-hopping.

Useful env knobs: `LIMIT` (cap picks), `ONLY` (comma-separated dates), `DEADLINE` (ms
wall-clock budget), `GOTO` (per-nav timeout), `MAX_CONC` (adaptive concurrency ceiling) /
`RAMP_AFTER` (clean responses per +1 concurrency) / `REQ_SPACING_MS` (min request spacing),
`GOVERN=0` (disable the governor), `EMPTY_MAX` (layout-collapse threshold),
`THROTTLE_NUDGE` / `THROTTLE_COOLDOWNS` (cooldown trigger and ladder in seconds).

Source: <https://web.archive.org/>

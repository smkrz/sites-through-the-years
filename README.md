# goshippo.com through the years

An interactive viewer of goshippo.com's homepage as captured by the Internet Archive
Wayback Machine, one representative snapshot per quarter from 2013-09-27 to 2026-04-02.

Open `index.html` (or the GitHub Pages URL). Use ← / → to step, the scrubber to jump
to a year, and **Play** for a timelapse.

## Regenerating / extending

`capture.mjs` is the tool that builds the screenshot set:

- Queries the Wayback **CDX API** for all 200-status homepage captures.
- Picks one representative capture per quarter (dedupes identical content digests).
- Renders each above-the-fold in headless Chromium (Playwright), via the `if_`
  modifier so there's no Wayback toolbar.
- Validates each render: rejects archive 503 pages and unstyled (CSS-failed) loads,
  and scores by broken-image count — keeping the cleanest capture, trying alternate
  snapshots in the same quarter when the primary is degraded.

```bash
npm install
npx playwright install chromium
node capture.mjs                 # full run -> above-the-fold/
ONLY=2024-01-04 node capture.mjs # re-fix specific dates
node build-site.mjs              # assemble site/ (this folder)
```

Source: <https://web.archive.org/web/*/goshippo.com>

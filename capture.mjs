import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';

// Shots are stored as WebP (visually lossless at q92, ~6x smaller than PNG -> fast deploys/loads).
const WEBP_QUALITY = process.env.WEBP_QUALITY ? parseInt(process.env.WEBP_QUALITY, 10) : 92;

const ROOT = new URL('./', import.meta.url).pathname;

// --- site selection: SITE=<key> picks a domain + coverage floor from sites.json ---
const SITE = process.env.SITE || 'goshippo';
const registry = JSON.parse(await readFile(`${ROOT}sites.json`, 'utf8'));
const site = registry.sites.find(s => s.key === SITE);
if (!site) throw new Error(`unknown SITE "${SITE}". Known: ${registry.sites.map(s => s.key).join(', ')}`);
const DOMAIN = site.domain;
const OUT = `${ROOT}sites/${SITE}/`;
// coverage floor: skip captures before this (e.g. a domain's previous owner). "YYYY" or "YYYY-MM-DD".
const SINCE = (site.since || '').replace(/-/g, '');            // -> CDX "from" timestamp prefix
const FROM_TS = SINCE ? SINCE.padEnd(14, '0') : '';

const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const ONLY = new Set((process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean)); // restrict to these dates
// Resume support: SKIP_EXISTING=1 keeps any pick that already has a shot on disk (fast resume);
// REFETCH lists dates to re-render even if a shot exists (to replace degraded captures).
const REFETCH = new Set((process.env.REFETCH || '').split(',').map(s => s.trim()).filter(Boolean));
const SKIP_EXISTING = process.env.SKIP_EXISTING === '1';
const GOTO = process.env.GOTO ? parseInt(process.env.GOTO, 10) : 90000;                 // per-nav timeout
const DEADLINE = process.env.DEADLINE ? Date.now() + parseInt(process.env.DEADLINE, 10) : Infinity; // wall-clock budget
const GAP_MS = 3500;
// Politeness knobs. Each archived page pulls dozens of sub-resources; firing them as
// one burst saturates the Wayback load balancer's backend queue, which then sheds load
// with "503 No server is available" (HAProxy) -> broken hero/logo images. We cap the
// number of in-flight archive requests and space their starts to keep bursts small.
const MAX_CONC = process.env.MAX_CONC ? parseInt(process.env.MAX_CONC, 10) : 5;          // max concurrent archive requests
const REQ_SPACING_MS = process.env.REQ_SPACING_MS ? parseInt(process.env.REQ_SPACING_MS, 10) : 120; // min gap between request starts
// Identify the client (IA treats identified, rate-limited clients better than anonymous scrapers).
const UA = 'website-history-archiver/1.0 (+https://github.com/smkrz/sites-through-the-years)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * Math.min(1000, ms * 0.25));         // de-synchronize retries

async function cdxJson(url, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      const text = await res.text();
      if (res.ok && text.trim().startsWith('[')) return JSON.parse(text);
      // On 429, IA bans the IP for 1h (doubling) if ignored >1min -> pause ~60s, don't hammer.
      if (res.status === 429) { await sleep(60000); continue; }
    } catch {}
    await sleep(jitter(2500 * i));
  }
  throw new Error('CDX failed: ' + url);
}

console.log(`capturing ${site.name} (${DOMAIN})${site.since ? ` since ${site.since}` : ''} -> sites/${SITE}/`);

// --- 1. monthly-collapsed captures -> one representative pick per quarter ---
const fromParam = FROM_TS ? `&from=${FROM_TS}` : '';
const rows = (await cdxJson(
  `https://web.archive.org/cdx/search/cdx?url=${DOMAIN}&output=json` +
  `&fl=timestamp,original,statuscode,digest&filter=statuscode:200&collapse=timestamp:6${fromParam}`
)).slice(1);
console.log(`CDX returned ${rows.length} monthly captures`);

const picks = [];
const seenQ = new Set();
let lastDigest = null;
for (const [ts, original, status, digest] of rows) {
  const y = ts.slice(0, 4), q = Math.floor((+ts.slice(4, 6) - 1) / 3) + 1;
  const key = `${y}-Q${q}`;
  if (seenQ.has(key) || digest === lastDigest) continue;
  seenQ.add(key);
  lastDigest = digest;
  const date = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  picks.push({ date, ts, quarter: key });
}
let selected = picks.slice(0, LIMIT);
if (ONLY.size) selected = selected.filter(p => ONLY.has(p.date));
console.log(`${selected.length} picks to render${ONLY.size ? ` (ONLY: ${[...ONLY].join(', ')})` : ''}`);

await mkdir(`${OUT}shots`, { recursive: true });

// distinct captures available within a pick's quarter (primary ts first)
async function quarterCandidates(p) {
  const y = p.date.slice(0, 4);
  const qStartM = (Math.floor((+p.date.slice(5, 7) - 1) / 3) * 3) + 1;
  const from = `${y}${String(qStartM).padStart(2, '0')}01`;
  const to = `${y}${String(qStartM + 2).padStart(2, '0')}31`;
  let cands = [];
  try {
    const r = await cdxJson(
      `https://web.archive.org/cdx/search/cdx?url=${DOMAIN}&output=json&fl=timestamp,digest` +
      `&filter=statuscode:200&collapse=digest&from=${from}&to=${to}`, 4);
    cands = r.slice(1).map(row => row[0]);
  } catch {}
  return [...new Set([p.ts, ...cands.filter(ts => ts !== p.ts)])].slice(0, 6);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  userAgent: UA,
});

// --- adaptive request controller (AIMD) ---------------------------------------------------
// IA rate-limits per IP; a fixed concurrency either bursts (-> throttle) or crawls (-> slow).
// Instead we auto-tune: ramp concurrency UP while responses stay clean, HALVE it on any
// 503/429, and honor the Retry-After header. It converges on the fastest rate the Archive
// tolerates and holds there — no bursts, no guessing MAX_CONC. We meter request STARTS only
// (never replay via route.fetch — that breaks Wayback loads).
const RAMP_AFTER = process.env.RAMP_AFTER ? parseInt(process.env.RAMP_AFTER, 10) : 25; // clean responses per +1 concurrency
const rate = {
  conc: 1,                 // current concurrency limit (starts gentle, adapts up)
  active: 0, lastStart: 0, waiters: [],
  clean: 0, pauseUntil: 0, // pauseUntil: global gate honoring Retry-After
  observe(status, retryAfter) {
    if (status === 503 || status === 429) {                 // multiplicative decrease
      const before = this.conc;
      this.conc = Math.max(1, Math.floor(this.conc / 2));
      this.clean = 0;
      const ra = parseInt(retryAfter, 10);
      const backoff = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : 5000; // honor Retry-After (cap 5m)
      this.pauseUntil = Math.max(this.pauseUntil, Date.now() + backoff);
      if (before !== this.conc) console.log(`[rate] ${status} -> concurrency ${before}->${this.conc}, pause ${Math.round(backoff / 1000)}s`);
    } else if (status >= 200 && status < 400) {             // additive increase
      if (++this.clean >= RAMP_AFTER && this.conc < MAX_CONC) {
        this.conc++; this.clean = 0;
        console.log(`[rate] steady -> concurrency ${this.conc - 1}->${this.conc}`);
      }
    }
  },
};
async function acquireSlot() {
  for (;;) {
    const now = Date.now();
    if (now < rate.pauseUntil) { await sleep(rate.pauseUntil - now); continue; }
    if (rate.active < rate.conc) break;
    await new Promise(r => rate.waiters.push(r));
  }
  rate.active++;
  const wait = REQ_SPACING_MS - (Date.now() - rate.lastStart);
  if (wait > 0) await sleep(wait);
  rate.lastStart = Date.now();
}
function releaseSlot() { rate.active--; const next = rate.waiters.shift(); if (next) next(); }
// Feed every browser response into the controller so it can adapt (attached per page in the loop).
const feedRate = (page) => page.on('response', (r) => { try { rate.observe(r.status(), r.headers()['retry-after']); } catch {} });

// analytics/tracking/social beacons don't affect the screenshot — dropping them shrinks the burst
const BLOCK = /google-analytics|googletagmanager|doubleclick|facebook\.|fbcdn|hotjar|segment\.|mixpanel|intercom|drift\.|fullstory|optimizely|amplitude|sentry|heapanalytics|stats\.g|clarity\.ms/i;

// Governor on by default (disable with GOVERN=0). Drops tracking noise and meters the START of
// native requests under the adaptive controller — never replays them.
if (process.env.GOVERN !== '0') {
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (BLOCK.test(url)) return route.abort().catch(() => {});
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue().catch(() => {});
    await acquireSlot();
    setTimeout(releaseSlot, 300);   // hold the slot briefly to space starts, then fetch natively
    return route.continue().catch(() => {});
  });
}

// Layout-collapse threshold: fraction of above-the-fold sample points that hit only the
// page background (no content element). A full-bleed marketing hero fills most points; a
// half-styled page whose positioning CSS 503'd leaves a large empty void (calibrated ~0.5).
const EMPTY_MAX = process.env.EMPTY_MAX ? parseFloat(process.env.EMPTY_MAX) : 0.55;

// Load one timestamp and report quality. Throws on archive error / unstyled.
// Returns quality signals:
//   broken    = count of <img> that failed to load (throttled image assets)
//   cssFailed = count of stylesheet/script/font sub-resources the archive 503'd (root cause
//               of half-styled renders: typography loads but the layout sheet is missing)
//   emptyRatio= fraction of the above-the-fold hitting only <body>/background (layout collapse)
async function probe(page, ts) {
  // Meter sub-resource failures: a throttled CSS/JS breaks layout while <img> tags still load,
  // so image-count alone can't see it. Count archive responses >=400 for styling assets.
  let cssFailed = 0, throttle503 = 0;
  const onResp = (resp) => {
    try {
      const rt = resp.request().resourceType();
      const s = resp.status();
      if ((rt === 'stylesheet' || rt === 'script' || rt === 'font') && s >= 400) cssFailed++;
      // 503/429 are the archive's throttle signature (vs 404 = asset genuinely not archived)
      if (s === 503 || s === 429) throttle503++;
    } catch {}
  };
  page.on('response', onResp);
  try {
    const url = `https://web.archive.org/web/${ts}if_/https://${DOMAIN}/`;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO });
    const code = resp ? resp.status() : 0;
    if (code !== 200) throw new Error(`HTTP ${code}`);
    const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '');
    if (/Service Unavailable|No server is available|Too Many Requests|Internal Server Error/i.test(body))
      throw new Error('archive error page');
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    // trigger lazy images
    await page.evaluate(async () => {
      await new Promise(res => {
        let y = 0; const step = 500;
        const t = setInterval(() => {
          window.scrollBy(0, step); y += step;
          if (y >= document.body.scrollHeight) { clearInterval(t); window.scrollTo(0, 0); res(); }
        }, 80);
      });
    });
    // Cap the fonts.ready wait: under heavy archive throttling a font sub-resource can stay
    // pending indefinitely and document.fonts.ready then never settles, hanging the whole probe
    // with no timeout (observed on heavy modern pages from a throttled IP). Race it against a 4s
    // cap so a stuck font can't stall the render — fonts are cosmetic to the screenshot anyway.
    await page.evaluate(() => Promise.race([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      new Promise(r => setTimeout(r, 4000)),
    ])).catch(() => {});
    await page.waitForTimeout(2500);
    const m = await page.evaluate(() => {
      let rules = 0;
      for (const s of document.styleSheets) { try { rules += (s.cssRules || []).length; } catch { rules += 50; } }
      let broken = 0;
      for (const img of document.images) {
        if (img.getAttribute('src') && img.complete && img.naturalWidth === 0) broken++;
      }
      // Layout-collapse probe: sample a grid over the above-the-fold; a point that resolves to
      // only <body>/<html> (or nothing) is background void. Half-styled pages collapse content
      // into a narrow column, leaving most of the fold empty.
      const vw = window.innerWidth, vh = Math.min(window.innerHeight, 900);
      const COLS = 20, ROWS = 12; let empty = 0, total = 0;
      for (let gx = 0; gx < COLS; gx++) for (let gy = 0; gy < ROWS; gy++) {
        const x = (gx + 0.5) * vw / COLS, y = (gy + 0.5) * vh / ROWS;
        const el = document.elementFromPoint(x, y);
        total++;
        if (!el || el === document.body || el === document.documentElement) empty++;
      }
      // Unstyled detection: when the site's own layout stylesheet returns 200 but doesn't apply
      // (throttled/partial archive of an @import or JS-injected CSS), the browser falls back to
      // its defaults — serif body text + default-blue (rgb(0,0,238)) underlined links. Real
      // marketing pages always override both. This signature catches the half-styled render that
      // still fills the fold (so emptyRatio and cssFailed both miss it): giant unconstrained logo,
      // bullet-list nav, Times body. See docs/CAPTURE_LEARNINGS.md.
      const bf = getComputedStyle(document.body).fontFamily.toLowerCase().trim();
      const serifDefault = bf === '' || bf.startsWith('times') || bf === 'serif';
      let defLinks = 0, sampled = 0;
      for (const a of Array.from(document.links).slice(0, 25)) {
        const cs = getComputedStyle(a); sampled++;
        if (cs.textDecorationLine.includes('underline') && cs.color === 'rgb(0, 0, 238)') defLinks++;
      }
      const unstyled = serifDefault || (sampled >= 4 && defLinks / sampled > 0.5);
      return { rules, broken, emptyRatio: empty / total, unstyled };
    });
    if (m.rules < 10) throw new Error('unstyled (CSS not loaded)');
    // Blank/void detection: capture the render now and measure pixel spread. A near-uniform image
    // (all-white void, or a page that reported "loaded" but painted nothing) has near-zero stdev
    // on every channel. This catches the class emptyRatio misses — invisible/whitespace nodes
    // still satisfy elementFromPoint, so a blank page can score emptyRatio=0 yet be all white.
    // We screenshot here (once per probed candidate) so blankness feeds candidate selection, not
    // just the final promote check; the buffer is reused by the caller as the saved shot.
    const png = await page.screenshot({ timeout: 120000, animations: 'disabled' });
    const stats = await sharp(png).stats();
    const maxStdev = Math.max(...stats.channels.map(c => c.stdev));
    const blank = maxStdev < 6;
    return { broken: m.broken, cssFailed, emptyRatio: m.emptyRatio, throttle503, unstyled: m.unstyled, blank, png };
  } finally {
    page.off('response', onResp);
  }
}

// Combined quality score (lower = better). A failed styling asset or a collapsed layout is
// far worse than a stray broken image, so they dominate; ties break on broken-image count.
function scoreOf(q) {
  const collapsed = q.emptyRatio > EMPTY_MAX;
  // A blank render is the worst outcome (nothing usable); an unstyled render is next (content
  // present but layout broken). Both must lose to any genuinely styled candidate, so they
  // dominate the score above css/collapse/broken.
  return (q.blank ? 3000 : 0) + (q.unstyled ? 1500 : 0)
    + q.cssFailed * 100 + (collapsed ? 1000 : 0) + q.broken;
}
const isClean = q => q.cssFailed === 0 && q.emptyRatio <= EMPTY_MAX && q.broken === 0 && !q.blank && !q.unstyled;

const isThrottleErr = (msg) => /\b429\b|\b503\b|Too Many|Service Unavailable|No server is available|REFUSED_STREAM|Timeout|ERR_CONNECTION|ERR_NETWORK|ERR_ABORTED/i.test(msg || '');

// --- Throttle governor -------------------------------------------------------------------
// The Internet Archive rate-limits per source IP with an *escalating* penalty: keep hammering
// through 503s and it graduates to a hard ~1-hour 429 ban. So instead of grinding (or quitting),
// we detect sustained throttling and PROACTIVELY pause on an escalating ladder — a short pause
// now lets the per-IP penalty decay and avoids the much longer forced ban. The run never exits:
// it can idle for hours/days, emitting IP-rotation recommendations, and resumes the moment the
// archive (or a fresh IP) is reachable again. Rotating your VPN/IP resets the limit instantly.
const throttle = {
  WINDOW: process.env.THROTTLE_WINDOW ? parseInt(process.env.THROTTLE_WINDOW, 10) : 40,
  NUDGE: process.env.THROTTLE_NUDGE ? parseInt(process.env.THROTTLE_NUDGE, 10) : 3,   // consecutive throttled picks before pausing
  LADDER: (process.env.THROTTLE_COOLDOWNS || '300,900,1800,3600').split(',').map(s => parseInt(s, 10)), // 5/15/30/60 min
  HEARTBEAT: 300,          // re-emit a reminder every 5 min during a long pause
  window: [],              // recent per-request outcomes (true = throttled)
  consec: 0,               // consecutive throttled picks
  level: 0,                // escalation level into the ladder
  note(throttled) { this.window.push(!!throttled); if (this.window.length > this.WINDOW) this.window.shift(); },
  rate() { return this.window.length ? this.window.filter(Boolean).length / this.window.length : 0; },
};

async function shotCount() {
  return (await readdir(`${OUT}shots`).catch(() => [])).filter(f => f.endsWith('.webp') && !f.startsWith('.tmp-')).length;
}

// Cheap liveness check: a single CDX request. 200 => archive reachable (throttle likely cleared).
async function livenessOk() {
  try {
    const r = await fetch(`https://web.archive.org/cdx/search/cdx?url=${DOMAIN}&output=json&limit=1&fl=timestamp&filter=statuscode:200`,
      { headers: { 'User-Agent': UA } });
    return r.ok;
  } catch { return false; }
}

// Called before each pick. While we're in sustained-throttle territory, pause on the escalating
// ladder and probe for recovery — never proceeding to a heavy render until the archive answers.
async function waitOutThrottle() {
  while (throttle.consec >= throttle.NUDGE) {
    const secs = throttle.LADDER[Math.min(throttle.level, throttle.LADDER.length - 1)];
    throttle.level++;
    const rate = Math.round(throttle.rate() * 100);
    const bar = '='.repeat(72);
    console.log(`\n${bar}`);
    console.log(`⚠  SUSTAINED ARCHIVE THROTTLING — this is a per-IP rate limit.`);
    console.log(`   ${throttle.consec} picks in a row hit 503/429; ${rate}% of the last ${throttle.window.length} requests throttled.`);
    console.log(`   →  RECOMMENDED: rotate your VPN / IP now for an instant reset. The run continues automatically on the new IP.`);
    console.log(`   Pausing ${Math.round(secs / 60)} min to let IA's per-IP penalty decay (a short pause now avoids escalating to IA's hard ~1-hour ban).`);
    console.log(`   Progress saved (${await shotCount()} shots). Nothing is lost; resuming after the pause.`);
    console.log(`${bar}\n`);
    for (let waited = 0; waited < secs;) {
      const chunk = Math.min(throttle.HEARTBEAT, secs - waited);
      await sleep(chunk * 1000);
      waited += chunk;
      if (waited < secs) console.log(`[throttle] cooling down — ~${Math.round((secs - waited) / 60)} min left. Rotate IP to skip the wait.`);
    }
    if (await livenessOk()) {
      console.log(`[throttle] archive reachable again — resuming normal capture.\n`);
      throttle.consec = 0; throttle.level = 0;
    } else {
      console.log(`[throttle] still unreachable after cooldown — escalating to a longer pause.`);
    }
  }
}

// Preserve any prior per-pick detail so a resumed/partial run doesn't lose it.
let priorManifest = [];
try { priorManifest = (JSON.parse(await readFile(`${OUT}snapshots.json`, 'utf8')).manifest) || []; } catch {}
const manifestByDate = new Map(priorManifest.map(m => [m.date, m]));
const record = (entry) => manifestByDate.set(entry.date, entry);

// snapshots.json is the viewer/grid feed; write it after every pick so a kill can't wipe
// progress. `shots` is scanned from disk (robust to SKIP_EXISTING / ONLY partial runs).
async function writeSnapshots() {
  const files = (await readdir(`${OUT}shots`).catch(() => [])).filter(f => f.endsWith('.webp') && !f.startsWith('.tmp-'));
  const shots = files.map(f => f.replace(/\.webp$/, '')).sort();   // strip extension (not a fixed slice: ".webp" is 5 chars)
  const manifest = [...manifestByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(`${OUT}snapshots.json`, JSON.stringify({
    key: site.key, name: site.name, domain: site.domain, accent: site.accent, shots, manifest,
  }, null, 2));
  return { shots, manifest };
}

for (const p of selected) {
  if (Date.now() > DEADLINE) { console.log(`deadline reached, stopping before ${p.date}`); break; }
  // resume: keep an existing shot unless it's explicitly queued for re-fetch
  if (SKIP_EXISTING && !REFETCH.has(p.date) && existsSync(`${OUT}shots/${p.date}.webp`)) {
    if (!manifestByDate.has(p.date)) record({ date: p.date, quarter: p.quarter, ok: true, skipped: true });
    console.log(`skip ${p.date} (existing)`);
    continue;
  }
  await waitOutThrottle();   // pause on the escalating ladder + emit IP-rotation nudges while throttled
  // No-degrade: render candidates to a temp file; only replace an existing shot if the new
  // best is actually clean. Under throttling a re-fetch can come back worse than what's on
  // disk — so a re-fetch may improve or keep, but never degrade a pre-existing capture.
  const finalPath = `${OUT}shots/${p.date}.webp`;
  const tmpPath = `${OUT}shots/.tmp-${p.date}.webp`;
  const preExisted = existsSync(finalPath);
  const candidates = await quarterCandidates(p);
  let best = null;   // {ts, broken, cssFailed, emptyRatio, score, clean}
  let pickThrottled = false;   // did this pick hit archive 503/429 (per-IP throttle signal)?
  for (const ts of candidates) {
    if (best && best.clean) break;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const page = await ctx.newPage();
      feedRate(page);   // feed responses to the adaptive rate controller
      try {
        const q = await probe(page, ts);
        throttle.note(q.throttle503 > 0);
        if (q.throttle503 > 0) pickThrottled = true;
        const score = scoreOf(q), clean = isClean(q);
        if (!best || score < best.score) {
          await sharp(q.png).webp({ quality: WEBP_QUALITY }).toFile(tmpPath);   // reuse probe's screenshot
          best = { ts, ...q, score, clean };
          const flags = `${q.blank ? ' BLANK' : ''}${q.unstyled ? ' UNSTYLED' : ''}`;
          const tag = clean ? ' (clean)'
            : ` (best so far: css=${q.cssFailed} empty=${q.emptyRatio.toFixed(2)} broken=${q.broken}${flags})`;
          console.log(`  ${p.date} ts=${ts} css=${q.cssFailed} empty=${q.emptyRatio.toFixed(2)} broken=${q.broken}${flags}${tag}`);
        }
        break; // styled render obtained for this candidate; move on (or stop if clean)
      } catch (e) {
        // A real 429 means back off hard (60s) to avoid IA's escalating IP ban; 503/overload
        // and timeouts are transient backend-capacity issues -> shorter graded backoff.
        const thr = isThrottleErr(e.message);
        throttle.note(thr);
        if (thr) pickThrottled = true;
        const is429 = /\b429\b|Too Many/i.test(e.message);
        const backoff = is429 ? 60000 : jitter([4000, 10000, 20000][attempt - 1]);
        console.log(`  ${p.date} ts=${ts} try ${attempt}/3: ${e.message} -> ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
      } finally {
        await page.close();
      }
    }
  }
  if (best) {
    // promote the temp render unless it would replace an existing shot with a non-clean one
    const promote = !preExisted || best.clean;
    if (promote) await rename(tmpPath, finalPath).catch(() => {});
    else await rm(tmpPath, { force: true }).catch(() => {});
    record({ date: p.date, quarter: p.quarter, ts: best.ts, alternate: best.ts !== p.ts,
      broken: best.broken, cssFailed: best.cssFailed, emptyRatio: +best.emptyRatio.toFixed(3),
      blank: !!best.blank, unstyled: !!best.unstyled,
      clean: best.clean, ok: true, keptExisting: !promote });
    const verdict = best.clean ? 'ok  ' : (promote ? 'WARN' : 'KEEP');
    const flags = `${best.blank ? ' BLANK' : ''}${best.unstyled ? ' UNSTYLED' : ''}`;
    const note = best.clean ? '' : promote ? ' <- no clean candidate (saved best)' : ' <- no clean candidate, kept existing shot';
    console.log(`${verdict} ${p.date} css=${best.cssFailed} empty=${best.emptyRatio.toFixed(2)} broken=${best.broken}${flags}${best.ts !== p.ts ? ` (alt ${best.ts})` : ''}${note}`);
  } else {
    await rm(tmpPath, { force: true }).catch(() => {});
    record({ date: p.date, quarter: p.quarter, ts: p.ts, ok: preExisted, keptExisting: preExisted });
    console.log(`${preExisted ? 'KEEP' : 'FAIL'} ${p.date}${preExisted ? ' (all candidates failed, kept existing shot)' : ''}`);
  }
  // track sustained throttling across picks: a broad run of throttled picks (not one stubborn
  // archive-degraded date) trips the cooldown gate on the next iteration.
  if (pickThrottled) {
    throttle.consec++;
  } else if (throttle.consec) {
    console.log(`[throttle] recovered — clean pass after ${throttle.consec} throttled pick(s).`);
    throttle.consec = 0; throttle.level = 0;
  }
  await writeSnapshots();   // persist after every pick (resumable)
  await sleep(GAP_MS);
}
await browser.close();

const { shots, manifest } = await writeSnapshots();
const rendered = manifest.filter(m => m.ok && !m.skipped);
const ok = shots.length;
const clean = manifest.filter(m => m.ok && m.clean).length;
const alts = manifest.filter(m => m.alternate).length;
const warn = rendered.filter(m => !m.clean).map(m => m.date);
console.log(`\nDone: ${ok} shots on disk, ${rendered.length} rendered this run, ${clean} clean, ${alts} used alternate capture.`);
if (warn.length) console.log(`No clean candidate found for: ${warn.join(', ')} (re-run later with REFETCH=)`);

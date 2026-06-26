import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = new URL('./', import.meta.url).pathname;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const ONLY = new Set((process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean)); // restrict to these dates
const GOTO = process.env.GOTO ? parseInt(process.env.GOTO, 10) : 90000;                 // per-nav timeout
const DEADLINE = process.env.DEADLINE ? Date.now() + parseInt(process.env.DEADLINE, 10) : Infinity; // wall-clock budget
const GAP_MS = 3500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdxJson(url, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.ok && text.trim().startsWith('[')) return JSON.parse(text);
    } catch {}
    await sleep(2500 * i);
  }
  throw new Error('CDX failed: ' + url);
}

// --- 1. monthly-collapsed captures -> one representative pick per quarter ---
const rows = (await cdxJson(
  'https://web.archive.org/cdx/search/cdx?url=goshippo.com&output=json' +
  '&fl=timestamp,original,statuscode,digest&filter=statuscode:200&collapse=timestamp:6'
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

await mkdir(`${OUT}above-the-fold`, { recursive: true });

// distinct captures available within a pick's quarter (primary ts first)
async function quarterCandidates(p) {
  const y = p.date.slice(0, 4);
  const qStartM = (Math.floor((+p.date.slice(5, 7) - 1) / 3) * 3) + 1;
  const from = `${y}${String(qStartM).padStart(2, '0')}01`;
  const to = `${y}${String(qStartM + 2).padStart(2, '0')}31`;
  let cands = [];
  try {
    const r = await cdxJson(
      'https://web.archive.org/cdx/search/cdx?url=goshippo.com&output=json&fl=timestamp,digest' +
      `&filter=statuscode:200&collapse=digest&from=${from}&to=${to}`, 4);
    cands = r.slice(1).map(row => row[0]);
  } catch {}
  return [...new Set([p.ts, ...cands.filter(ts => ts !== p.ts)])].slice(0, 6);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

// Load one timestamp and report quality. Throws on archive error / unstyled.
// Returns {broken} = count of <img> that failed to load (proxy for throttled assets,
// incl. the hero background which loads/fails together with logo images).
async function probe(page, ts) {
  const url = `https://web.archive.org/web/${ts}if_/https://goshippo.com/`;
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
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => {
    let rules = 0;
    for (const s of document.styleSheets) { try { rules += (s.cssRules || []).length; } catch { rules += 50; } }
    let broken = 0;
    for (const img of document.images) {
      if (img.getAttribute('src') && img.complete && img.naturalWidth === 0) broken++;
    }
    return { rules, broken };
  });
  if (m.rules < 10) throw new Error('unstyled (CSS not loaded)');
  return { broken: m.broken };
}

const manifest = [];
for (const p of selected) {
  if (Date.now() > DEADLINE) { console.log(`deadline reached, stopping before ${p.date}`); break; }
  const candidates = await quarterCandidates(p);
  let best = null;   // {ts, broken}
  for (const ts of candidates) {
    if (best && best.broken === 0) break;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const page = await ctx.newPage();
      try {
        const { broken } = await probe(page, ts);
        if (!best || broken < best.broken) {
          await page.screenshot({ path: `${OUT}above-the-fold/${p.date}.png`, timeout: 120000, animations: 'disabled' });
          best = { ts, broken };
          console.log(`  ${p.date} ts=${ts} broken=${broken}${broken === 0 ? ' (clean) saved' : ' saved (best so far)'}`);
        }
        break; // styled render obtained for this candidate; move on (or stop if clean)
      } catch (e) {
        const backoff = [4000, 10000, 20000][attempt - 1];
        console.log(`  ${p.date} ts=${ts} try ${attempt}/3: ${e.message} -> ${backoff / 1000}s`);
        await sleep(backoff);
      } finally {
        await page.close();
      }
    }
  }
  if (best) {
    manifest.push({ date: p.date, quarter: p.quarter, ts: best.ts, alternate: best.ts !== p.ts, broken: best.broken, ok: true });
    console.log(`ok   ${p.date} broken=${best.broken}${best.ts !== p.ts ? ` (alt ${best.ts})` : ''}`);
  } else {
    manifest.push({ date: p.date, quarter: p.quarter, ts: p.ts, ok: false });
    console.log(`FAIL ${p.date}`);
  }
  await sleep(GAP_MS);
}
await browser.close();
await writeFile(`${OUT}snapshots.json`, JSON.stringify(manifest, null, 2));
const ok = manifest.filter(m => m.ok).length;
const clean = manifest.filter(m => m.ok && m.broken === 0).length;
const alts = manifest.filter(m => m.alternate).length;
console.log(`\nDone: ${ok}/${manifest.length} ok, ${clean} fully clean (0 broken imgs), ${alts} used alternate capture.`);

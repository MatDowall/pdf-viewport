// End-to-end check in headless Chrome. Run: npm run test:browser
// Needs Chrome/Chromium: set CHROME=/path/to/chrome if not at /usr/bin/google-chrome.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.pdf': 'application/pdf' };
const server = http.createServer(async (req, res) => {
  try {
    const p = normalize(join(root, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(root)) throw 0;
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--force-device-scale-factor=2'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('pageerror', e));
await page.goto(`http://localhost:${port}/test/browser.html`);
await page.waitForFunction('window.ready === true', { timeout: 30000 });

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
  if (!ok) failed++;
};
const settle = () => new Promise((r) => setTimeout(r, 1500));

// 1. Initial render
let s = await page.evaluate(() => ({ renders: renders.map((r) => r.kind), z: vp.view.zoom }));
check('initial detail + backdrop rendered', s.renders.includes('detail'), JSON.stringify(s));
await settle();

// 2. Region rendering is pixel-identical to an independent PDF.js render of the same region
async function compareToReference() {
  return page.evaluate(async () => {
    const d = vp._detail;
    const p = d.plan;
    const ref = document.createElement('canvas');
    ref.width = p.bufW;
    ref.height = p.bufH;
    const ctx = ref.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, p.bufW, p.bufH);
    // Independent path: offset via getViewport offsetX/Y instead of render `transform`.
    const v = page.getViewport({ scale: p.scale, offsetX: -p.x * p.scale, offsetY: -p.y * p.scale });
    await page.render({ canvasContext: ctx, viewport: v }).promise;
    const a = d.canvas.getContext('2d').getImageData(0, 0, p.bufW, p.bufH).data;
    const b = ctx.getImageData(0, 0, p.bufW, p.bufH).data;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return { mean: diff / (a.length / 4) / 3, w: p.bufW, h: p.bufH, scale: p.scale };
  });
}
// 3. Rapid wheel zoom: no PDF.js render while moving, smooth frames, one render after settle
await page.mouse.move(600, 400);
const before = await page.evaluate(() => renders.length);
const frames = await page.evaluate(async () => {
  const times = [];
  let last = performance.now();
  let run = true;
  const tick = (t) => { times.push(t - last); last = t; if (run) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__startCount = renders.length;
  return new Promise((res) => {
    let i = 0;
    const iv = setInterval(() => {
      document.querySelector('.pdfv-root').dispatchEvent(new WheelEvent('wheel', { deltaY: -60, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
      if (++i === 60) {
        clearInterval(iv);
        const during = renders.length - window.__startCount;
        run = false;
        times.sort((a, b) => a - b);
        res({ during, onTime: times.filter((t) => t < 20).length / times.length, p95: times[Math.floor(times.length * 0.95)], frames: times.length, zoom: vp.view.zoom });
      }
    }, 16);
  });
});
check('no renders during 1 s of continuous wheel zoom', frames.during === 0, JSON.stringify(frames));
// (headless Chrome renders on the CPU; expect 1–2 slow frames on the very first gesture while the GPU-upload of the backdrop happens)
check('≥ 90% of frames on time (60 fps) while zooming 0.5× → 80×', frames.onTime >= 0.9, `${(frames.onTime * 100).toFixed(0)}% on time, p95 ${frames.p95.toFixed(1)} ms`);
await settle();
s = await page.evaluate((b) => ({ after: renders.slice(b).map((r) => `${r.kind} ${r.width}x${r.height} ${r.ms.toFixed(0)}ms`), zoom: vp.view.zoom, plan: vp._detail.plan }), before);
check('exactly one detail render after settle', s.after.filter((x) => x.startsWith('detail')).length === 1, JSON.stringify(s.after));
check(`detail canvas screen-sized at zoom ${s.zoom.toFixed(1)}`, s.plan.bufW <= 1200 * 2 * 1.7 + 4 && !s.plan.reduced, `${s.plan.bufW}x${s.plan.bufH}`);

// (fit-view comparison done separately below)
// 4. Deep zoom correctness
let c = await compareToReference();
check('deep zoom: detail matches reference render', c.mean < 0.5, JSON.stringify(c));

// 5. Pixel snapping: detail bitmap lands on whole device pixels
const snap = await page.evaluate(() => {
  const r = vp._detail.canvas.getBoundingClientRect();
  return { left: r.left * 2, top: r.top * 2, w: r.width * 2, bufW: vp._detail.plan.bufW };
});
check('detail canvas aligned to device pixels, 1:1 scale',
  Math.abs(snap.left - Math.round(snap.left)) < 0.01 && Math.abs(snap.w - snap.bufW) < 0.01, JSON.stringify(snap));

// 6. Small pan inside the rendered margin → no new render
const n0 = await page.evaluate(() => renders.length);
await page.evaluate(() => { vp.panBy(-150, -80); });
await settle();
const n1 = await page.evaluate(() => renders.length);
check('small pan within margin needs no re-render', n1 === n0, `${n1 - n0} renders`);

// 7. Big pan → re-render
await page.evaluate(() => { vp.panBy(-3000, 0); });
await settle();
const n2 = await page.evaluate(() => renders.length);
check('large pan triggers one re-render', n2 === n1 + 1, `${n2 - n1} renders`);

await page.evaluate(() => vp.fitPage());
await settle();
c = await compareToReference();
check('fit view: detail matches reference render', c.mean < 0.5, JSON.stringify(c));
await page.evaluate(() => vp.setView({ zoom: 30, panX: -30000, panY: -20000 }));
await settle();
await page.screenshot({ path: new URL('./deep-zoom.png', import.meta.url).pathname });

// 8. Extreme zoom (maxZoom) stays within canvas limits
s = await page.evaluate(async () => {
  vp.setView({ ...vp.view, zoom: 80 });
  await new Promise((r) => setTimeout(r, 1500));
  return vp._detail.plan;
});
check('zoom 80× (≈ 8000%) still renders a small sharp raster', s.bufW * s.bufH <= 16e6 && Math.abs(s.scale - 160) < 1e-6, `${s.bufW}x${s.bufH} @${s.scale}`);
await page.screenshot({ path: new URL('./max-zoom.png', import.meta.url).pathname });

await browser.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nall browser checks passed');
process.exit(failed ? 1 : 0);

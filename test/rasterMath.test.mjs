// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantizeZoom, fitBuffer, planDetail, zoomAbout, fitView, snapView } from '../src/rasterMath.js';

test('quantizeZoom rounds up onto 2^(n/8) ladder', () => {
  assert.equal(quantizeZoom(1, 8), 1);
  assert.equal(quantizeZoom(2, 8), 2);
  const q = quantizeZoom(1.05, 8);
  assert.ok(q >= 1.05 && q / 1.05 < Math.pow(2, 1 / 8));
  assert.equal(quantizeZoom(3.3, 0), 3.3);
});

test('fitBuffer respects side and pixel limits', () => {
  const a = fitBuffer(2384, 1684, 10, 8192, 16e6); // A1 at 10x
  assert.ok(a.bufW <= 8192 && a.bufH <= 8192 && a.bufW * a.bufH <= 16e6);
  assert.ok(a.reduced);
  const b = fitBuffer(100, 100, 2);
  assert.equal(b.bufW, 200);
  assert.equal(b.reduced, false);
});

test('planDetail: deep zoom on A1 stays screen-sized and pixel-snapped', () => {
  const pageW = 2384, pageH = 1684, viewW = 1600, viewH = 900, dpr = 2;
  // zoom 40x into the middle of the sheet
  const view = zoomAbout(fitView(pageW, pageH, viewW, viewH), 40, viewW / 2, viewH / 2);
  const p = planDetail(snapView(view, dpr), viewW, viewH, pageW, pageH, {
    dpr, rasterZoom: 40, margin: 0.35, maxSide: 8192, maxPixels: 16e6,
  });
  assert.ok(p);
  assert.equal(p.reduced, false);
  assert.ok(p.bufW <= viewW * dpr * 1.71 + 2, `bufW ${p.bufW}`);
  // region origin on the device-pixel grid
  assert.ok(Math.abs(p.x * p.scale - Math.round(p.x * p.scale)) < 1e-6);
  assert.ok(Math.abs(p.scale - 80) < 1e-9);
});

test('planDetail shrinks margin before resolution on huge screens', () => {
  const p = planDetail({ zoom: 20, panX: -20000, panY: -15000 }, 3840, 2160, 2384, 1684, {
    dpr: 2, rasterZoom: 20, margin: 0.5, maxSide: 8192, maxPixels: 16e6,
  });
  assert.ok(p.bufW * p.bufH <= 16e6);
  assert.ok(p.scale > 0);
});

test('zoomAbout keeps the anchor point fixed', () => {
  const v = { zoom: 1, panX: 10, panY: 20 };
  const z = zoomAbout(v, 3, 200, 150);
  const before = { x: (200 - v.panX) / v.zoom, y: (150 - v.panY) / v.zoom };
  const after = { x: (200 - z.panX) / z.zoom, y: (150 - z.panY) / z.zoom };
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
});

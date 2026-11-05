/**
 * rasterMath.js — pure functions (no DOM, no PDF.js) used by PdfViewport.
 *
 * Kept separate so they can be unit-tested in Node and reused in any port
 * (e.g. a Rust/Tauri or WebGL version of the same pipeline).
 *
 * COORDINATE SYSTEMS (used everywhere in this package)
 * ----------------------------------------------------
 *  page units   : PDF.js viewport at scale 1 (with the page's rotation applied).
 *                 1 unit = 1 PDF point = 1/72 inch on the printed sheet.
 *                 Origin top-left, y down.
 *  screen px    : CSS pixels inside the viewer container. Origin top-left.
 *  device px    : physical pixels = screen px × devicePixelRatio.
 *
 *  The view is { zoom, panX, panY } and maps page → screen as
 *      screenX = pageX * zoom + panX
 *      screenY = pageY * zoom + panY
 */

/**
 * Round a zoom value UP to the next step on a geometric ladder with
 * `stepsPerOctave` steps per doubling (8 → 1, 1.09, 1.19, 1.30 ... 2).
 *
 * Rounding UP means the raster is always rendered at >= the displayed zoom,
 * so the browser only ever DOWN-samples it slightly (stays sharp) and never
 * up-samples (would go soft). With 8 steps the worst case is a 9% downsample.
 *
 * stepsPerOctave <= 0 disables quantisation (returns zoom unchanged).
 *
 * @param {number} zoom
 * @param {number} stepsPerOctave
 */
export function quantizeZoom(zoom, stepsPerOctave) {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return 1;
  if (!(stepsPerOctave > 0)) return zoom;
  // -1e-9 so a zoom that is already exactly on a step doesn't jump to the next
  const n = Math.ceil(Math.log2(zoom) * stepsPerOctave - 1e-9);
  return Math.pow(2, n / stepsPerOctave);
}

/**
 * Given a desired raster size (w × h in page units at `scale` device px per
 * unit), reduce the scale until the bitmap fits the browser's canvas limits.
 *
 * Browsers silently fail (blank canvas) or crash above roughly:
 *   - 16384 px per side (Chrome/Firefox), 8192–16384 on some mobile/Safari
 *   - 16.7M–268M total pixels depending on browser/GPU memory (iOS Safari: ~16.7M)
 * Defaults of 8192 / 16M are safe everywhere.
 *
 * @returns {{scale:number, bufW:number, bufH:number, reduced:boolean}}
 */
export function fitBuffer(w, h, scale, maxSide = 8192, maxPixels = 16e6) {
  let s = scale;
  const longest = Math.max(w, h) * s;
  if (longest > maxSide) s *= maxSide / longest;
  const px = w * h * s * s;
  if (px > maxPixels) s *= Math.sqrt(maxPixels / px);
  return {
    scale: s,
    bufW: Math.max(1, Math.floor(w * s)),
    bufH: Math.max(1, Math.floor(h * s)),
    reduced: s < scale,
  };
}

/**
 * The part of the page currently visible on screen, in page units.
 * May extend beyond the page; use clampRect to intersect with the page.
 */
export function visiblePageRect(view, viewW, viewH) {
  return {
    x: -view.panX / view.zoom,
    y: -view.panY / view.zoom,
    w: viewW / view.zoom,
    h: viewH / view.zoom,
  };
}

export function clampRect(r, pageW, pageH) {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(pageW, r.x + r.w);
  const y1 = Math.min(pageH, r.y + r.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** true if rect `inner` lies fully inside rect `outer` (with a tiny tolerance) */
export function rectContains(outer, inner, eps = 1e-6) {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  );
}

/**
 * Plan the DETAIL raster: which part of the page to render, at what scale,
 * and how big the bitmap is.
 *
 *  1. Take the visible rect and grow it by `margin` (fraction of the view
 *     size on each side) so small pans after a render need no re-render.
 *  2. Clamp to the page.
 *  3. Snap the rect to the device-pixel grid at `scale` so each bitmap pixel
 *     lands exactly on a screen pixel (no resampling blur) — provided pan is
 *     also snapped to device pixels, which PdfViewport does on settle.
 *  4. If the bitmap would exceed canvas limits, first shrink the margin, then
 *     (only if still too big — e.g. 8K monitor) reduce the scale.
 *
 * @param {{zoom:number,panX:number,panY:number}} view
 * @param {number} viewW  container width, CSS px
 * @param {number} viewH  container height, CSS px
 * @param {number} pageW  page width, page units
 * @param {number} pageH  page height, page units
 * @param {object} o
 * @param {number} o.dpr               effective device pixel ratio (already capped)
 * @param {number} o.rasterZoom        zoom to render at (quantised or exact)
 * @param {number} o.margin            e.g. 0.5 = half a screen extra on every side
 * @param {number} o.maxSide
 * @param {number} o.maxPixels
 * @returns {null | {x:number,y:number,w:number,h:number,scale:number,bufW:number,bufH:number,reduced:boolean}}
 */
export function planDetail(view, viewW, viewH, pageW, pageH, o) {
  const vis = visiblePageRect(view, viewW, viewH);
  let margin = Math.max(0, o.margin);
  const targetScale = o.rasterZoom * o.dpr;

  for (let attempt = 0; attempt < 6; attempt++) {
    const grown = {
      x: vis.x - vis.w * margin,
      y: vis.y - vis.h * margin,
      w: vis.w * (1 + 2 * margin),
      h: vis.h * (1 + 2 * margin),
    };
    const r = clampRect(grown, pageW, pageH);
    if (!r) return null; // page entirely off-screen

    // snap to the device-pixel grid of this scale
    const s = targetScale;
    const px0 = Math.floor(r.x * s);
    const py0 = Math.floor(r.y * s);
    const px1 = Math.ceil((r.x + r.w) * s);
    const py1 = Math.ceil((r.y + r.h) * s);
    const snapped = { x: px0 / s, y: py0 / s, w: (px1 - px0) / s, h: (py1 - py0) / s };

    const fit = fitBuffer(snapped.w, snapped.h, s, o.maxSide, o.maxPixels);
    if (!fit.reduced || margin === 0) {
      return { ...snapped, scale: fit.scale, bufW: fit.bufW, bufH: fit.bufH, reduced: fit.reduced };
    }
    margin = margin > 0.05 ? margin / 2 : 0; // too big: trade margin before resolution
  }
  return null;
}

/** Zoom about a fixed screen point (cursor) — keeps that point stationary. */
export function zoomAbout(view, newZoom, sx, sy) {
  const k = newZoom / view.zoom;
  return {
    zoom: newZoom,
    panX: sx - k * (sx - view.panX),
    panY: sy - k * (sy - view.panY),
  };
}

/** View that fits the whole page in the container with `padding` CSS px. */
export function fitView(pageW, pageH, viewW, viewH, padding = 16) {
  const zoom = Math.max(1e-6, Math.min((viewW - 2 * padding) / pageW, (viewH - 2 * padding) / pageH));
  return {
    zoom,
    panX: (viewW - pageW * zoom) / 2,
    panY: (viewH - pageH * zoom) / 2,
  };
}

/** Round pan to the device-pixel grid so settled rasters map 1:1 to screen pixels. */
export function snapView(view, dpr) {
  return {
    zoom: view.zoom,
    panX: Math.round(view.panX * dpr) / dpr,
    panY: Math.round(view.panY * dpr) / dpr,
  };
}

export function sameView(a, b, eps = 1e-9) {
  return (
    Math.abs(a.panX - b.panX) < 1e-3 &&
    Math.abs(a.panY - b.panY) < 1e-3 &&
    Math.abs(a.zoom / b.zoom - 1) < eps
  );
}

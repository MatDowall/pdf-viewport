/**
 * PdfViewport — a fast, crisp, pan/zoom PDF page viewer built on PDF.js.
 *
 * Designed for on-screen takeoff / markup apps where users zoom deep into
 * large-format drawings (A1/A0) and expect it to stay smooth and sharp.
 *
 * See README.md for the full explanation. The short version — four ideas:
 *
 *  1. RENDER ONLY WHAT'S VISIBLE.  The sharp "detail" raster covers the
 *     visible part of the page (plus a margin), rendered at exactly screen
 *     resolution via PDF.js's `transform` offset. Its size depends on your
 *     monitor, not on the zoom level, so it never hits canvas size limits.
 *
 *  2. NEVER RE-RENDER DURING MOTION.  While the user pans/zooms we only
 *     change a CSS transform on bitmaps we already have (GPU-composited,
 *     ~0 cost). PDF.js runs only once the view has "settled".
 *
 *  3. ALWAYS HAVE SOMETHING TO SHOW.  A whole-page "backdrop" raster sits
 *     underneath, so panning past the detail area shows a softer image
 *     instead of blank white. The previous detail raster stays on screen
 *     (CSS-scaled) until its replacement is ready.
 *
 *  4. CANCEL / PAUSE STALE WORK.  A new view cancels the in-flight render if
 *     it's no longer useful, and renders pause between PDF.js slices while
 *     the user is interacting so input never stutters.
 *
 * Works with pdfjs-dist 4.x – 6.x. PDF.js itself is NOT bundled: you load the
 * document and hand this class a PDFPageProxy.
 */

import {
  quantizeZoom,
  fitBuffer,
  planDetail,
  visiblePageRect,
  clampRect,
  rectContains,
  zoomAbout,
  fitView,
  snapView,
} from './rasterMath.js';

/** @typedef {{zoom:number, panX:number, panY:number}} View */

/**
 * Position a raster canvas inside the world (page-unit) element.
 *
 * IMPORTANT: use a TRANSFORM, not left/top/width/height. Browsers round layout
 * boxes to 1/64 CSS px ("LayoutUnit" in Chrome). Inside a world scaled 80×
 * that rounding becomes ±0.5 device px → the bitmap is resampled → blur.
 * Transforms are floating point, so this stays exact at any zoom:
 *   CSS size = bitmap size (integer px), then scale(1/scale) into page units.
 */
function placeRaster(el, plan) {
  Object.assign(el.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: `${plan.bufW}px`,
    height: `${plan.bufH}px`,
    transformOrigin: '0 0',
    transform: `translate(${plan.x}px, ${plan.y}px) scale(${1 / plan.scale})`,
    // Promote to its own GPU layer up front so the first frame of a gesture
    // doesn't stall while the compositor creates layers. Safe for canvases:
    // the bitmap is sampled directly, so it never gets "stuck" at a raster scale.
    willChange: 'transform',
  });
}

const DEFAULTS = {
  /** Cap devicePixelRatio. 3× phones/4K-at-300% triple the pixel count for little visible gain. */
  maxDpr: 2,
  /**
   * 0 = render the detail raster at the EXACT zoom (sharpest; 1 bitmap px = 1 device px).
   * 8 = round zoom up to 8 steps per doubling (what Nezo does) — slightly softer
   *     (≤9% downsample) but more cache hits when users zoom back and forth.
   */
  zoomStepsPerOctave: 0,
  /** Extra area rendered around the visible rect, as a fraction of the view size per side. */
  detailMargin: 0.35,
  /** ms after the last wheel/pointer event before the view counts as settled and we render. */
  settleMs: 140,
  /** Browser canvas limits (safe on all desktop + iOS). */
  maxCanvasSide: 8192,
  maxCanvasPixels: 16e6,
  /**
   * Whole-page backdrop raster limits. Only seen while moving, so it can be soft.
   * Bigger = sharper while panning, but costs memory (4 bytes/px, × backdropCacheSize)
   * and a one-off GPU upload hitch the first time it's shown (measured ~1 frame
   * per 8 MP in software rendering). 3072 ≈ 27 MB for an A1 sheet.
   */
  backdropMaxSide: 3072,
  backdropMaxPixels: 8e6,
  /** Number of page backdrops kept in memory (for flicking between sheets). */
  backdropCacheSize: 6,
  /** Zoom limits. minZoom is relative to "fit page"; maxZoom is absolute CSS px per PDF point. */
  minZoomOfFit: 0.25,
  maxZoom: 80,
  /** Allow PDF.js to keep drawing while the user is moving (false = pause, smoother input). */
  drawWhileMoving: false,
  /** Built-in mouse/touch handling. Set false to drive the view yourself (setView/zoomAt/panBy). */
  interactive: true,
  /** Mouse buttons that pan: 0 left, 1 middle, 2 right. Use [1] if left-click is for your tools. */
  panButtons: [0, 1],
  /** Wheel zoom sensitivity (per wheel delta pixel). */
  wheelZoomSpeed: 0.0018,
  /** Keep at least this many CSS px of the page on screen when panning. */
  keepVisiblePx: 80,
  /** Page background colour (also fills canvases before PDF.js draws). */
  background: '#ffffff',
  /** Extra params passed straight to page.render() — e.g. annotationMode, optionalContentConfigPromise. */
  renderParams: {},
  /** Factory for raster canvases — override for OffscreenCanvas or testing. */
  createCanvas: (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  },
};

export class PdfViewport extends EventTarget {
  /**
   * @param {HTMLElement} container  Element to fill. Give it a size (CSS); we fill it 100%.
   * @param {Partial<typeof DEFAULTS>} [options]
   */
  constructor(container, options = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
    this.container = container;

    /** @type {View} */
    this.view = { zoom: 1, panX: 0, panY: 0 };
    this.page = null;
    this.rotation = 0;
    this.pageW = 0; // page units (PDF points, rotation applied)
    this.pageH = 0;
    this.viewW = 0; // container size, CSS px
    this.viewH = 0;

    this._interacting = false;
    this._settleTimer = 0;
    this._frameReq = 0;
    this._generation = 0; // bumps on setPage → invalidates all in-flight jobs

    /** The detail raster currently on screen: { canvas, plan } */
    this._detail = null;
    /** In-flight detail render: { task, canvas, plan, paused } */
    this._detailJob = null;
    /** In-flight backdrop render */
    this._backdropJob = null;
    /** LRU of { page, rotation, canvas, scale } */
    this._backdrops = [];

    this._buildDom();
    if (this.opts.interactive) this._bindInput();

    this._ro = new ResizeObserver(() => this._onResize());
    this._ro.observe(container);
    this._watchDpr();
    this._onResize();
  }

  // ------------------------------------------------------------------ public API

  /**
   * Show a page.
   * @param {import('pdfjs-dist').PDFPageProxy} page
   * @param {{rotation?:number, keepView?:boolean, renderParams?:object}} [o]
   *   rotation: extra rotation in degrees (added to the page's own /Rotate)
   *   keepView: keep the current zoom/pan (e.g. comparing revisions of the same sheet)
   * @returns {Promise<void>} resolves when the first sharp raster is on screen
   */
  async setPage(page, o = {}) {
    this._generation++;
    this._cancelJob('_detailJob');
    this._cancelJob('_backdropJob');
    this._dropDetail();

    this.page = page;
    this.rotation = ((page.rotate || 0) + (o.rotation || 0)) % 360;
    if (o.renderParams) this.opts.renderParams = o.renderParams;
    const vp1 = page.getViewport({ scale: 1, rotation: this.rotation });
    this._vp1 = vp1;
    this.pageW = vp1.width;
    this.pageH = vp1.height;
    this.world.style.width = `${this.pageW}px`;
    this.world.style.height = `${this.pageH}px`;

    // Show a cached backdrop instantly if we've seen this sheet before.
    const cached = this._findBackdrop(page, this.rotation);
    this._showBackdrop(cached);

    if (!o.keepView || !this.viewW) this.view = this._fit();
    this._applyView();

    const gen = this._generation;
    // Order matters: the sharp visible area first (what the user is looking at),
    // then the whole-page backdrop (only needed once they start moving).
    await this._renderDetailNow();
    if (gen === this._generation && !cached) this._renderBackdrop();
  }

  /** Current view (copy). */
  getView() {
    return { ...this.view };
  }

  /**
   * Set the view directly (e.g. restore a saved view, animate, "zoom to markup").
   * @param {View} view
   * @param {{settle?:boolean}} [o]  settle=false: treat as part of an ongoing gesture
   */
  setView(view, o = {}) {
    this.view = this._clampView({ ...view });
    if (o.settle === false) this._markInteracting();
    else this._settleSoon(0);
    this._requestFrame();
  }

  /** Zoom by `factor` keeping screen point (sx, sy) fixed. Defaults to view centre. */
  zoomAt(factor, sx = this.viewW / 2, sy = this.viewH / 2) {
    const z = this._clampZoom(this.view.zoom * factor);
    this.view = this._clampView(zoomAbout(this.view, z, sx, sy));
    this._markInteracting();
    this._requestFrame();
  }

  /** Pan by screen pixels. */
  panBy(dx, dy) {
    this.view = this._clampView({ ...this.view, panX: this.view.panX + dx, panY: this.view.panY + dy });
    this._markInteracting();
    this._requestFrame();
  }

  fitPage(padding = 16) {
    this.setView(this._fit(padding));
  }

  /** Screen CSS px (relative to container) → page units. */
  screenToPage(sx, sy) {
    return { x: (sx - this.view.panX) / this.view.zoom, y: (sy - this.view.panY) / this.view.zoom };
  }

  /** Page units → screen CSS px (relative to container). */
  pageToScreen(x, y) {
    return { x: x * this.view.zoom + this.view.panX, y: y * this.view.zoom + this.view.panY };
  }

  /**
   * Page units → PDF user space (points, y up, unrotated). Store markups/measurements
   * in THIS space: it doesn't change with rotation, zoom or viewer size.
   */
  pageToPdf(x, y) {
    const [px, py] = this._vp1.convertToPdfPoint(x, y);
    return { x: px, y: py };
  }

  /** PDF user space → page units. */
  pdfToPage(px, py) {
    const [x, y] = this._vp1.convertToViewportPoint(px, py);
    return { x, y };
  }

  /**
   * Re-render everything for the current page — call after changing layer
   * visibility (optional content), annotationMode, etc.
   */
  invalidate(renderParams) {
    if (renderParams) this.opts.renderParams = renderParams;
    if (!this.page) return;
    this._backdrops = this._backdrops.filter((b) => {
      if (b.page === this.page) this._releaseCanvas(b.canvas);
      return b.page !== this.page;
    });
    const page = this.page;
    this.setPage(page, { keepView: true, rotation: this.rotation - (page.rotate || 0) });
  }

  destroy() {
    this._generation++;
    this._cancelJob('_detailJob');
    this._cancelJob('_backdropJob');
    this._ro.disconnect();
    this._unwatchDpr?.();
    this._unbindInput?.();
    cancelAnimationFrame(this._frameReq);
    clearTimeout(this._settleTimer);
    this._dropDetail();
    for (const b of this._backdrops) this._releaseCanvas(b.canvas);
    this._backdrops = [];
    this.root.remove();
  }

  // ------------------------------------------------------------------ DOM

  _buildDom() {
    const c = this.container;
    if (getComputedStyle(c).position === 'static') c.style.position = 'relative';
    c.style.overflow = 'hidden';

    this.root = document.createElement('div');
    this.root.className = 'pdfv-root';
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      touchAction: 'none', // we handle pinch/pan ourselves
      userSelect: 'none',
      background: 'transparent',
    });

    // WORLD: an element sized in page units and CSS-transformed by the view.
    // Raster canvases live here. Moving the view = changing ONE transform.
    this.world = document.createElement('div');
    this.world.className = 'pdfv-world';
    Object.assign(this.world.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: '0 0',
      background: this.opts.background,
      boxShadow: '0 1px 6px rgba(0,0,0,.25)',
      // Without this, Chrome re-paints the world's own background + shadow at
      // the new scale on every zoom frame (measured: periodic 33 ms frames).
      // With it, that trivial content is painted once and just scaled.
      willChange: 'transform',
    });

    this.backdropEl = null; // canvas, inserted when ready

    // OVERLAY: a screen-sized SVG whose <g> gets an SVG `transform` attribute
    // (not a CSS transform). The browser re-rasterises vectors at the current
    // zoom, so markups stay razor sharp at any zoom. Draw in PAGE UNITS inside
    // `overlayGroup`; use vector-effect="non-scaling-stroke" for constant-width lines.
    const svgNS = 'http://www.w3.org/2000/svg';
    this.overlay = document.createElementNS(svgNS, 'svg');
    this.overlay.setAttribute('class', 'pdfv-overlay');
    Object.assign(this.overlay.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      overflow: 'visible',
      pointerEvents: 'none',
    });
    this.overlayGroup = document.createElementNS(svgNS, 'g');
    this.overlay.appendChild(this.overlayGroup);

    this.root.append(this.world, this.overlay);
    c.appendChild(this.root);
  }

  /** Apply the current view to the DOM. Called at most once per animation frame. */
  _applyView() {
    const { zoom, panX, panY } = this.view;
    this.world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    this.overlayGroup.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
    this.dispatchEvent(new CustomEvent('viewchange', { detail: { view: this.getView() } }));
  }

  _requestFrame() {
    if (this._frameReq) return;
    this._frameReq = requestAnimationFrame(() => {
      this._frameReq = 0;
      this._applyView();
    });
  }

  // ------------------------------------------------------------------ settle logic

  /** Called by every input event. Rendering waits until input stops for settleMs. */
  _markInteracting() {
    this._interacting = true;
    this._settleSoon(this.opts.settleMs);
  }

  _settleSoon(ms) {
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => this._settle(), ms);
  }

  _settle() {
    if (this._pointers?.size) {
      // finger/mouse still down: not settled yet
      this._settleSoon(this.opts.settleMs);
      return;
    }
    this._interacting = false;
    // Snap pan to whole device pixels so the new raster maps 1:1 onto the screen.
    this.view = snapView(this.view, this._dpr());
    this._applyView();
    this._renderDetailNow();
    // Resume a backdrop render that was paused mid-way by interaction.
    this._resume(this._backdropJob);
  }

  // ------------------------------------------------------------------ detail raster

  _planDetail() {
    if (!this.page || !this.viewW || !this.viewH) return null;
    const dpr = this._dpr();
    return planDetail(this.view, this.viewW, this.viewH, this.pageW, this.pageH, {
      dpr,
      rasterZoom: quantizeZoom(this.view.zoom, this.opts.zoomStepsPerOctave),
      margin: this.opts.detailMargin,
      maxSide: this.opts.maxCanvasSide,
      maxPixels: this.opts.maxCanvasPixels,
    });
  }

  /** Is raster `plan` good enough for the current view? (same resolution + covers what's visible) */
  _covers(plan, want) {
    if (!plan || !want) return false;
    if (Math.abs(plan.scale / want.scale - 1) > 1e-6) return false;
    const vis = clampRect(visiblePageRect(this.view, this.viewW, this.viewH), this.pageW, this.pageH);
    return !vis || rectContains(plan, vis);
  }

  async _renderDetailNow() {
    const want = this._planDetail();
    if (!want) return;

    // 1. What's on screen already covers the view at the right resolution → nothing to do.
    //    (This is what makes small pans after a render free.)
    if (this._covers(this._detail?.plan, want)) {
      this._cancelJob('_detailJob');
      return;
    }
    // 2. A render in flight will cover it → let it finish (resume if paused).
    if (this._detailJob && this._covers(this._detailJob.plan, want)) {
      this._resume(this._detailJob);
      return this._detailJob.done;
    }
    // 3. Otherwise cancel stale work and start a new render.
    this._cancelJob('_detailJob');
    const job = this._startRender(want, 'detail');
    this._detailJob = job;
    const ok = await job.done;
    if (this._detailJob === job) this._detailJob = null;
    if (!ok) return;

    // Swap in the new raster. The old one stayed visible (CSS-scaled) until now.
    const el = job.canvas;
    placeRaster(el, want);
    el.className = 'pdfv-detail';
    this.world.appendChild(el);
    this._dropDetail();
    this._detail = { canvas: el, plan: want };
  }

  _dropDetail() {
    if (!this._detail) return;
    this._detail.canvas.remove();
    this._releaseCanvas(this._detail.canvas);
    this._detail = null;
  }

  // ------------------------------------------------------------------ backdrop raster

  _renderBackdrop() {
    const page = this.page;
    const rotation = this.rotation;
    const want = fitBuffer(
      this.pageW,
      this.pageH,
      this.opts.backdropMaxSide / Math.max(this.pageW, this.pageH),
      this.opts.backdropMaxSide,
      this.opts.backdropMaxPixels,
    );
    const plan = { x: 0, y: 0, w: this.pageW, h: this.pageH, ...want };
    const job = this._startRender(plan, 'backdrop');
    this._backdropJob = job;
    job.done.then((ok) => {
      if (this._backdropJob === job) this._backdropJob = null;
      if (!ok) return;
      const entry = { page, rotation, canvas: job.canvas, scale: plan.scale };
      this._backdrops.unshift(entry);
      while (this._backdrops.length > this.opts.backdropCacheSize) {
        this._releaseCanvas(this._backdrops.pop().canvas);
      }
      if (this.page === page && this.rotation === rotation) this._showBackdrop(entry);
    });
  }

  _findBackdrop(page, rotation) {
    const i = this._backdrops.findIndex((b) => b.page === page && b.rotation === rotation);
    if (i < 0) return null;
    const [b] = this._backdrops.splice(i, 1);
    this._backdrops.unshift(b); // LRU bump
    return b;
  }

  _showBackdrop(entry) {
    if (this.backdropEl) this.backdropEl.remove();
    this.backdropEl = null;
    if (!entry) return;
    const el = entry.canvas;
    el.className = 'pdfv-backdrop';
    placeRaster(el, { x: 0, y: 0, scale: entry.scale, bufW: el.width, bufH: el.height });
    this.world.insertBefore(el, this.world.firstChild);
    this.backdropEl = el;
  }

  // ------------------------------------------------------------------ PDF.js rendering

  /**
   * Render page region `plan` into a fresh canvas.
   *
   * The key trick: PDF.js always renders the WHOLE page's coordinate space, so
   * to draw just a region we give it a viewport at the target scale and a
   * `transform` that shifts the region's top-left to (0,0). PDF.js clips to
   * the canvas, and skips most work outside it, so cost ∝ canvas size.
   *
   * @returns {{task:any, canvas:HTMLCanvasElement, plan:object, paused:Function|null, done:Promise<boolean>}}
   */
  _startRender(plan, kind) {
    const gen = this._generation;
    const page = this.page;
    const canvas = this.opts.createCanvas(plan.bufW, plan.bufH);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = this.opts.background;
    ctx.fillRect(0, 0, plan.bufW, plan.bufH);

    const viewport = page.getViewport({ scale: plan.scale, rotation: this.rotation });
    const t0 = performance.now();
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: [1, 0, 0, 1, -plan.x * plan.scale, -plan.y * plan.scale],
      ...this.opts.renderParams,
    });

    const job = { task, canvas, plan, paused: null, kind, done: null };

    // PDF.js renders in ~15 ms slices and asks permission before each one.
    // While the user is moving, hold the next slice until the view settles.
    task.onContinue = (cont) => {
      if (this._interacting && !this.opts.drawWhileMoving) job.paused = cont;
      else cont();
    };

    job.done = task.promise.then(
      () => {
        if (gen !== this._generation) {
          this._releaseCanvas(canvas);
          return false;
        }
        const ms = performance.now() - t0;
        this.dispatchEvent(
          new CustomEvent('render', { detail: { kind, ms, width: plan.bufW, height: plan.bufH, scale: plan.scale } }),
        );
        return true;
      },
      (err) => {
        this._releaseCanvas(canvas);
        if (err?.name !== 'RenderingCancelledException') {
          this.dispatchEvent(new CustomEvent('rendererror', { detail: { kind, error: err } }));
        }
        return false;
      },
    );
    return job;
  }

  _resume(job) {
    if (job?.paused) {
      const cont = job.paused;
      job.paused = null;
      cont();
    }
  }

  _cancelJob(key) {
    const job = this[key];
    if (!job) return;
    this[key] = null;
    job.paused = null; // never resume a cancelled task
    try {
      job.task.cancel();
    } catch {
      /* already finished */
    }
  }

  /** Setting a canvas to 0×0 frees its memory immediately (important on Safari/iOS). */
  _releaseCanvas(c) {
    if (!c) return;
    c.width = 0;
    c.height = 0;
  }

  // ------------------------------------------------------------------ geometry helpers

  _dpr() {
    return Math.min(window.devicePixelRatio || 1, this.opts.maxDpr);
  }

  _fit(padding = 16) {
    return snapView(fitView(this.pageW || 1, this.pageH || 1, this.viewW || 1, this.viewH || 1, padding), this._dpr());
  }

  _clampZoom(z) {
    const fit = this._fit().zoom;
    return Math.min(this.opts.maxZoom, Math.max(fit * this.opts.minZoomOfFit, z));
  }

  /** Stop the page being flung completely off screen. */
  _clampView(v) {
    if (!this.pageW) return v;
    const k = this.opts.keepVisiblePx;
    const w = this.pageW * v.zoom;
    const h = this.pageH * v.zoom;
    v.panX = Math.min(this.viewW - Math.min(k, w), Math.max(Math.min(k, w) - w, v.panX));
    v.panY = Math.min(this.viewH - Math.min(k, h), Math.max(Math.min(k, h) - h, v.panY));
    return v;
  }

  _onResize() {
    const r = this.container.getBoundingClientRect();
    if (r.width === this.viewW && r.height === this.viewH) return;
    const first = !this.viewW;
    this.viewW = r.width;
    this.viewH = r.height;
    if (!this.page) return;
    if (first) this.view = this._fit();
    this._requestFrame();
    this._settleSoon(this.opts.settleMs);
  }

  /** Re-render when the window moves to a screen with a different DPR (or browser zoom changes). */
  _watchDpr() {
    let mq;
    const onChange = () => {
      mq?.removeEventListener('change', onChange);
      listen();
      this._dropDetail();
      this._settleSoon(0);
    };
    const listen = () => {
      mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', onChange);
    };
    listen();
    this._unwatchDpr = () => mq?.removeEventListener('change', onChange);
  }

  // ------------------------------------------------------------------ input (optional)

  _bindInput() {
    const el = this.root;
    /** active pointers: id → {x, y} (container-relative CSS px) */
    this._pointers = new Map();
    let pinch = null; // { dist, cx, cy }

    const local = (e) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onWheel = (e) => {
      e.preventDefault();
      const p = local(e);
      // Normalise line/page wheel modes to pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewH : 1;
      let dy = e.deltaY * unit;
      // ctrlKey = trackpad pinch (Chrome/Edge/Firefox/Safari all send it this way) → stronger
      const speed = e.ctrlKey ? this.opts.wheelZoomSpeed * 5 : this.opts.wheelZoomSpeed;
      dy = Math.max(-200, Math.min(200, dy)); // tame huge free-spin wheel deltas
      this.zoomAt(Math.exp(-dy * speed), p.x, p.y);
    };

    const onDown = (e) => {
      const isTouch = e.pointerType === 'touch';
      if (!isTouch && !this.opts.panButtons.includes(e.button)) return;
      if (e.button === 1) e.preventDefault(); // stop Chrome's middle-click autoscroll
      el.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, local(e));
      pinch = null;
      this._markInteracting();
    };

    const onMove = (e) => {
      const prev = this._pointers.get(e.pointerId);
      if (!prev) return;
      const cur = local(e);
      this._pointers.set(e.pointerId, cur);

      if (this._pointers.size === 1) {
        this.panBy(cur.x - prev.x, cur.y - prev.y);
      } else if (this._pointers.size === 2) {
        // Two-finger pinch: zoom about the midpoint and pan with it.
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        if (pinch && pinch.dist > 0) {
          this.panBy(cx - pinch.cx, cy - pinch.cy);
          this.zoomAt(dist / pinch.dist, cx, cy);
        }
        pinch = { dist, cx, cy };
      }
    };

    const onUp = (e) => {
      if (!this._pointers.delete(e.pointerId)) return;
      pinch = null;
      this._settleSoon(this.opts.settleMs);
    };

    const onAux = (e) => e.button === 1 && e.preventDefault();

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('auxclick', onAux);
    el.addEventListener('contextmenu', (e) => this.opts.panButtons.includes(2) && e.preventDefault());

    this._unbindInput = () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('auxclick', onAux);
    };
  }
}

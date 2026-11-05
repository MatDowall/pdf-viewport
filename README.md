# pdf-viewport

A fast, crisp pan/zoom PDF page viewer on top of **PDF.js**, built for on-screen takeoff and markup apps.

- Stays **sharp at any zoom** (tested to 8000% on an A1 sheet with 0.05 pt hairlines)
- **60 fps** pan and zoom, because PDF.js never runs while you're moving
- **Pixel-exact**: each settled raster lands 1:1 on device pixels
- A crisp vector **SVG overlay** for your markups and measurements, in page coordinates
- Framework-free ES module. Works with `pdfjs-dist` 4.x – 6.x (tested on 6.5.438)

This is the same pipeline Nezo uses (viewport-only rendering, CSS transforms during motion, a whole-page backdrop, cancelling stale renders), with a few fixes on top.

---

## Quick start

```bash
npm i pdfjs-dist
# copy src/ into your project (or this whole folder as a local package)
```

```js
import * as pdfjsLib from 'pdfjs-dist';
import { PdfViewport } from './pdf-viewport/src/index.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const vp = new PdfViewport(document.getElementById('viewer'), {
  panButtons: [1],          // middle-mouse pans; left click is free for your tools
});

const doc  = await pdfjsLib.getDocument(url).promise;
const page = await doc.getPage(1);
await vp.setPage(page);     // resolves when the first sharp raster is on screen
```

The container needs a size (CSS). The viewer fills it and tracks resizes itself.

**Demo:** `npx serve .` in this folder, then open `/demo/`. Tick **show rasters** to see the detail raster (red outline) and the backdrop (tinted) while you pan and zoom.

---

## API

| | |
|---|---|
| `new PdfViewport(container, options?)` | See *Options* below |
| `await setPage(page, { rotation?, keepView?, renderParams? })` | Show a `PDFPageProxy`. `rotation` is added to the page's own `/Rotate`. `keepView` keeps zoom/pan (for revision compare). |
| `getView()` / `setView({zoom, panX, panY}, {settle?})` | Read or set the view. `zoom` = CSS px per PDF point. |
| `zoomAt(factor, sx?, sy?)` | Zoom about a screen point (default: centre) |
| `panBy(dx, dy)` | Pan by screen px |
| `fitPage(padding?)` | Fit the whole sheet |
| `screenToPage(sx, sy)` / `pageToScreen(x, y)` | Container CSS px ↔ page units |
| `pageToPdf(x, y)` / `pdfToPage(x, y)` | Page units ↔ PDF user space. **Store markups in PDF space**: it doesn't change with rotation, zoom or window size. |
| `invalidate(renderParams?)` | Re-render after changing layers (optional content), annotation mode, etc. |
| `overlayGroup` | SVG `<g>` in page units. Put your markups here. |
| `destroy()` | Free everything |

**Events** (it's an `EventTarget`):
- `viewchange`: fires every frame the view moves, `{ view }`. Use it to update HTML overlays and the zoom readout.
- `render`: `{ kind: 'detail'|'backdrop', ms, width, height, scale }`
- `rendererror`: `{ kind, error }`

**Units.** Page units = PDF points = 1/72 inch on paper. On-paper length in mm is `units × 25.4 / 72`. Multiply by the drawing scale (e.g. 100 for 1:100) for real-world size. Calibrate per sheet like any takeoff tool.

### Options (defaults)

| option | default | notes |
|---|---|---|
| `maxDpr` | `2` | Caps devicePixelRatio. 3× screens triple the pixel count for little visible gain. |
| `zoomStepsPerOctave` | `0` | `0` = render at the exact zoom (sharpest). `8` = Nezo-style rounding (see below). |
| `detailMargin` | `0.35` | Extra area rendered around the view, as a fraction of the view per side. Larger = more free panning, slower renders. |
| `settleMs` | `140` | How long input must stop before a render starts. |
| `maxCanvasSide` / `maxCanvasPixels` | `8192` / `16e6` | Safe on every browser including iOS Safari. |
| `backdropMaxSide` / `backdropMaxPixels` | `3072` / `8e6` | Whole-page low-res raster (~27 MB for A1). |
| `backdropCacheSize` | `6` | Sheets whose backdrop is kept, so flicking between pages is instant. |
| `minZoomOfFit` / `maxZoom` | `0.25` / `80` | |
| `drawWhileMoving` | `false` | `false` pauses PDF.js between slices while the user moves. |
| `interactive` | `true` | Built-in wheel / drag / two-finger pinch. Set `false` to drive the view yourself. |
| `panButtons` | `[0, 1]` | Mouse buttons that pan (0 left, 1 middle, 2 right). |
| `wheelZoomSpeed` | `0.0018` | |
| `renderParams` | `{}` | Passed to `page.render()`, e.g. `{ annotationMode, optionalContentConfigPromise }` |
| `createCanvas` | DOM canvas | Swap for `OffscreenCanvas` / tests |

---

## How it works

### Why the usual approach fails

The obvious approach is `page.render()` at `scale = zoom × dpr` into one canvas the size of the whole page. At 400% on an A1 sheet that canvas is about 19,000 × 13,500 px (260 MP, roughly 1 GB). Browsers silently refuse anything over about 16k px per side or 16–268 MP. So you either cap the scale, which goes **blurry**, or exceed the limit, which gives a **blank canvas or crashed tab**. And you re-render the whole page on every zoom step, which **lags**.

### The pipeline

```
 container (overflow hidden)
 ├─ world <div>            ← sized in page units; ONE CSS transform = the view
 │   ├─ backdrop <canvas>   whole page, ~3k px, soft  (shown while moving)
 │   └─ detail   <canvas>   visible area + margin, exactly screen-res, sharp
 └─ overlay <svg>
     └─ <g transform="…">   your markups, in page units, vector-crisp
```

**1. Render only what's visible** (`planDetail` in `rasterMath.js`).
Take the visible rectangle in page units, grow it by `detailMargin`, clamp it to the page, and snap it to the device-pixel grid. Then render just that region:

```js
const viewport = page.getViewport({ scale });            // scale = zoom × dpr
page.render({
  canvasContext: ctx,                                     // canvas = region size only
  viewport,
  transform: [1, 0, 0, 1, -region.x * scale, -region.y * scale],  // shift region to 0,0
});
```

PDF.js clips to the canvas and skips most work outside it. The canvas is always about screen size × (1 + 2·margin)², whatever the zoom level. At 8000% the raster is still 4080 × 2720 and renders in about 60 ms in the test.

**2. Never re-render during motion.**
Wheel and drag only update `{zoom, panX, panY}`, and once per animation frame we set:

```js
world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
```

The canvases are GPU layers, so this costs nothing. After `settleMs` with no input, the view counts as **settled**: pan is snapped to whole device pixels and one detail render runs. The test checks this: 0 renders during 1 s of continuous zooming from 0.5× to 80×, then exactly 1.

**3. Always have something to show.**
- The **backdrop** (whole page, low-res, rendered once per sheet and cached) fills the parts of the screen the detail raster doesn't cover while you pan.
- The **old detail raster stays up**, CSS-scaled, until the new one is ready. You see slightly soft content for about 50–200 ms, never white.
- Render order on `setPage`: **detail first** (what you're looking at), then the backdrop.

**4. Don't do useless work.**
- If the current raster already covers the view at the right scale (a small pan within the margin), **no render** happens.
- If an in-flight render will cover it, it's **kept** (and resumed if paused).
- Otherwise it's **cancelled** (`task.cancel()`; the `RenderingCancelledException` is expected and ignored).
- PDF.js renders in ~15 ms slices and calls `task.onContinue(cont)` before each one. While the user is moving we **hold** `cont` and release it on settle, so a long render never makes input stutter.

**5. Pixel exactness: the details that make it look *crisp* rather than *almost* crisp.**
- The region origin is snapped so `region.x × scale` is a whole number, and pan is rounded to whole device pixels on settle. Bitmap pixel *i* then lands exactly on device pixel *i*, with no resampling. The browser test checks this and compares against an independent PDF.js render: mean pixel difference is **0**.
- **Rasters are positioned with `transform`, not `left`/`top`/`width`.** Chrome rounds layout boxes to 1/64 px. Inside a world scaled 80×, that rounding became a **0.5 device-pixel offset** (found and fixed during testing), which blurs every hairline. Transforms are floating point.
- The overlay is an SVG `<g>` with a **`transform` attribute**, not a CSS transform, so the browser re-renders the vectors at every zoom. Use `vector-effect="non-scaling-stroke"` for constant-width lines.
- `will-change: transform` on the canvases and the world element. Without it, Chrome re-painted the world's background and shadow at the new scale on every zoom frame (measured: regular 33 ms frames).
- `devicePixelRatio` is capped at 2 and watched with `matchMedia`, so dragging the window to another monitor triggers a re-render at the new resolution.

### Nezo's zoom quantisation (`zoomStepsPerOctave: 8`)

Nezo rounds the render zoom **up** to steps of 2^(n/8), about 9% apart. Rounding up means the browser only ever shrinks the raster slightly (stays sharp) and never enlarges it (would go soft). It means more cache hits, and nudging the zoom by a hair doesn't trigger a render. The cost is that rasters are up to 9% larger than the screen and no longer map 1:1 onto pixels. The default here is exact zoom, for maximum sharpness. Try both in the demo.

---

## Tuning and gotchas

- **Very heavy PDFs** (scanned sheets, huge vector counts): renders are slower but stay just as smooth, because they only start after settle. Reduce `detailMargin` to `0.2` to shrink the work, or raise `settleMs` if renders keep starting mid-gesture.
- **Memory:** each backdrop is 4 bytes per pixel. 6 × 27 MB is fine on desktop. Use `backdropCacheSize: 2` on iPad.
- **Bigger backdrop** = sharper while panning, but a one-off GPU upload stall the first time it's shown. That stall measured about one frame per 8 MP in software rendering; on real GPUs it's a few ms.
- **Layers / optional content:** pass `optionalContentConfigPromise` in `renderParams`, then call `invalidate()` after toggling.
- **Annotations:** PDF.js draws annotation appearances by default. Pass `{ annotationMode: pdfjsLib.AnnotationMode.DISABLE }` if your own markups replace them.
- **Text selection / search** isn't included. PDF.js's `TextLayer` can be added in the world element if you need it.
- **Tools:** use `screenToPage` on pointer events and draw into `overlayGroup`. For thousands of markups, switch the overlay to a canvas redrawn on `viewchange`; the coordinate maths is the same.
- **Multiple pages on screen** (continuous scroll): run one `PdfViewport` per visible page, or extend `planDetail` to loop over page rectangles. The maths is per page.

### Porting (Tauri / native / WebGL)

The pipeline doesn't depend on PDF.js. Swap the renderer for PDFium/MuPDF (e.g. in Rust: render the region to RGBA with a matrix offset) and keep:
1. a whole-page backdrop texture, plus a visible-region detail texture at exact screen resolution,
2. GPU transforms only while moving; render on settle,
3. cancel or reuse by "same scale and covers the visible rect",
4. pixel-snap the region origin and the pan.

All the geometry is in `src/rasterMath.js` (pure functions, unit tested), so it ports directly.

---

## Files

```
src/
  PdfViewport.js   viewer class: DOM, settle/render scheduling, cache, input
  rasterMath.js    pure geometry: planDetail, fitBuffer, quantizeZoom, zoomAbout…
  index.js         exports
demo/index.html    drop-a-PDF demo with measuring tool + raster debug view
test/
  rasterMath.test.mjs   npm test          (Node, no browser)
  browser.test.mjs      npm run test:browser  (headless Chrome via puppeteer-core)
  makeFixture.mjs       generates fixtures/a1-test-sheet.pdf (A1, 0.05–0.2 pt hairlines)
```

### Test results (headless Chrome, DPR 2, 1200×800 viewer, A1 test sheet)

```
PASS  no renders during 1 s of continuous wheel zoom (0.5× → 80×)
PASS  ≥ 90% of frames on time (60 fps) while zooming — 97%, p95 16.8 ms
PASS  exactly one detail render after settle — 4080×2720 in ~30–70 ms
PASS  deep zoom: detail matches independent reference render (mean diff 0)
PASS  detail canvas aligned to device pixels, 1:1 scale
PASS  small pan within margin needs no re-render
PASS  large pan triggers exactly one re-render
PASS  fit view matches reference render
PASS  zoom 80× (≈ 8000%) still renders a small sharp raster
```

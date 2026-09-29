// Camera / view transform for pan + zoom (FR-4).
//
// This is VIEW state, not project data — it is not part of the model and is
// never exported. It maps between world coordinates (meters) and screen
// coordinates (CSS pixels). The renderer owns one; tools read it to convert
// pointer positions into world coordinates.

import { clamp } from '../utils/geometry.js';

const MIN_SCALE = 0.2; // px per meter (zoomed way out)
const MAX_SCALE = 400; // px per meter (zoomed way in)

export class Camera {
  constructor() {
    this.scale = 8; // screen pixels per meter
    this.panX = 0; // screen-pixel position of world origin x=0
    this.panY = 0; // screen-pixel position of world origin y=0
    this.initialised = false;
  }

  worldToScreen(wx, wy) {
    return { x: wx * this.scale + this.panX, y: wy * this.scale + this.panY };
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.panX) / this.scale, y: (sy - this.panY) / this.scale };
  }

  /** Pan by a screen-pixel delta (drag / space-drag). */
  panBy(dxPx, dyPx) {
    this.panX += dxPx;
    this.panY += dyPx;
  }

  /**
   * Zoom by `factor` about a screen point, keeping the world point currently
   * under that pixel fixed (scroll-to-zoom under the cursor).
   */
  zoomAt(sx, sy, factor) {
    const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    const k = next / this.scale;
    this.panX = sx - (sx - this.panX) * k;
    this.panY = sy - (sy - this.panY) * k;
    this.scale = next;
  }

  /** Fit a world rectangle [0..worldW] x [0..worldH] into the view ("fit to view"). */
  fit(worldW, worldH, viewW, viewH, pad = 32) {
    const fitScale = Math.min(
      (viewW - pad * 2) / worldW,
      (viewH - pad * 2) / worldH,
    );
    this.scale = clamp(fitScale, MIN_SCALE, MAX_SCALE);
    this.panX = (viewW - worldW * this.scale) / 2;
    this.panY = (viewH - worldH * this.scale) / 2;
    this.initialised = true;
  }
}

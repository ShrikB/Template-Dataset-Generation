// Scatter region rendering layer (FR-17, FR-18).
//
// Drawing only: reads the project model plus a transient scatterTool
// overlay (in-progress drag rect - view state, not model data, same
// category as camera.js / roadLayer's overlay), never mutates either.
//
// The dots themselves are not decided here: model/scatterPreview.js owns
// each region's preview points (the same points Flatten places), and this
// layer only draws what it returns. Passing the same ScatterPreview on every
// call keeps the dots stable across redraws.

import { CATEGORY_COLORS } from '../../utils/categories.js';
import { ScatterPreview } from '../../model/scatterPreview.js';

const OUTLINE_ALPHA = 0.7;
const PREVIEW_DOT_RADIUS_PX = 3;
// Below this on-screen size an instance's footprint rect is unreadable (a 1 m
// person is a sub-pixel speck when zoomed out) - fall back to the dot, which
// keeps the region's density legible at any zoom.
const MIN_INSTANCE_DRAW_PX = 3;
const PREVIEW_ALPHA = 0.85;
const DRAFT_DASH = [4, 3];
const REGION_DASH = [6, 4];

export function drawScatterRegions(
  ctx, worldToScreen, project, overlay = null, preview = new ScatterPreview(), manifest = null,
) {
  const visible = project.scatterRegions.filter((r) => project.isLayerVisible(r.category));
  const previews = preview.previewAll(project, manifest, visible);
  for (const region of visible) {
    const color = CATEGORY_COLORS[region.category];
    const { footprint, points } = previews.get(region.id);
    _drawRegionOutline(ctx, worldToScreen, region, color);
    _drawPreviewPoints(ctx, worldToScreen, points, color, footprint);
  }

  if (overlay && overlay.drag) {
    _drawDraftOutline(ctx, worldToScreen, overlay.drag, CATEGORY_COLORS[overlay.category]);
  }
}

function _drawRegionOutline(ctx, worldToScreen, region, color) {
  const a = worldToScreen(region.x, region.y);
  const b = worldToScreen(region.x + region.width, region.y + region.height);
  ctx.save();
  ctx.globalAlpha = OUTLINE_ALPHA;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(REGION_DASH);
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.restore();
}

// Each instance draws at the real area it occupies (meters), so a region of
// vehicles visibly fills up and a region of people barely does - the count
// alone never showed that. Mapping both corners through worldToScreen keeps
// this layer free of any camera/scale knowledge of its own.
function _drawPreviewPoints(ctx, worldToScreen, points, color, footprint) {
  if (points.length === 0) return;
  const halfW = footprint.width / 2;
  const halfD = footprint.depth / 2;
  ctx.save();
  ctx.globalAlpha = PREVIEW_ALPHA;
  ctx.fillStyle = color;
  for (const p of points) {
    const a = worldToScreen(p.x - halfW, p.y - halfD);
    const b = worldToScreen(p.x + halfW, p.y + halfD);
    const w = b.x - a.x;
    const h = b.y - a.y;
    ctx.beginPath();
    if (Math.min(w, h) < MIN_INSTANCE_DRAW_PX) {
      const s = worldToScreen(p.x, p.y);
      ctx.arc(s.x, s.y, PREVIEW_DOT_RADIUS_PX, 0, Math.PI * 2);
    } else {
      ctx.rect(a.x, a.y, w, h);
    }
    ctx.fill();
  }
  ctx.restore();
}

function _drawDraftOutline(ctx, worldToScreen, drag, color) {
  const a = worldToScreen(drag.x0, drag.y0);
  const b = worldToScreen(drag.x1, drag.y1);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(DRAFT_DASH);
  ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  ctx.restore();
}

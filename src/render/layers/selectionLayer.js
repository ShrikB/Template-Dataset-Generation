// Select-tool rendering layer (FR-13, FR-14).
//
// Drawing only: reads the project model plus a transient selectTool
// overlay (selected ids, marquee rect, rotation handle - view state, not
// model data, same category as camera.js / roadLayer's overlay), never
// mutates either.

import { buildingFootprint } from '../../model/entities/building.js';
import { rotatedRectCorners } from '../../utils/geometry.js';

const SELECT_COLOR = '#4b9fd6';
const MARQUEE_FILL = 'rgba(75, 159, 214, 0.12)';
const HANDLE_COLOR = '#e0c34a';
const MARKER_HALO_RADIUS = 10; // px - matches canvasRenderer's fixed 6px marker + a small ring gap

export function drawSelection(ctx, worldToScreen, project, overlay, manifest = null) {
  if (!overlay) return;

  _drawHighlights(ctx, worldToScreen, project, overlay.selectedIds, manifest);
  if (overlay.rotateHandle) _drawRotateHandle(ctx, worldToScreen, project, overlay);
  if (overlay.marquee) _drawMarquee(ctx, worldToScreen, overlay.marquee);
}

function _drawHighlights(ctx, worldToScreen, project, selectedIds, manifest) {
  if (!selectedIds || selectedIds.length === 0) return;
  ctx.save();
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 2;
  for (const id of selectedIds) {
    const entity = project.getEntity(id);
    if (!entity) continue;
    if (entity.type === 'road') {
      _drawRoadHighlight(ctx, worldToScreen, entity);
    } else if (entity.type === 'scatterRegion') {
      _drawRegionHighlight(ctx, worldToScreen, entity);
    } else if (entity.type === 'building') {
      _drawBuildingHighlight(ctx, worldToScreen, entity, manifest);
    } else {
      const s = worldToScreen(entity.x, entity.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, MARKER_HALO_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function _drawRoadHighlight(ctx, worldToScreen, road) {
  ctx.beginPath();
  const p0 = worldToScreen(road.points[0].x, road.points[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < road.points.length; i++) {
    const p = worldToScreen(road.points[i].x, road.points[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function _drawRegionHighlight(ctx, worldToScreen, region) {
  const a = worldToScreen(region.x, region.y);
  const b = worldToScreen(region.x + region.width, region.y + region.height);
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
}

function _drawBuildingHighlight(ctx, worldToScreen, building, manifest) {
  const { width, depth } = buildingFootprint(building, manifest);
  const corners = rotatedRectCorners(building.x, building.y, width, depth, building.rotation)
    .map((p) => worldToScreen(p.x, p.y));
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.stroke();
}

function _drawRotateHandle(ctx, worldToScreen, project, overlay) {
  const id = overlay.selectedIds[0];
  const entity = project.getEntity(id);
  if (!entity) return;
  const center = worldToScreen(entity.x, entity.y);
  const handle = worldToScreen(overlay.rotateHandle.x, overlay.rotateHandle.y);

  ctx.save();
  ctx.strokeStyle = HANDLE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(handle.x, handle.y);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = HANDLE_COLOR;
  ctx.strokeStyle = '#0d0f13';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(handle.x, handle.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function _drawMarquee(ctx, worldToScreen, marquee) {
  const a = worldToScreen(marquee.x0, marquee.y0);
  const b = worldToScreen(marquee.x1, marquee.y1);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);

  ctx.save();
  ctx.fillStyle = MARQUEE_FILL;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

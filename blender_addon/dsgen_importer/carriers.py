"""Turns a checked layout into "carrier" data: plain lists of vertices, edges
and per-point attributes that the importer hands to Blender as bare meshes
for its geometry-node groups to build on.

No Blender imports here either (see layout_file.py), so the numbers that end
up in Blender can be tested with plain Python (blender_addon/tests/).
"""
import math

from .layout_file import CONNECTION_TOLERANCE, point_z


def box_carrier(layout, category):
    """One point per placed entity of `category`, with the size of its box.

    Returns None when the layout has none. Sizes come from the file alone: the
    entity's own `footprint` (FMT-8), and for height the entity's `height`
    (buildings) or, for the rest, its asset's `fallback.height` (Document 2
    §6.4). `default_height` is used only if the file gives neither.
    """
    entities = layout.entities(category)
    if not entities:
        return None
    variants = sorted({e["variantId"] for e in entities})
    heights = [_height(layout, e) for e in entities]
    attrs = {
        "width": ("FLOAT", [e["footprint"]["width"] for e in entities]),
        "depth": ("FLOAT", [e["footprint"]["depth"] for e in entities]),
        "rotation": ("FLOAT", [math.radians(e.get("rotation", 0.0)) for e in entities]),
        "variant": ("INT", [variants.index(e["variantId"]) for e in entities]),
    }
    # only when every point has one - the node group falls back to its own
    # Default Height for a carrier without the attribute
    if all(h is not None for h in heights):
        attrs["height"] = ("FLOAT", heights)
    return {
        "verts": [(e["x"], e["y"], point_z(e)) for e in entities],
        "edges": [],
        "attrs": attrs,
        "variants": variants,
        "ids": [e["id"] for e in entities],
    }


def _height(layout, entity):
    if "height" in entity:
        return entity["height"]
    return layout.asset(entity["variantId"]).get("fallback", {}).get("height")


def base_carrier(layout):
    """The base slab as a single box point, or None for an empty layout."""
    base = layout.base
    if not base:
        return None
    return {
        "verts": [(base["x"], base["y"], point_z(base))],
        "edges": [],
        "attrs": {
            "width": ("FLOAT", [base["width"]]),
            "depth": ("FLOAT", [base["depth"]]),
            "rotation": ("FLOAT", [0.0]),
            "variant": ("INT", [0]),
            "height": ("FLOAT", [base["thickness"]]),
        },
        "variants": [base.get("material", "")],
        "ids": ["base"],
    }


def road_carriers(layout):
    """Road centerlines as edges, one carrier per surface: {surface: carrier}.

    A closed road's last point repeats its first (Document 2 §8), so it is
    dropped and the loop is closed with an edge instead.
    """
    by_surface = {}
    for road in layout.roads:
        by_surface.setdefault(road.get("surface") or "default", []).append(road)

    carriers = {}
    for surface, roads in by_surface.items():
        verts, edges, widths = [], [], []
        for road in roads:
            pts = [(p["x"], p["y"], point_z(p)) for p in road["points"]]
            closed = bool(road.get("closed", False))
            if closed and len(pts) > 1:
                pts.pop()
            # two points on the same spot make a zero-length edge, which the
            # curve nodes can't give a direction
            pts = [p for i, p in enumerate(pts)
                   if i == 0 or math.dist(p[:2], pts[i - 1][:2]) > CONNECTION_TOLERANCE]
            if len(pts) < 2:
                continue
            start = len(verts)
            verts += pts
            widths += [road["width"]] * len(pts)
            edges += [(start + i, start + i + 1) for i in range(len(pts) - 1)]
            if closed and len(pts) > 2:
                edges.append((start + len(pts) - 1, start))
        carriers[surface] = {
            "verts": verts,
            "edges": edges,
            "attrs": {"width": ("FLOAT", widths)},
            "ids": [r.get("id", "") for r in roads],
        }
    return carriers


def unbuilt_sections(layout):
    """What the file contains that this proof-of-concept importer does not
    build yet, as one line each - so nothing is dropped silently."""
    notes = []
    markings = sum(
        len((r.get("markingGeometry") or {}).get(kind) or [])
        for r in layout.roads for kind in ("lines", "areas"))
    if markings:
        notes.append("%d road marking shape(s) are not built yet" % markings)
    if layout.junctions:
        notes.append("%d junction patch(es) are not built yet" % len(layout.junctions))
    if layout.scatter_regions:
        notes.append("%d scatter region(s) are not expanded yet" % len(layout.scatter_regions))
    if layout.assets:
        notes.append("every asset is built as a plain box - sources and fallback shapes are not used yet")
    return notes

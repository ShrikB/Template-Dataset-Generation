"""Reads and checks a DSGen layout export (the `city-layout` format).

The format is defined by Document 2 (docs/requirements/02-export-format.md);
the FMT-### numbers below are its rule ids. This module is the ONE place that
knows where things live in the file, so a regrouping of the format touches
only this file. It has no Blender imports, so it can be tested with plain
Python (blender_addon/tests/).

    layout = load_layout(path)     # raises LayoutError: nothing may be built
    layout.entities("buildings")   # checked placements, ready to build
    layout.warnings                # everything the user should be told

What it checks before anything is built (Document 2 §14):
  errors (LayoutError)  unknown or placeholder format version; a reference
                        from the layout into the library that doesn't resolve;
                        duplicate id / uid / index; an absolute source path
  warnings (continue)   newer minor version; unknown keys; unknown enum values
"""
import json
import re

FORMAT_NAME = "city-layout"
SUPPORTED_MAJOR = 1
SUPPORTED_MINOR = 0

# Road points within this distance are the same location (Document 2 §9).
CONNECTION_TOLERANCE = 1e-6

TOP_LEVEL_KEYS = {
    "formatVersion", "generatedAt", "manifestVersion", "conventions",
    "previewImage", "library", "layout", "warnings",
}
LIBRARY_KEYS = {"assetRoot", "assets", "materials"}
LAYOUT_KEYS = {
    "canvas", "base", "buildings", "props", "vehicles", "people",
    "roads", "junctions", "scatterRegions",
}

# layout array -> the `type` its entries carry; the array name is also the
# asset category its entries are placed from.
POINT_ENTITY_TYPES = {
    "buildings": "building", "props": "prop", "vehicles": "vehicle", "people": "person",
}
ASSET_CATEGORIES = set(POINT_ENTITY_TYPES)
SOURCE_KINDS = {"file", "procedural"}
FALLBACK_SHAPES = {"box", "cylinder", "cone"}
MATERIAL_KINDS = {"surface", "marking", "ground"}
SCATTER_CATEGORIES = {"people", "vehicles"}

_VERSION = re.compile(r"^%s/(\d+)\.(\d+)$" % re.escape(FORMAT_NAME))
_DRIVE = re.compile(r"^[A-Za-z]:")


class LayoutError(ValueError):
    """The file can't be imported. The message names the field or id at fault."""


class Layout:
    """A checked layout file. Everything the builder needs, by name."""

    def __init__(self, data, warnings):
        library = _group(data, "library")
        layout = _group(data, "layout")
        self.format_version = data["formatVersion"]
        self.asset_root = library.get("assetRoot") or "assets"
        self.canvas = layout.get("canvas") or {}
        self.base = layout.get("base")  # None for an empty layout
        self.roads = _array(layout, "roads")
        self.junctions = _array(layout, "junctions")
        self.scatter_regions = _array(layout, "scatterRegions")
        # Non-blocking issues the editor wrote at export time (Document 2 §13).
        self.file_warnings = _array(data, "warnings")
        # What THIS import has to report: importer warnings first, then the
        # file's own, so the user sees one combined list.
        self.warnings = list(warnings) + [_file_warning_text(w) for w in self.file_warnings]
        self._assets = {a["id"]: a for a in _array(library, "assets")}
        self._materials = {m["id"]: m for m in _array(library, "materials")}
        self._entities = {name: _array(layout, name) for name in POINT_ENTITY_TYPES}

    def entities(self, category):
        """The placements of one category: "buildings", "props", "vehicles" or "people"."""
        return self._entities[category]

    def asset(self, asset_id):
        """The library entry a `variantId` points at."""
        return self._assets[asset_id]

    def material(self, material_id):
        """The library entry a `surface` / marking `material` / `base.material` points at."""
        return self._materials[material_id]

    @property
    def assets(self):
        return list(self._assets.values())

    @property
    def materials(self):
        return list(self._materials.values())


def load_layout(path):
    """Read and check the export at `path`."""
    with open(path, encoding="utf-8") as f:
        try:
            data = json.load(f)
        except ValueError as err:
            raise LayoutError("not a JSON file: %s" % err) from err
    return read_layout(data)


def read_layout(data):
    """Check a parsed export and return a Layout. Raises LayoutError."""
    if not isinstance(data, dict):
        raise LayoutError("the file is not a layout export (its root is not a JSON object)")
    warnings = []
    _check_version(data, warnings)

    library = _group(data, "library")
    layout = _group(data, "layout")
    _report_unknown_keys(data, TOP_LEVEL_KEYS, "", warnings)
    _report_unknown_keys(library, LIBRARY_KEYS, "library.", warnings)
    _report_unknown_keys(layout, LAYOUT_KEYS, "layout.", warnings)

    _check_library_table(library, "assets", warnings)
    _check_library_table(library, "materials", warnings)
    _check_entries(layout)
    _check_unique_ids(layout)
    _check_references(library, layout)
    data = _without_unknown_enums(data, warnings)
    return Layout(data, warnings)


def point_z(point):
    """A point's or entity's elevation. 1.0 files carry none: missing means 0 (FMT-30)."""
    z = point.get("z", 0.0)
    return z if isinstance(z, (int, float)) and not isinstance(z, bool) else 0.0


# --- version (FMT-1..4, FMT-25) ---------------------------------------------

def _check_version(data, warnings):
    version = data.get("formatVersion")
    if isinstance(version, str) and version.startswith("placeholder"):
        raise LayoutError(
            'this file uses the old "%s" format - export it again from the web editor' % version)
    if isinstance(version, str) and version.startswith("project-"):
        # The editor's own Save file (to reopen a layout in the editor) - an
        # easy mix-up, since Save and Export both download a .json.
        raise LayoutError(
            'this is an editor project file ("%s"), written by the Save button - '
            "use the Export button in the web editor and import that file instead" % version)
    match = _VERSION.match(version) if isinstance(version, str) else None
    if not match:
        raise LayoutError(
            'unrecognized formatVersion %s - expected "%s/%d.x"'
            % (json.dumps(version), FORMAT_NAME, SUPPORTED_MAJOR))
    major, minor = int(match.group(1)), int(match.group(2))
    if major != SUPPORTED_MAJOR:
        raise LayoutError(
            'formatVersion "%s" is not supported - this importer reads %s/%d.x'
            % (version, FORMAT_NAME, SUPPORTED_MAJOR))
    if minor > SUPPORTED_MINOR:
        warnings.append(
            'the file is format "%s", newer than this importer (%s/%d.%d) - some features may be ignored'
            % (version, FORMAT_NAME, SUPPORTED_MAJOR, SUPPORTED_MINOR))


# --- structure ---------------------------------------------------------------

def _group(data, key):
    """A group object; an absent one is `{}` (Document 2 §4)."""
    group = data.get(key)
    if group is None:
        return {}
    if not isinstance(group, dict):
        raise LayoutError('"%s" must be an object' % key)
    return group


def _array(group, key):
    """An array; an absent one is empty (Document 2 §4)."""
    value = group.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise LayoutError('"%s" must be an array' % key)
    return value


def _check_entries(layout):
    """Every entry of a placement array is an object."""
    for name in LAYOUT_KEYS - {"canvas", "base"}:
        for i, entry in enumerate(_array(layout, name)):
            if not isinstance(entry, dict):
                raise LayoutError("layout.%s[%d] must be an object" % (name, i))


def _report_unknown_keys(group, known, prefix, warnings):
    """FMT-26: unknown keys are ignored, but never silently."""
    for key in group:
        if key in known:
            continue
        kind = "an experimental feature" if key.startswith("x_") else "not supported by this importer"
        warnings.append("%s%s is %s and was skipped" % (prefix, key, kind))


# --- library tables ----------------------------------------------------------

def _check_library_table(library, name, warnings):
    """Ids (and asset `index`) unique within the table; every source path relative."""
    seen_ids, seen_indexes = set(), set()
    for i, entry in enumerate(_array(library, name)):
        at = "library.%s[%d]" % (name, i)
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]:
            raise LayoutError("%s has no id" % at)
        entry_id = entry["id"]
        if entry_id in seen_ids:
            raise LayoutError('library.%s has two entries with the id "%s"' % (name, entry_id))
        seen_ids.add(entry_id)
        if name == "assets" and "index" in entry:
            if entry["index"] in seen_indexes:
                raise LayoutError('library.assets has two entries with the index %s ("%s")'
                                  % (entry["index"], entry_id))
            seen_indexes.add(entry["index"])
        source = entry.get("source")
        path = source.get("path") if isinstance(source, dict) else None
        if path is not None:
            _check_relative(path, '%s "%s" source.path' % (at, entry_id))


def _check_relative(path, where):
    """FMT-12: paths use forward slashes and are relative to the asset folder."""
    if not isinstance(path, str) or not path:
        raise LayoutError("%s must be a path" % where)
    if path.startswith("/") or path.startswith("\\") or _DRIVE.match(path):
        raise LayoutError('%s must be relative to the asset folder, but is "%s"' % (where, path))


# --- ids and references ------------------------------------------------------

def _placements(layout):
    """Every entry of every layout array that carries an id - arrays added by a
    later version included, so uniqueness holds across all of them (§14)."""
    for name, value in layout.items():
        if not isinstance(value, list):
            continue
        for i, entry in enumerate(value):
            if isinstance(entry, dict) and ("id" in entry or "uid" in entry):
                yield "layout.%s[%d]" % (name, i), entry


def _check_unique_ids(layout):
    seen_ids, seen_uids = {}, {}
    for at, entry in _placements(layout):
        entry_id, uid = entry.get("id"), entry.get("uid")
        if not isinstance(entry_id, str) or not entry_id:
            raise LayoutError("%s has no id" % at)
        if isinstance(uid, bool) or not isinstance(uid, int) or uid < 1:
            raise LayoutError('%s "%s" has no uid (a positive whole number)' % (at, entry_id))
        if entry_id in seen_ids:
            raise LayoutError('the id "%s" is used twice (%s and %s)' % (entry_id, seen_ids[entry_id], at))
        if uid in seen_uids:
            raise LayoutError('the uid %d is used twice ("%s" and "%s")' % (uid, seen_uids[uid], entry_id))
        seen_ids[entry_id] = at
        seen_uids[uid] = entry_id


def _check_references(library, layout):
    """Every reference from the layout resolves in the table its field points
    into: variantId / scatter variantIds -> assets; surface / marking material
    / base.material -> materials (Document 2 §14)."""
    assets = {a["id"] for a in _array(library, "assets")}
    materials = {m["id"] for m in _array(library, "materials")}

    def need(table, name, ref, where):
        if not isinstance(ref, str) or ref not in table:
            raise LayoutError('%s refers to %s, which is not in library.%s' % (where, json.dumps(ref), name))

    for array in POINT_ENTITY_TYPES:
        for i, entity in enumerate(_array(layout, array)):
            need(assets, "assets", entity.get("variantId"),
                 'layout.%s[%d] "%s" variantId' % (array, i, entity.get("id")))
    for i, region in enumerate(_array(layout, "scatterRegions")):
        for ref in region.get("variantIds") or []:
            need(assets, "assets", ref, 'layout.scatterRegions[%d] "%s" variantIds' % (i, region.get("id")))
    for i, road in enumerate(_array(layout, "roads")):
        where = 'layout.roads[%d] "%s"' % (i, road.get("id"))
        need(materials, "materials", road.get("surface"), where + " surface")
        geometry = road.get("markingGeometry") or {}
        for kind in ("lines", "areas"):
            for j, marking in enumerate(geometry.get(kind) or []):
                need(materials, "materials", marking.get("material"),
                     "%s markingGeometry.%s[%d] material" % (where, kind, j))
    for i, junction in enumerate(_array(layout, "junctions")):
        if "surface" in junction:
            need(materials, "materials", junction["surface"], "layout.junctions[%d] surface" % i)
    base = layout.get("base")
    if isinstance(base, dict) and "material" in base:
        need(materials, "materials", base["material"], "layout.base material")


# --- unknown enum values (FMT-32) -------------------------------------------
# Enumerations are open: a value this importer doesn't know never fails the
# import. An unknown source kind uses the fallback; an unknown fallback shape
# builds a box; an unknown category, type or material kind is skipped. Each
# case is reported.

def _without_unknown_enums(data, warnings):
    library = dict(_group(data, "library"))
    layout = dict(_group(data, "layout"))

    assets, skipped_assets = [], set()
    for asset in _array(library, "assets"):
        asset = dict(asset)
        category = asset.get("category")
        if category not in ASSET_CATEGORIES:
            warnings.append('asset "%s" has the unknown category %s and was skipped'
                            % (asset["id"], json.dumps(category)))
            skipped_assets.add(asset["id"])
            continue
        source = asset.get("source") if isinstance(asset.get("source"), dict) else {}
        if source.get("kind") not in SOURCE_KINDS:
            warnings.append('asset "%s" has the unknown source kind %s - its fallback is used'
                            % (asset["id"], json.dumps(source.get("kind"))))
        fallback = dict(asset.get("fallback") or {})
        if fallback.get("shape") not in FALLBACK_SHAPES:
            warnings.append('asset "%s" has the unknown fallback shape %s - a box is built'
                            % (asset["id"], json.dumps(fallback.get("shape"))))
            fallback["shape"] = "box"
        asset["fallback"] = fallback
        assets.append(asset)
    library["assets"] = assets

    materials = []
    for material in _array(library, "materials"):
        if material.get("kind") not in MATERIAL_KINDS:
            warnings.append('material "%s" has the unknown kind %s and was skipped'
                            % (material["id"], json.dumps(material.get("kind"))))
            continue
        materials.append(material)
    library["materials"] = materials

    for array, expected in POINT_ENTITY_TYPES.items():
        kept = []
        for entity in _array(layout, array):
            if entity.get("type") != expected:
                warnings.append('"%s" in layout.%s has the unknown type %s and was skipped'
                                % (entity.get("id"), array, json.dumps(entity.get("type"))))
            elif entity.get("variantId") in skipped_assets:
                warnings.append('"%s" uses the skipped asset "%s" and was skipped'
                                % (entity.get("id"), entity.get("variantId")))
            else:
                kept.append(entity)
        layout[array] = kept

    regions = []
    for region in _array(layout, "scatterRegions"):
        if region.get("category") not in SCATTER_CATEGORIES:
            warnings.append('scatter region "%s" has the unknown category %s and was skipped'
                            % (region.get("id"), json.dumps(region.get("category"))))
            continue
        regions.append(region)
    layout["scatterRegions"] = regions

    checked = dict(data)
    checked["library"] = library
    checked["layout"] = layout
    return checked


def _file_warning_text(warning):
    if not isinstance(warning, dict):
        return "editor: %s" % (warning,)
    return "editor: %s" % (warning.get("message") or warning.get("code") or "warning")

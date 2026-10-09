"""DSGen layout importer.

Reads a DSGen web-editor export (JSON) and builds the map from geometry nodes.

Geometry nodes cannot read files, so the work is split in two:
  1. The importer turns the JSON into "carrier" meshes: bare points (one per
     building / prop / ...) and bare edges (road centerlines), with every
     number the file gives stored as a named attribute.
  2. Two node groups turn carriers into geometry:
       "DSGen Boxes"  points -> one box per point (width x depth x height)
       "DSGen Roads"  edges  -> road strips with filleted corners
Re-importing replaces the carrier data only; modifier settings are kept.

UI: 3D Viewport > Sidebar (N) > DSGen > Import Layout JSON.
"""
import json
import math

import bpy
from bpy_extras.io_utils import ImportHelper

COLLECTION = "DSGen Map"
ROOT = "DSGen_Map"
BOXES_GROUP = "DSGen Boxes"
ROADS_GROUP = "DSGen Roads"

# The export gives heights for buildings only; these fill in for the rest.
DEFAULT_HEIGHTS = {"buildings": 10.0, "props": 6.0, "vehicles": 1.6, "people": 1.8}
COLORS = {
    "buildings": "#c65d3b", "props": "#3f9d63", "vehicles": "#3b78c6",
    "people": "#c6a13b", "base": "#3a3f47",
    "road:asphalt": "#7d848f", "road:dirt": "#8a6d4b", "road": "#7d848f",
}


# --- materials -------------------------------------------------------------

def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def get_material(key):
    name = "DSGen " + key
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    hexcol = COLORS.get(key) or COLORS[key.split(":")[0]]
    rgb = [_srgb_to_linear(int(hexcol[i:i + 2], 16) / 255) for i in (1, 3, 5)]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    mat.diffuse_color = (*rgb, 1.0)
    return mat


# --- node groups -----------------------------------------------------------

def _new_group(name):
    ng = bpy.data.node_groups.new(name, "GeometryNodeTree")
    ng.is_modifier = True
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    return ng


def _input(ng, name, socket_type, default=None, min_value=None):
    s = ng.interface.new_socket(name, in_out="INPUT", socket_type=socket_type)
    if default is not None:
        s.default_value = default
    if min_value is not None:
        s.min_value = min_value
    return s


def _node(ng, idname, x, y, label=None, **props):
    n = ng.nodes.new(idname)
    n.location = (x, y)
    if label:
        n.label = label
    for k, v in props.items():
        setattr(n, k, v)
    return n


def _attr(ng, name, x, y):
    n = _node(ng, "GeometryNodeInputNamedAttribute", x, y, label=name, data_type="FLOAT")
    n.inputs["Name"].default_value = name
    return n


def ensure_boxes_group():
    ng = bpy.data.node_groups.get(BOXES_GROUP)
    if ng:
        return ng
    ng = _new_group(BOXES_GROUP)
    _input(ng, "Default Height", "NodeSocketFloat", 3.0, 0.0)
    _input(ng, "Below Ground", "NodeSocketBool", False)
    _input(ng, "Material", "NodeSocketMaterial")
    L = ng.links.new

    gin = _node(ng, "NodeGroupInput", -900, 0)
    gout = _node(ng, "NodeGroupOutput", 900, 0)
    width, depth = _attr(ng, "width", -900, -200), _attr(ng, "depth", -900, -340)
    height, rot = _attr(ng, "height", -900, -480), _attr(ng, "rotation", -900, -620)

    # height attribute if the carrier has one, else the modifier's default
    h = _node(ng, "GeometryNodeSwitch", -650, -420, label="Height", input_type="FLOAT")
    L(height.outputs["Exists"], h.inputs["Switch"])
    L(gin.outputs["Default Height"], h.inputs["False"])
    L(height.outputs["Attribute"], h.inputs["True"])

    # unit box standing on z = 0; this is the slot a real asset replaces later
    cube = _node(ng, "GeometryNodeMeshCube", -400, 320, label="Placeholder Box")
    lift = _node(ng, "GeometryNodeTransform", -200, 320, label="Stand on Ground")
    lift.inputs["Translation"].default_value = (0.0, 0.0, 0.5)
    mat = _node(ng, "GeometryNodeSetMaterial", 0, 320)
    L(cube.outputs["Mesh"], lift.inputs["Geometry"])
    L(lift.outputs["Geometry"], mat.inputs["Geometry"])
    L(gin.outputs["Material"], mat.inputs["Material"])

    # Below Ground: hang the box under z = 0 (used by the base slab)
    neg = _node(ng, "ShaderNodeMath", -450, -80, label="-Height", operation="MULTIPLY")
    neg.inputs[1].default_value = -1.0
    drop = _node(ng, "GeometryNodeSwitch", -250, -40, label="Drop", input_type="FLOAT")
    drop_v = _node(ng, "ShaderNodeCombineXYZ", -50, -40)
    setpos = _node(ng, "GeometryNodeSetPosition", 200, 60)
    L(h.outputs["Output"], neg.inputs[0])
    L(gin.outputs["Below Ground"], drop.inputs["Switch"])
    L(neg.outputs[0], drop.inputs["True"])
    L(drop.outputs["Output"], drop_v.inputs["Z"])
    L(gin.outputs["Geometry"], setpos.inputs["Geometry"])
    L(drop_v.outputs[0], setpos.inputs["Offset"])

    scale = _node(ng, "ShaderNodeCombineXYZ", 200, -260, label="Size")
    turn = _node(ng, "ShaderNodeCombineXYZ", 200, -420, label="Rotation Z")
    L(width.outputs["Attribute"], scale.inputs["X"])
    L(depth.outputs["Attribute"], scale.inputs["Y"])
    L(h.outputs["Output"], scale.inputs["Z"])
    L(rot.outputs["Attribute"], turn.inputs["Z"])

    inst = _node(ng, "GeometryNodeInstanceOnPoints", 500, 60)
    L(setpos.outputs["Geometry"], inst.inputs["Points"])
    L(mat.outputs["Geometry"], inst.inputs["Instance"])
    L(turn.outputs[0], inst.inputs["Rotation"])
    L(scale.outputs[0], inst.inputs["Scale"])
    L(inst.outputs["Instances"], gout.inputs["Geometry"])
    return ng


def ensure_roads_group():
    ng = bpy.data.node_groups.get(ROADS_GROUP)
    if ng:
        return ng
    ng = _new_group(ROADS_GROUP)
    _input(ng, "Corner Radius", "NodeSocketFloat", 3.0, 0.0)
    _input(ng, "Corner Resolution", "NodeSocketInt", 6, 1)
    _input(ng, "Thickness", "NodeSocketFloat", 0.05, 0.0)
    _input(ng, "Material", "NodeSocketMaterial")
    L = ng.links.new

    gin = _node(ng, "NodeGroupInput", -900, 0)
    gout = _node(ng, "NodeGroupOutput", 900, 0)
    to_curve = _node(ng, "GeometryNodeMeshToCurve", -700, 0, label="Centerlines")
    normal = _node(ng, "GeometryNodeSetCurveNormal", -500, 0)
    normal.inputs["Mode"].default_value = "Z Up"
    fillet = _node(ng, "GeometryNodeFilletCurve", -300, 0, label="Round Corners")
    fillet.inputs["Mode"].default_value = "Poly"
    fillet.inputs["Limit Radius"].default_value = True
    profile = _node(ng, "GeometryNodeCurvePrimitiveLine", -300, -260, label="Unit Cross-Section")
    profile.inputs["Start"].default_value = (-0.5, 0.0, 0.0)
    profile.inputs["End"].default_value = (0.5, 0.0, 0.0)
    width = _attr(ng, "width", -300, -440)
    sweep = _node(ng, "GeometryNodeCurveToMesh", 0, 0, label="Road Strip")
    # a corner radius of half the width pinches the inner edge to one point
    weld = _node(ng, "GeometryNodeMergeByDistance", 125, -200, label="Weld Inner Corners")
    up = _node(ng, "GeometryNodeExtrudeMesh", 250, 0, label="Thickness")
    up.inputs["Offset"].default_value = (0.0, 0.0, 1.0)
    up.inputs["Individual"].default_value = False
    flat = _node(ng, "GeometryNodeSetShadeSmooth", 500, 0, label="Flat Shading")
    flat.inputs["Shade Smooth"].default_value = False
    mat = _node(ng, "GeometryNodeSetMaterial", 700, 0)

    L(gin.outputs["Geometry"], to_curve.inputs["Mesh"])
    L(to_curve.outputs["Curve"], normal.inputs["Curve"])
    L(normal.outputs["Curve"], fillet.inputs["Curve"])
    L(gin.outputs["Corner Radius"], fillet.inputs["Radius"])
    L(gin.outputs["Corner Resolution"], fillet.inputs["Count"])
    L(fillet.outputs["Curve"], sweep.inputs["Curve"])
    L(profile.outputs["Curve"], sweep.inputs["Profile Curve"])
    L(width.outputs["Attribute"], sweep.inputs["Scale"])
    L(sweep.outputs["Mesh"], weld.inputs["Geometry"])
    L(weld.outputs["Geometry"], up.inputs["Mesh"])
    L(gin.outputs["Thickness"], up.inputs["Offset Scale"])
    L(up.outputs["Mesh"], flat.inputs["Geometry"])
    L(flat.outputs["Geometry"], mat.inputs["Geometry"])
    L(gin.outputs["Material"], mat.inputs["Material"])
    L(mat.outputs["Geometry"], gout.inputs["Geometry"])
    return ng


# --- carriers --------------------------------------------------------------

def _collection():
    col = bpy.data.collections.get(COLLECTION)
    if not col:
        col = bpy.data.collections.new(COLLECTION)
        bpy.context.scene.collection.children.link(col)
    return col


def _root(col):
    root = bpy.data.objects.get(ROOT)
    if not root:
        root = bpy.data.objects.new(ROOT, None)
        root.empty_display_size = 2.0
        col.objects.link(root)
    return root


def _carrier(name, col, root, verts, edges, attrs):
    """Create or refresh a carrier object; returns (object, created)."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, edges, [])
    for attr_name, (data_type, values) in attrs.items():
        mesh.attributes.new(attr_name, data_type, "POINT").data.foreach_set("value", values)
    mesh.update()
    obj = bpy.data.objects.get(name)
    if obj:
        old, obj.data = obj.data, mesh
        if old.users == 0:
            bpy.data.meshes.remove(old)
        return obj, False
    obj = bpy.data.objects.new(name, mesh)
    col.objects.link(obj)
    obj.parent = root
    return obj, True


def _modifier(obj, group, values):
    """Attach the node group once; existing settings survive a re-import."""
    if obj.modifiers.get(group.name):
        return
    mod = obj.modifiers.new(group.name, "NODES")
    mod.node_group = group
    ids = {i.name: i.identifier for i in group.interface.items_tree
           if i.item_type == "SOCKET" and i.in_out == "INPUT"}
    for name, value in values.items():
        mod[ids[name]] = value


def _boxes(name, category, entities, col, root, below_ground=False):
    variants = sorted({e.get("variantId", "") for e in entities})
    attrs = {
        "width": ("FLOAT", [e["footprint"]["width"] for e in entities]),
        "depth": ("FLOAT", [e["footprint"]["depth"] for e in entities]),
        "rotation": ("FLOAT", [math.radians(e.get("rotation", 0.0)) for e in entities]),
        "variant": ("INT", [variants.index(e.get("variantId", "")) for e in entities]),
    }
    if all("height" in e for e in entities):
        attrs["height"] = ("FLOAT", [e["height"] for e in entities])
    obj, created = _carrier(name, col, root, [(e["x"], e["y"], 0.0) for e in entities], [], attrs)
    # lookup tables for the asset pass: variant attribute -> manifest asset id
    obj["dsgen_variants"] = variants
    obj["dsgen_ids"] = [e.get("id", "") for e in entities]
    _modifier(obj, ensure_boxes_group(), {
        "Default Height": DEFAULT_HEIGHTS.get(category, 3.0),
        "Below Ground": below_ground,
        "Material": get_material(category),
    })
    return obj


def _roads(surface, roads, col, root, tolerance):
    verts, edges, widths = [], [], []
    for road in roads:
        pts = [(p["x"], p["y"]) for p in road["points"]]
        pts = [p for i, p in enumerate(pts) if i == 0 or math.dist(p, pts[i - 1]) > tolerance]
        # a loop is exported as a path whose last point repeats its first
        closed = len(pts) > 3 and math.dist(pts[0], pts[-1]) <= tolerance
        if closed:
            pts.pop()
        if len(pts) < 2:
            continue
        start = len(verts)
        verts += [(x, y, 0.0) for x, y in pts]
        widths += [road["width"]] * len(pts)
        edges += [(start + i, start + i + 1) for i in range(len(pts) - 1)]
        if closed:
            edges.append((start + len(pts) - 1, start))
    obj, _ = _carrier("DSGen_Roads_" + surface, col, root, verts, edges, {"width": ("FLOAT", widths)})
    obj["dsgen_ids"] = [r.get("id", "") for r in roads]
    _modifier(obj, ensure_roads_group(), {"Material": get_material("road:" + surface)})
    return obj


def import_layout(path):
    with open(bpy.path.abspath(path), encoding="utf-8") as f:
        data = json.load(f)
    col = _collection()
    root = _root(col)
    root["dsgen_source"] = path
    root["dsgen_format"] = data.get("formatVersion", "")
    made = []

    base = data.get("base")
    if base:
        slab = {"x": base["x"], "y": base["y"], "height": base["thickness"],
                "footprint": {"width": base["width"], "depth": base["depth"]}}
        made.append(_boxes("DSGen_Base", "base", [slab], col, root, below_ground=True))

    for category in ("buildings", "props", "vehicles", "people"):
        if data.get(category):
            made.append(_boxes("DSGen_" + category.capitalize(), category, data[category], col, root))

    tolerance = data.get("conventions", {}).get("junctions", {}).get("connectionTolerance", 1e-6)
    by_surface = {}
    for road in data.get("roads", []):
        by_surface.setdefault(road.get("surface") or "default", []).append(road)
    for surface, roads in by_surface.items():
        made.append(_roads(surface, roads, col, root, tolerance))

    # carriers left over from a previous import that this file no longer has
    keep = {o.name for o in made} | {ROOT}
    for obj in [o for o in col.objects if o.name.startswith("DSGen_") and o.name not in keep]:
        bpy.data.objects.remove(obj)
    print("DSGen: imported", ", ".join(o.name for o in made))
    return made


# --- UI: 3D Viewport > Sidebar (N) > DSGen ---------------------------------

class DSGEN_OT_import_json(bpy.types.Operator, ImportHelper):
    """Build the map from a DSGen layout export"""
    bl_idname = "dsgen.import_json"
    bl_label = "Import Layout JSON"
    bl_options = {"REGISTER", "UNDO"}

    filename_ext = ".json"
    filter_glob: bpy.props.StringProperty(default="*.json", options={"HIDDEN"})

    def execute(self, context):
        try:
            made = import_layout(self.filepath)
        except (OSError, ValueError, KeyError, TypeError) as err:
            self.report({"ERROR"}, "DSGen import failed: %s: %s" % (type(err).__name__, err))
            return {"CANCELLED"}
        self.report({"INFO"}, "DSGen: imported %d layers" % len(made))
        return {"FINISHED"}


class DSGEN_OT_reimport(bpy.types.Operator):
    """Read the last imported file again"""
    bl_idname = "dsgen.reimport"
    bl_label = "Re-import"
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        root = bpy.data.objects.get(ROOT)
        return bool(root and root.get("dsgen_source"))

    def execute(self, context):
        return bpy.ops.dsgen.import_json(filepath=bpy.data.objects[ROOT]["dsgen_source"])


class VIEW3D_PT_dsgen(bpy.types.Panel):
    bl_label = "DSGen Layout"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "DSGen"

    def draw(self, context):
        layout = self.layout
        layout.operator("dsgen.import_json", icon="IMPORT")
        root = bpy.data.objects.get(ROOT)
        source = root.get("dsgen_source") if root else None
        if source:
            layout.operator("dsgen.reimport", icon="FILE_REFRESH")
            layout.label(text=bpy.path.basename(source), icon="FILE")


CLASSES = (DSGEN_OT_import_json, DSGEN_OT_reimport, VIEW3D_PT_dsgen)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)

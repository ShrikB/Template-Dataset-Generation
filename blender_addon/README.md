# DSGen Layout Importer (Blender add-on)

Imports a layout JSON exported by the web editor and builds the map with
geometry nodes. Blender 4.2 or later.

It reads the `city-layout/1.x` format defined by
`docs/requirements/02-export-format.md` (Document 2). Files in the old
`placeholder-1` format are refused with a message asking for a re-export.

This is a **proof of concept**, built ahead of the importer's own
requirements (Document 3). It reads and checks the whole file, but builds
only:

- one box per building, prop, vehicle and person, sized from the file
  (footprint, and the building's height or the asset's fallback height);
- the base slab;
- road strips, one object per surface.

Road markings, junction patches, scatter regions, real asset files, fallback
shapes and materials are not built yet. Every import lists what it left out.

## Files

| File | What it does |
|---|---|
| `dsgen_importer/layout_file.py` | Reads and checks an export (Document 2 §14). The only file that knows where things live in the format. No Blender imports. |
| `dsgen_importer/carriers.py` | Turns a checked layout into plain vertex / edge / attribute lists. No Blender imports. |
| `dsgen_importer/__init__.py` | Everything that talks to Blender: node groups, objects, the panel. |

When the format changes, `layout_file.py` changes with the exporter
(`src/io/exporter.js`) in the same change.

## Build

```
./build.sh
```

Writes `dist/dsgen_importer-<version>.zip`.

## Install

Blender > Preferences > Get Extensions > Install from Disk, and pick the zip
(or drag the zip into the Blender window).

## Use

3D Viewport > Sidebar (`N`) > DSGen.

- **Project Folder**: the folder that contains the asset folder named in the
  export (`assets` by default). It is a setting of the importer; where the
  JSON is saved does not matter. Nothing is loaded from it yet.
- **Import Layout JSON**: builds the map. A file that must not be imported
  (wrong version, a broken reference, duplicate ids, an absolute path) is
  refused before anything is built or removed.
- **Re-import**: reads the last file again. Modifier settings are kept.

Warnings from the import, including the ones the editor wrote into the file,
are listed in the panel and printed to the system console.

## Tests

```
python3 -m unittest discover -s blender_addon/tests
```

Run from the repository root; no Blender needed. They cover the reader and
the carrier data, against `tests/fixtures/sample-city-layout-1.0.json`, which
is the web editor's real output for its sample layout. The editor's own tests
keep that file current (`UPDATE_FIXTURES=1 npm test` regenerates it).

The Blender-facing code in `__init__.py` has no automated test; check it by
importing the fixture in Blender.

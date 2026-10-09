# DSGen Layout Importer (Blender add-on)

Imports a layout JSON exported by the web editor and builds the map with
geometry nodes. Blender 4.2 or later.

The JSON format is still the placeholder written by `src/io/exporter.js`;
when that changes, `dsgen_importer/__init__.py` has to change with it.

## Build

```
./build.sh
```

Writes `dist/dsgen_importer-<version>.zip`.

## Install

Blender > Preferences > Get Extensions > Install from Disk, and pick the zip
(or drag the zip into the Blender window).

## Use

3D Viewport > Sidebar (`N`) > DSGen > Import Layout JSON.

#!/usr/bin/env bash
# Package dsgen_importer/ as an installable Blender extension zip in dist/.
set -euo pipefail
cd "$(dirname "$0")"

version=$(sed -n 's/^version = "\(.*\)"/\1/p' dsgen_importer/blender_manifest.toml)
out="dist/dsgen_importer-${version}.zip"

mkdir -p dist
rm -f "$out"
# The manifest must sit at the root of the archive.
(cd dsgen_importer && zip -r -q "../$out" . -x '__pycache__/*' '*.pyc')
echo "built $out"

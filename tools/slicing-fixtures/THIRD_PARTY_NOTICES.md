# Third-party notices

The Taven Orca runtime contains the official OrcaSlicer v2.4.2 Linux AppImage
and a minimal Bambu Lab H2S profile closure copied from the same upstream
source revision. OrcaSlicer is licensed under AGPL-3.0; the complete upstream
license text is retained in `licenses/OrcaSlicer-LICENSE.txt` and copied into
the image.

- project: <https://github.com/OrcaSlicer/OrcaSlicer>
- release: <https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2>
- exact source revision: `8500fcdccaa10b5099ac20d252af3a7c560046f1`
- corresponding source: <https://github.com/OrcaSlicer/OrcaSlicer/tree/8500fcdccaa10b5099ac20d252af3a7c560046f1>

The Ubuntu base and dynamically installed runtime packages retain their own
license files under `/usr/share/doc` in the built image. The image also records
the complete installed package/version set at
`/usr/share/doc/taven-orca/ubuntu-packages.lock`, which is checked against the
reviewable repository lock of the same name.

The STL and 3MF corpus geometry is original test data authored for Taven and
licensed under MIT; the fixture license is retained in `fixtures/LICENSE.txt`.
The painted 3MF carries Orca/Prusa's `slic3rpe:mmu_segmentation` extension and
the equivalent Bambu project `paint_color` attribute. Orca's CLI selects the
Bambu project importer for this package, while the generic importer uses the
Slic3r extension; Orca v2.4.2 ignores the core 3MF material property indices.

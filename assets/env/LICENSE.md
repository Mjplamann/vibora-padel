# assets/env — HDR panoramas (image-based lighting)

| File | Source | Licence |
|---|---|---|
| `warehouse.exr` | Poly Haven "Empty Warehouse 01" (the `warehouse` panorama of @pmndrs/assets 1.7.0, `hdri/warehouse.exr.js`) | CC0 1.0 |
| `sunset.exr` | Poly Haven "Venice Sunset" (the `sunset` panorama of @pmndrs/assets 1.7.0, `hdri/sunset.exr.js`) | CC0 1.0 |
| `esplanade.exr` | Poly Haven panorama distributed by @pmndrs/assets 1.7.0 as `hdri/esplanade.exr.js` | CC0 1.0 |

The files are the package's base64 payloads decoded to plain OpenEXR (512 x 256, DWAB compression,
half float) without any other change. @pmndrs/assets (https://github.com/pmndrs/assets) is published
under CC0 1.0 Universal and describes its HDRIs as "a selection of Polyhaven HDRIs, resized to 512x512
and converted to EXR with DWAB compression"; Poly Haven (https://polyhaven.com) publishes all of its
assets under CC0 1.0. CC0 needs no attribution; it is given here for provenance.

They are loaded lazily, one per venue (`src/render/ibl.js`), normalised to a mean luminance of 1 and
mixed into each venue's own lighting capture.

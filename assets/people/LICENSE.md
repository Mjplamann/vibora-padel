# assets/people — licences

All files in this folder are derived from works released under **CC0 1.0 Universal** (public
domain dedication, https://creativecommons.org/publicdomain/zero/1.0/). No attribution is required;
it is given here for provenance.

| File | Made from | Source licence |
|---|---|---|
| `athletes.glb` | MakeHuman 1.1 assets: base mesh `hm08` (`3dobjs/base.obj`), macro targets (gender / muscle / weight / height / proportions / ethnicity, `targets/macrodetails/*`), default skeleton and weights (`rigs/default.mhskel`, `rigs/default_weights.mhw`) from https://github.com/makehumancommunity/makehuman (`makehuman/data/…`); the MakeHuman system proxies (eyes, eyebrows, eyelashes, hair `short02/03/04`, `ponytail01`, `bob02`, `afro01`) from the npm package `makehuman-data@0.0.2` (a JSON export of the same bundled MakeHuman assets). Morphed, skinned to this game's 22-bone skeleton, dressed (shirt, shorts, shoes, headwear made by `tools/people/*`), simplified for LOD1 and baked by `tools/people/bake.mjs`. | CC0 1.0 — MakeHuman `LICENSE.md` §C "The license for the bundled assets" (base mesh and proxies, targets and modifiers, textures, clothes, poses) and `LICENSE.ASSETS.md` (full CC0 text) |
| `skin.webp`, `hair.webp` | MakeHuman 1.1 skin / hair / eyebrow / eyelash / eye textures (via `makehuman-data@0.0.2`), re-packed into atlases by `tools/people/textures.mjs` | CC0 1.0 (as above) |
| `pores.webp`, `wrinkles.webp` | `@pmndrs/assets@1.7.0` `normals/0021` and `normals/0014` (from emmelleppi/normal-maps), decoded from the package's base64 modules by `tools/people/encode-textures.mjs` | CC0 1.0 — `@pmndrs/assets` `package.json` `"license": "CC0-1.0"` |

The MakeHuman *application source code* (AGPL) is **not** used or shipped: only the CC0 asset
data is read at bake time; the bake tools in `tools/people/` are this project's own code (MIT).
No Mixamo or other restricted data is included.

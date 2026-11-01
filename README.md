# Source Map Importer

A Windows app that ports Source engine maps (.bsp, .vmf, or a workshop .gma with a map
inside) to Roblox as meshes, with a moderation pass before anything is uploaded.

## Download

Get the latest zip from the Releases page and follow the `README.txt` inside it. The app
tells you when a newer version is out.

## Use

1. Open **Source Map Importer**.
2. **Load map:** press Browse or drop a map on the window, then tick the base games it needs.
   Add workshop content under Extra content, highest priority first.
3. **Review assets:** every texture, decal, model and sky gets a card. High-priority cards
   must be decided before a build is allowed. In the big view, K keeps, R removes, B blanks.
   Decisions are saved per map.
4. **Build:** makes the geometry files and textures. Nothing leaves your PC.
5. **Upload:** needs an Open Cloud API key with Assets read and write. Re-running skips
   anything already uploaded.
6. In Studio, open the Source Map Importer plugin and press Build in Workspace. Keep the app
   open while it builds.

Saved work is in `Documents\SourceMapImporter\projects\<map>`.

## What the moderation scan checks

- Names of materials, textures and models: gore, sexual content, hate symbols, drugs, links.
- Text inside textures, using the OCR built into Windows. Small textures are enlarged first,
  so low-res links can be read.
- Deep red and skin-toned pixels. These are weak hints and never block a build on their own.

Flags are hints. A clean scan does not prove an asset is safe, so look through Everything
as well, especially on GMod maps.

## How the map is built

- Each material in each 2048-unit cell is a mesh, capped below Roblox's 20k triangle limit.
- Geometry is split into GLBs under 15 MB and textures upload separately, once each. This is
  why map size isn't limited by a single import file.
- Each prop model is stored once and cloned for every placement.
- Visible meshes never collide. Colliders come from the map's own brushes: boxes and wedges
  are invisible Parts, anything else is an invisible Hull mesh. Displacements use their own
  mesh with precise collision.
- Water becomes Roblox terrain water.
- Two-texture terrain is sliced into eight bands along its blend, each using a baked opaque
  mix of the two textures. Roblox only allows one texture per mesh, and this gives a soft
  fade without transparency.

## Replacer mods

Extra content outranks everything, including files packed in the map, with the top of the
list winning. A folder can hold loose content or archives, even nested a few levels down.
Models are matched by checksum, so a mod's `.mdl` can use the base game's mesh if they match.
One with no matching mesh is passed over and the build warns about it. On a .vmf, tiling stays
based on the original texture, so a high-res replacer doesn't change the scale.

## Brushes as Parts

An alternative for buildings: tick **Prepare brushes as Parts** in the app before building,
then turn on **Brushes as Parts** in the plugin. Box brushes become Parts and other shapes
become CSG unions, all textured with Texture objects. Terrain and props stay meshes. A
Texture can't flip or rotate an image, so the app bakes those copies, which adds uploads.

## Known limits

- Baked lightmaps aren't ported, so rooms rely on the ported lights and Roblox lighting.
- The 3D skybox is left out of .bsp maps. A .vmf can't detect it, so it stays in.
- Sounds and game logic aren't ported.
- Doors are placed in their closed position and don't move. They're grouped in a `Doors`
  folder under the map, ready for your own scripts.
- Water fills each brush's bounding box, so odd-shaped water is approximate.

## Changing the code

Needs Node.js. Run `npm install` once.

- `npm run package` rebuilds the app into `dist`.
- `node plugin\install.js` installs or updates the Studio plugin. Restart Studio afterwards.
- `node src\cli.js` runs the backend alone, for working on the UI in a browser. Browse and
  drag-and-drop only work in the app.

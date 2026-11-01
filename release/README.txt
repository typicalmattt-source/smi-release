SOURCE MAP IMPORTER
Ports Source engine maps (.bsp, .vmf, or a Workshop .gma with a map inside) into Roblox.
Windows 64-bit only. You don't need to install anything else to run it.


SETUP

1. Unzip this whole folder somewhere permanent. Don't run it from inside the zip.
2. Double-click "Install Studio Plugin.bat", then restart Roblox Studio if it's open.
3. Open the "App" folder and run "Source Map Importer.exe".

Windows may warn you that the app is unrecognised, because it isn't code-signed. Choose
More info, then Run anyway. Tip: right-click the exe and make a desktop shortcut.


PORTING A MAP

1. LOAD   Browse to a map, or drop it on the window, and tick the games it needs.
          Add any Workshop content under Extra content.
2. REVIEW Every texture, decal, model and sky gets a card. Flagged ones must be decided
          before you can build. In the big view: K keeps, R removes, B blanks.
3. BUILD  Makes the geometry and textures. Nothing leaves your PC at this step.
          Tick "Prepare brushes as Parts" here if you want the Parts build for buildings.
4. UPLOAD Needs your own Open Cloud API key (below). Re-running skips finished uploads.
5. STUDIO Open the Source Map Importer plugin, press Check for build, then Build in
          Workspace. Keep the app open while it builds, and allow HTTP if Studio asks.
          Save right after it finishes.


UPDATING

When a new version is out, an "Update available" button appears at the top of the app and
opens the download page. Download the new zip, replace your old folder with it, and run
"Install Studio Plugin.bat" again. Your saved maps aren't in that folder, so they're safe.


YOUR API KEY

Create one in the Roblox Creator Dashboard under Open Cloud API Keys. It needs Assets read
and write. The app only uses it during an upload and doesn't save it, but treat it like
a password and never share it.

Upload to the same owner as your game. If the game belongs to a group, enter the group's ID
in the app, or the assets may not load there.


REPLACER MODS

Anything under Extra content overrides the base games and files packed into the map, so
texture and model packs apply automatically. The top of the list wins. Add the mod's .vpk or
.gma, or a folder holding them. After scanning, the Map step shows how many files each mod
replaced on that map. If that says nothing, the mod doesn't touch this map.

For L4D2, tick Left 4 Dead 2 under Base games. Workshop mods are in
left4dead2\addons\workshop, named by number.


BUILD OPTIONS IN THE PLUGIN

Brushes as Parts    Buildings become textured Parts and unions instead of meshes. Terrain
                    and props stay as meshes. Needs "Prepare brushes as Parts" in step 3.
Replace previous    Removes the last build of this map once the new one finishes.
Remove Baseplate    Removes the template Baseplate, which usually cuts through the map.
Loose physics props Physics props can be knocked around instead of being anchored.

A build also adds spawn points, ropes and cables, and invisible markers for scriptable
entities. Doors go in a Doors folder. Missing props show up as red boxes, and are listed
in Output.


GOOD TO KNOW

- Your saved work goes to Documents\SourceMapImporter\projects.
- The review scan gives hints, not guarantees. Look through the assets yourself. A link in
  a texture or name can get a Roblox account in trouble, so check GMod maps carefully.
- You're responsible for having the rights to anything you upload. Maps and models belong
  to their creators, and Valve's game content has its own terms.
- Sounds, game logic and baked lighting aren't ported. Doors don't move until you script them.
- A .vmf can't filter out the map's 3D skybox room, so it may come in as a small copy
  underneath the map. You can delete it.
- Any Source game in your Steam library should appear under Base games automatically,
  including mods in sourcemods. Restart the app after installing a new game. Game not
  listed? Add its folder or .vpk under Extra content.
- Lots of red boxes? The map borrows props from another game, such as Counter-Strike:
  Source. Tick that game too. The list in Output shows which models are missing.

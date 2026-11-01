// Packs the plugin source into an .rbxmx in Studio's local Plugins folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'SourceMapImporter.luau'), 'utf8');
if (source.includes(']]>')) throw new Error('source contains a CDATA terminator');

const xml = `<roblox version="4">
\t<Item class="Script" referent="RBX0">
\t\t<Properties>
\t\t\t<string name="Name">SourceMapImporter</string>
\t\t\t<token name="RunContext">0</token>
\t\t\t<ProtectedString name="Source"><![CDATA[${source}]]></ProtectedString>
\t\t</Properties>
\t</Item>
</roblox>
`;
const dir = path.join(process.env.LOCALAPPDATA, 'Roblox', 'Plugins');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'SourceMapImporter.rbxmx');
fs.writeFileSync(out, xml);
console.log(`Installed ${out} (${xml.length} bytes). Restart Studio to load it.`);

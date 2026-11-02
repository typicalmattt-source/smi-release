-- Source Map Importer: Studio side. Pulls a reviewed, uploaded build from the local app
-- and assembles it. Geometry comes in as Model assets, then everything is placed from the
-- manifest, so it doesn't matter how the importer recentred or rescaled a mesh.

local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local Lighting = game:GetService("Lighting")
local Selection = game:GetService("Selection")

local DEFAULT_PORT = "34871"
local BATCH = 150
-- Roblox's importer stores every GLB mesh turned 180 degrees about its own Y axis.
local MESH_FIX = CFrame.Angles(0, math.pi, 0)

local toolbar = plugin:CreateToolbar("Source Map Importer")
local button = toolbar:CreateButton("Importer", "Build a reviewed Source map in this place", "rbxasset://textures/ui/Settings/Help/AButton.png")
button.ClickableWhenViewportHidden = true

local widget = plugin:CreateDockWidgetPluginGui("SourceMapImporter", DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right, false, false, 300, 460, 240, 300))
widget.Title = "Source Map Importer"
button.Click:Connect(function() widget.Enabled = not widget.Enabled end)
widget:GetPropertyChangedSignal("Enabled"):Connect(function() button:SetActive(widget.Enabled) end)

-- UI ---------------------------------------------------------------------
local theme = settings().Studio.Theme
local function col(c) return theme:GetColor(c) end

local root = Instance.new("ScrollingFrame")
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = col(Enum.StudioStyleGuideColor.MainBackground)
root.BorderSizePixel = 0
root.ScrollBarThickness = 6
root.AutomaticCanvasSize = Enum.AutomaticSize.Y
root.CanvasSize = UDim2.new()
root.Parent = widget
local pad = Instance.new("UIPadding")
pad.PaddingTop = UDim.new(0, 10); pad.PaddingBottom = UDim.new(0, 10)
pad.PaddingLeft = UDim.new(0, 10); pad.PaddingRight = UDim.new(0, 10)
pad.Parent = root
local list = Instance.new("UIListLayout")
list.Padding = UDim.new(0, 6); list.SortOrder = Enum.SortOrder.LayoutOrder
list.Parent = root

local order = 0
local function nextOrder() order += 1; return order end

local function label(text)
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Size = UDim2.new(1, 0, 0, 0)
	l.AutomaticSize = Enum.AutomaticSize.Y
	l.TextWrapped = true
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextYAlignment = Enum.TextYAlignment.Top
	l.Font = Enum.Font.SourceSans
	l.TextSize = 15
	l.TextColor3 = col(Enum.StudioStyleGuideColor.MainText)
	l.Text = text
	l.LayoutOrder = nextOrder()
	l.Parent = root
	return l
end

local function btn(text)
	local b = Instance.new("TextButton")
	b.Size = UDim2.new(1, 0, 0, 30)
	b.Font = Enum.Font.SourceSansSemibold
	b.TextSize = 15
	b.Text = text
	b.AutoButtonColor = true
	b.BackgroundColor3 = col(Enum.StudioStyleGuideColor.Button)
	b.TextColor3 = col(Enum.StudioStyleGuideColor.ButtonText)
	b.BorderSizePixel = 0
	b.LayoutOrder = nextOrder()
	b.Parent = root
	return b
end

local function toggle(text, on)
	local b = btn("")
	b.TextXAlignment = Enum.TextXAlignment.Left
	b.Size = UDim2.new(1, 0, 0, 24)
	local state = on
	local function draw() b.Text = (state and "  [x] " or "  [ ] ") .. text end
	draw()
	b.Activated:Connect(function() state = not state; draw() end)
	return function() return state end
end

label("App port")
local portBox = Instance.new("TextBox")
portBox.Size = UDim2.new(1, 0, 0, 26)
portBox.Text = plugin:GetSetting("port") or DEFAULT_PORT
portBox.Font = Enum.Font.SourceSans
portBox.TextSize = 15
portBox.BackgroundColor3 = col(Enum.StudioStyleGuideColor.InputFieldBackground)
portBox.TextColor3 = col(Enum.StudioStyleGuideColor.MainText)
portBox.BorderSizePixel = 0
portBox.LayoutOrder = nextOrder()
portBox.Parent = root

local refreshBtn = btn("Check for build")
local infoLabel = label("Press Check for build.")
local optWorld = toggle("Map geometry", true)
local optProps = toggle("Props", true)
local optBrushParts = toggle("Brushes as Parts (experimental)", false)
local optColl = toggle("Colliders", true)
local optWater = toggle("Terrain water", true)
local optLights = toggle("Lights", true)
local optMatchLight = toggle("Match Source lighting (Realistic, shadows)", true)
local optSky = toggle("Sky and sun", true)
local optRopes = toggle("Ropes and cables", true)
local optSpawns = toggle("Spawn points", true)
local optMarkers = toggle("Entity markers", true)
local optMissing = toggle("Red boxes for missing props", true)
local optLoose = toggle("Loose physics props", false)
local optLock = toggle("Lock map parts", false)
local optReplace = toggle("Replace previous build", true)
local optBaseplate = toggle("Remove template Baseplate", true)
local buildBtn = btn("Build in Workspace")

local barBack = Instance.new("Frame")
barBack.Size = UDim2.new(1, 0, 0, 8)
barBack.BackgroundColor3 = col(Enum.StudioStyleGuideColor.InputFieldBackground)
barBack.BorderSizePixel = 0
barBack.LayoutOrder = nextOrder()
barBack.Visible = false
barBack.Parent = root
local barFill = Instance.new("Frame")
barFill.Size = UDim2.fromScale(0, 1)
barFill.BackgroundColor3 = col(Enum.StudioStyleGuideColor.LinkText)
barFill.BorderSizePixel = 0
barFill.Parent = barBack

local statusLabel = label("")
local startedAt = 0

-- fraction is the whole build's progress, 0 to 1. Leave it out to keep the bar where it is.
local function status(text, fraction)
	if fraction then
		barBack.Visible = true
		barFill.Size = UDim2.fromScale(math.clamp(fraction, 0, 1), 1)
		local elapsed = os.clock() - startedAt
		if fraction > 0.02 and elapsed > 2 then
			local left = math.max(0, math.round(elapsed / fraction - elapsed))
			text = ("%s\nAbout %d:%02d left"):format(text, left // 60, left % 60)
		end
	end
	statusLabel.Text = text
	task.wait()
end

local function sectionRange(from, to, done, total)
	return from + (to - from) * (total > 0 and done / total or 1)
end

-- HTTP -------------------------------------------------------------------
local function base() return "http://127.0.0.1:" .. portBox.Text end

local function getJson(path)
	local res = HttpService:RequestAsync({ Url = base() .. path, Method = "GET" })
	if not res.Success then error("app returned " .. res.StatusCode .. ": " .. res.Body) end
	return HttpService:JSONDecode(res.Body)
end

local function section(name)
	local out, page = {}, 0
	while true do
		local r = getJson("/plugin/section?name=" .. name .. "&page=" .. page)
		for _, v in r.items do table.insert(out, v) end
		if not r.more then return out end
		page += 1
		status("Reading " .. name .. " (" .. #out .. ")")
	end
end

-- Assembly ---------------------------------------------------------------
local function cf12(c)
	return CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12])
end

-- Image assets load directly. Decal assets wrap an image, so unwrap those once.
local function imageUrl(rec)
	if rec.type ~= "Decal" then return "rbxassetid://" .. tostring(rec.id) end
	if rec.resolved then return rec.resolved end
	local ok, model = pcall(function() return InsertService:LoadAsset(rec.id) end)
	if ok then
		local d = model:FindFirstChildWhichIsA("Decal", true)
		if d then rec.resolved = d.Texture end
		model:Destroy()
	end
	return rec.resolved
end

local function applyMaterial(part, m, images)
	part.Material = Enum.Material[m.material] or Enum.Material.SmoothPlastic
	-- Tagged with the Source material, so the Tag Editor can select everything using it.
	if m.src then CollectionService:AddTag(part, "Source:" .. m.src) end
	if m.alpha and m.alpha < 1 then part.Transparency = 1 - m.alpha end
	if m.solid then
		part.Color = Color3.fromHex(m.solid)
		return
	end
	if m.tint then part.Color = Color3.new(m.tint[1], m.tint[2], m.tint[3]) end
	if not m.color or not images[m.color] then return end
	local sa = Instance.new("SurfaceAppearance")
	sa.ColorMap = imageUrl(images[m.color])
	if m.normal and images[m.normal] then sa.NormalMap = imageUrl(images[m.normal]) end
	if m.hasAlpha then sa.AlphaMode = Enum.AlphaMode.Transparency end
	if m.tint then sa.Color = Color3.new(m.tint[1], m.tint[2], m.tint[3]) end
	sa.Parent = part
end

-- Set in a final pass: values set during assembly read back as Default on a real build.
local pendingFidelity = {}
local function fidelity(part, mode)
	table.insert(pendingFidelity, { part, mode })
end

--[[BRUSHES]]
local BRUSH_FACES = {
	Enum.NormalId.Right, Enum.NormalId.Top, Enum.NormalId.Back,
	Enum.NormalId.Left, Enum.NormalId.Bottom, Enum.NormalId.Front,
}

-- The Part axes a Texture's U and V run along, in the same order as BRUSH_FACES.
local BRUSH_FACE_AXES = {
	{ "Z", "Y" }, { "X", "Z" }, { "X", "Y" },
	{ "Z", "Y" }, { "X", "Z" }, { "X", "Y" },
}

local function brushColor(m)
	if not m then return Color3.fromRGB(128, 128, 128) end
	if m.solid then return Color3.fromHex(m.solid) end
	if m.avg then return Color3.fromRGB(m.avg[1], m.avg[2], m.avg[3]) end
	return Color3.fromRGB(128, 128, 128)
end

local function brushCf(c)
	return CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12])
end

local function dressBrush(part, b, materials, images)
	local seeThrough = #b.f > 0
	for _, f in b.f do
		local m = materials[f[2] + 1]
		if m.src then CollectionService:AddTag(part, "Source:" .. m.src) end
		if not (m.hasAlpha or (m.alpha and m.alpha < 1)) then seeThrough = false end
		if m.color and images[m.color] then
			local t = Instance.new("Texture")
			t.Face = BRUSH_FACES[f[1] + 1]
			t.Texture = imageUrl(images[m.color])
			t.StudsPerTileU, t.StudsPerTileV = f[3], f[4]
			-- Offsets are worked out from the face's corner, but on a union a Texture starts at its centre.
			local shiftU, shiftV = 0, 0
			if part:IsA("UnionOperation") then
				local axes = BRUSH_FACE_AXES[f[1] + 1]
				shiftU, shiftV = part.Size[axes[1]] / 2, part.Size[axes[2]] / 2
			end
			t.OffsetStudsU, t.OffsetStudsV = f[5] + shiftU, f[6] + shiftV
			if m.tint then t.Color3 = Color3.new(m.tint[1], m.tint[2], m.tint[3]) end
			if m.alpha and m.alpha < 1 then t.Transparency = 1 - m.alpha end
			t.Parent = part
		end
	end
	-- Glass and grates: the Texture carries the alpha, so the Part behind it has to vanish.
	if seeThrough then part.Transparency = 1 end
end

-- Cuts a bounding Part along each brush plane. Each cutter's colour lands on the face it makes.
local function cutBrush(b, materials, work)
	local body = materials[b.m + 1]
	-- Cut at the world origin and move the result: measured sizes come out exact there, while
	-- 1000 studs out they were up to 0.02 off.
	local place = brushCf(b.cf)
	local base = Instance.new("Part")
	base.Anchored = true
	base.CFrame = place.Rotation
	-- A plate already has its final thickness, so only a solid starts oversized.
	base.Size = Vector3.new(b.s[1], b.s[2], b.s[3]) + Vector3.one * (b.pl and 0 or 0.2)
	base.Color = brushColor(body)
	base.Material = Enum.Material[body.material] or Enum.Material.SmoothPlastic
	base.Parent = work
	local reach = math.max(b.s[1], b.s[2], b.s[3]) * 2 + 8
	local cutters = {}
	for _, c in b.c do
		local n = Vector3.new(c[1], c[2], c[3])
		local m = c[5] >= 0 and materials[c[5] + 1] or body
		local cut = Instance.new("Part")
		cut.Anchored = true
		cut.Size = Vector3.one * reach
		-- Start from the brush's centre: a cutter centred anywhere else on the plane can miss it.
		local onPlane = n * (c[4] - place.Position:Dot(n))
		cut.CFrame = CFrame.lookAlong(onPlane + n * (reach / 2), n)
		cut.Color = brushColor(m)
		cut.Material = Enum.Material[m.material] or Enum.Material.SmoothPlastic
		cut.Parent = work
		table.insert(cutters, cut)
	end
	local ok, union = pcall(function()
		return base:SubtractAsync(cutters, Enum.CollisionFidelity.Hull, Enum.RenderFidelity.Precise)
	end)
	for _, cut in cutters do cut:Destroy() end
	base:Destroy()
	-- SubtractAsync returns nil, with no error, when the cuts leave nothing.
	if not ok or not union then return nil end
	union.UsePartColor = false
	union.Anchored = true
	union.CFrame += place.Position
	return union
end

local function buildBrushes(brushes, materials, images, parentOf, work, onStep)
	local failed = 0
	for i, b in brushes do
		local part
		if b.t == "c" then
			part = cutBrush(b, materials, work)
			if not part then failed += 1 end
		else
			local m = materials[b.m + 1]
			part = Instance.new("Part")
			part.Anchored = true
			part.Size = Vector3.new(b.s[1], b.s[2], b.s[3])
			part.CFrame = brushCf(b.cf)
			part.Color = brushColor(m)
			part.Material = Enum.Material[m.material] or Enum.Material.SmoothPlastic
		end
		if part then
			part.Name = b.ov and "Overlay" or b.pl and "BrushFace" or "Brush"
			part.CanCollide = not (b.nc or b.pl)
			part.CanTouch = false
			-- A plate is only a surface, so rays and shadows belong to the solid underneath.
			if b.pl then
				part.CanQuery = false
				part.CastShadow = false
			end
			if b.tr then part.Transparency = 1 end
			dressBrush(part, b, materials, images)
			part.Parent = parentOf(b)
		end
		if i % 50 == 0 then onStep(i, #brushes) end
	end
	return failed
end
--[[/BRUSHES]]

local function buildMap(info)
	local problems = {}
	local images = info.images

	status("Reading manifest", 0)
	local meshList = section("meshes")
	local materials = section("materials")
	local libList = section("lib")
	local instances = optProps() and section("instances") or {}
	-- As Parts, brushes collide by themselves, so only tool brushes still need a collider.
	local brushParts = optBrushParts() and optWorld()
	local parts = optColl() and section(brushParts and "clipParts" or "parts") or {}
	local brushes = brushParts and section("brushes") or {}
	local overlays = optWorld() and section("overlays") or {}
	local water = optWater() and section("water") or {}
	local lights = optLights() and section("lights") or {}
	local ropes = optRopes() and section("ropes") or {}
	local spawns = optSpawns() and section("spawns") or {}
	local markers = optMarkers() and section("markers") or {}
	local missingProps = section("missingProps")

	local meshInfo = {}
	for _, pair in meshList do meshInfo[pair[1]] = pair[2] end

	-- Load every geometry file and index its meshes by name.
	local loaded = {}
	for i, f in info.models do
		status(("Loading geometry %d of %d"):format(i, #info.models), sectionRange(0.05, 0.4, i - 1, #info.models))
		if f.id then
			local ok, model = pcall(function() return InsertService:LoadAsset(f.id) end)
			if ok then
				for _, d in model:GetDescendants() do
					if d:IsA("MeshPart") then
						if meshInfo[d.Name] then loaded[d.Name] = d end
					end
				end
				model.Parent = nil
			else
				table.insert(problems, f.file .. ": " .. tostring(model))
			end
		else
			table.insert(problems, f.file .. " has not been uploaded")
		end
	end

	local rootFolder = Instance.new("Folder")
	rootFolder.Name = "SourceMap_" .. info.map:gsub("[^%w_]", "_")
	local worldFolder = Instance.new("Folder"); worldFolder.Name = "World"; worldFolder.Parent = rootFolder
	local propFolder = Instance.new("Folder"); propFolder.Name = "Props"; propFolder.Parent = rootFolder
	local collFolder = Instance.new("Folder"); collFolder.Name = "Collision"; collFolder.Parent = rootFolder

	local missing = 0
	local function prep(part, center, size, collide)
		part.Anchored = true
		part.Size = Vector3.new(math.max(size[1], 0.01), math.max(size[2], 0.01), math.max(size[3], 0.01))
		part.CFrame = CFrame.new(center[1], center[2], center[3]) * MESH_FIX
		part.RenderFidelity = Enum.RenderFidelity.Precise
		part.CanCollide = collide
		part.CanTouch = false
		part.CanQuery = collide
		part.CastShadow = true
	end

	local count = 0
	if optWorld() or optColl() then
		for name, m in meshInfo do
			if m.k == "world" or m.k == "disp" or m.k == "hull" then
				local wanted = (m.k == "hull" and optColl()) or (m.k ~= "hull" and optWorld())
				-- Parts replace flat world meshes and their hulls. Terrain, overlays and clip hulls stay.
				if brushParts and ((m.k == "world" and not m.ov) or (m.k == "hull" and m.cl ~= "clip" and m.cl ~= "terrain")) then
					wanted = false
				end
				local part = loaded[name]
				if wanted and part then
					if m.k == "hull" then
						prep(part, m.c, m.s, true)
						part.Transparency = 1
						part.CastShadow = false
						fidelity(part, Enum.CollisionFidelity.Hull)
						part.Parent = collFolder
					else
						-- A map exported before terrain colliders still needs its terrain to collide.
						local solid = m.k == "disp" and m.cl ~= "none"
						prep(part, m.c, m.s, solid)
						fidelity(part, solid and Enum.CollisionFidelity.PreciseConvexDecomposition or Enum.CollisionFidelity.Box)
						if m.m then applyMaterial(part, materials[m.m + 1], images) end
						part.Parent = worldFolder
					end
				elseif wanted then
					missing += 1
				end
				count += 1
				if count % BATCH == 0 then status(("Placing map geometry (%d)"):format(count), sectionRange(0.4, 0.55, count, #meshList)) end
			end
		end
	end

	-- Made on first use, so a map with no doors gets no empty folder.
	local doorFolder = nil
	local function doors()
		if not doorFolder then
			doorFolder = Instance.new("Folder")
			doorFolder.Name = "Doors"
			doorFolder.Parent = rootFolder
		end
		return doorFolder
	end

	-- Prop templates: one configured copy per model, cloned for every placement.
	local templateNames = {}
	if #instances > 0 then
		local templates = {}
		for _, pair in libList do
			local key, entry = pair[1], pair[2]
			templateNames[key] = entry.n
			local t = {}
			for _, name in entry.parts do
				local m, part = meshInfo[name], loaded[name]
				if part then
					prep(part, m.c, m.s, true)
					part.CanTouch = false
					if m.m then applyMaterial(part, materials[m.m + 1], images) end
					local big = math.max(m.s[1], m.s[2], m.s[3]) > 30
					local mode = big and Enum.CollisionFidelity.PreciseConvexDecomposition or Enum.CollisionFidelity.Hull
					table.insert(t, { part = part, c = m.c, s = m.s, mode = mode })
				else
					missing += 1
				end
			end
			templates[key] = t
		end
		for i, inst in instances do
			local t = templates[inst.k]
			if t then
				local base = cf12(inst.cf)
				local s = inst.s or 1
				local model = Instance.new("Model")
				model.Name = inst.n or templateNames[inst.k] or inst.k
				local loose = inst.phys and not inst.ns and optLoose()
				for _, sub in t do
					local p = sub.part:Clone()
					p.Size = Vector3.new(math.max(sub.s[1] * s, 0.01), math.max(sub.s[2] * s, 0.01), math.max(sub.s[3] * s, 0.01))
					p.CFrame = base * CFrame.new(sub.c[1] * s, sub.c[2] * s, sub.c[3] * s) * MESH_FIX
					if inst.ns then
						p.CanCollide = false; p.CanQuery = false
						fidelity(p, Enum.CollisionFidelity.Box)
					else
						fidelity(p, sub.mode)
					end
					if inst.t then
						local c = Color3.fromRGB(inst.t[1], inst.t[2], inst.t[3])
						p.Color = c
						local sa = p:FindFirstChildOfClass("SurfaceAppearance")
						if sa then sa.Color = c end
					end
					if inst.a then p.Transparency = inst.a end
					p.Parent = model
					if loose then
						p.Anchored = false
						if model.PrimaryPart then
							local weld = Instance.new("WeldConstraint")
							weld.Part0 = model.PrimaryPart
							weld.Part1 = p
							weld.Parent = p
						else
							model.PrimaryPart = p
						end
					end
				end
				model.Parent = inst.door and doors() or propFolder
			end
			if i % BATCH == 0 then status(("Placing props (%d of %d)"):format(i, #instances), sectionRange(0.55, 0.85, i, #instances)) end
		end
	end

	for i, p in parts do
		local part = Instance.new(p.t == "w" and "WedgePart" or "Part")
		part.Anchored = true
		part.Size = Vector3.new(p.s[1], p.s[2], p.s[3])
		part.CFrame = cf12(p.cf)
		part.Transparency = 1
		part.CastShadow = false
		part.CanTouch = false
		part.Parent = collFolder
		if i % (BATCH * 4) == 0 then status(("Placing colliders (%d of %d)"):format(i, #parts), sectionRange(0.85, 0.92, i, #parts)) end
	end

	if #brushes > 0 then
		local brushFolder = Instance.new("Folder")
		brushFolder.Name = "Brushes"
		brushFolder.Parent = rootFolder
		-- SubtractAsync only works in the Workspace, and the map isn't parented there yet.
		local work = Instance.new("Folder")
		work.Name = "__SourceMapCSG"
		work.Parent = workspace
		-- A brush door keeps all its brushes in one Model, so it can be moved as a single door.
		local doorModels = {}
		local function brushParent(b)
			if not b.dr then return brushFolder end
			if not doorModels[b.dr] then
				local m = Instance.new("Model")
				m.Name = b.dn or "BrushDoor"
				m.Parent = doors()
				doorModels[b.dr] = m
			end
			return doorModels[b.dr]
		end
		local ok, failed = pcall(buildBrushes, brushes, materials, images, brushParent, work, function(done, total)
			status(("Building brushes (%d of %d)"):format(done, total), sectionRange(0.85, 0.92, done, total))
		end)
		work.Parent = nil
		if not ok then error(failed) end
		if failed > 0 then table.insert(problems, failed .. " brush(es) failed to cut") end
	end

	if #overlays > 0 then
		local overlayFolder = Instance.new("Folder")
		overlayFolder.Name = "Overlays"
		overlayFolder.Parent = rootFolder
		local ok, failed = pcall(buildBrushes, overlays, materials, images, function() return overlayFolder end, nil, function(done, total)
			status(("Placing overlays (%d of %d)"):format(done, total), 0.92)
		end)
		if not ok then error(failed) end
		if failed > 0 then table.insert(problems, failed .. " overlay(s) failed") end
	end

	status("Adding ropes, spawns and markers", 0.92)
	local function invisibleAnchor(parent, name, position, size)
		local p = Instance.new("Part")
		p.Name = name
		p.Anchored = true
		p.CanCollide = false
		p.CanQuery = false
		p.CanTouch = false
		p.CastShadow = false
		p.Transparency = 1
		p.Size = size
		p.Position = position
		p.Parent = parent
		return p
	end

	-- Each end gets its own anchored part: a rope with both ends on one part may not draw in a live game.
	if #ropes > 0 then
		local ropeFolder = Instance.new("Folder")
		ropeFolder.Name = "Ropes"
		ropeFolder.Parent = rootFolder
		local nodes = {}
		local function nodeAt(v)
			local k = v[1] .. "," .. v[2] .. "," .. v[3]
			if nodes[k] then return nodes[k] end
			local p = invisibleAnchor(ropeFolder, "RopeNode", Vector3.new(v[1], v[2], v[3]), Vector3.one * 0.05)
			local a = Instance.new("Attachment")
			a.Parent = p
			nodes[k] = a
			return a
		end
		for _, r in ropes do
			local c = Instance.new("RopeConstraint")
			c.Attachment0 = nodeAt(r.a)
			c.Attachment1 = nodeAt(r.b)
			c.Length = r.l
			c.Thickness = r.w
			c.Color = BrickColor.new(Color3.fromRGB(r.c[1], r.c[2], r.c[3]))
			c.Visible = true
			c.Parent = c.Attachment0.Parent
		end
	end

	if #spawns > 0 then
		local spawnFolder = Instance.new("Folder")
		spawnFolder.Name = "Spawns"
		spawnFolder.Parent = rootFolder
		for _, s in spawns do
			local sp = Instance.new("SpawnLocation")
			sp.Name = s.c or "Spawn"
			sp.Anchored = true
			sp.CanCollide = false
			sp.CanTouch = true
			sp.Transparency = 1
			sp.Neutral = true
			sp.Duration = 0
			sp.Size = Vector3.new(4, 1, 4)
			sp.CFrame = CFrame.lookAlong(Vector3.new(s.p[1], s.p[2] + 0.5, s.p[3]), Vector3.new(s.d[1], s.d[2], s.d[3]))
			if s.c then sp:SetAttribute("SourceClass", s.c) end
			sp.Parent = spawnFolder
		end
	end

	if #markers > 0 then
		local markerFolder = Instance.new("Folder")
		markerFolder.Name = "Entities"
		markerFolder.Parent = rootFolder
		for _, m in markers do
			local p = invisibleAnchor(markerFolder, m.n or m.c, Vector3.new(m.p[1], m.p[2], m.p[3]), Vector3.one)
			p.CFrame = CFrame.lookAlong(p.Position, Vector3.new(m.d[1], m.d[2], m.d[3]))
			p:SetAttribute("SourceClass", m.c)
			if m.n then p:SetAttribute("SourceName", m.n) end
		end
	end

	if #missingProps > 0 then
		local counts, names = {}, {}
		for _, m in missingProps do
			if not counts[m.m] then counts[m.m] = 0; table.insert(names, m.m) end
			counts[m.m] += 1
		end
		table.sort(names, function(a, b) return counts[a] > counts[b] end)
		warn(("[SourceMapImporter] %d prop(s) from %d model(s) are missing, most used first:"):format(#missingProps, #names))
		for _, n in names do print(("    %s (x%d)"):format(n, counts[n])) end
		table.insert(problems, #missingProps .. " prop(s) missing, listed in Output")

		if optMissing() then
			local boxes = Instance.new("Folder")
			boxes.Name = "MissingProps"
			boxes.Parent = rootFolder
			for i, m in missingProps do
				if i > 256 then break end
				local p = Instance.new("Part")
				p.Name = m.m
				p.Anchored = true
				p.CanCollide = false
				p.CanQuery = false
				p.CanTouch = false
				p.Size = Vector3.one * 2
				p.Position = Vector3.new(m.p[1], m.p[2] + 1, m.p[3])
				p.Color = Color3.fromRGB(255, 0, 0)
				p.Material = Enum.Material.Neon
				p.Transparency = 0.4
				local gui = Instance.new("BillboardGui")
				gui.Size = UDim2.fromOffset(220, 30)
				gui.StudsOffsetWorldSpace = Vector3.new(0, 2, 0)
				gui.MaxDistance = 50
				gui.AlwaysOnTop = true
				local text = Instance.new("TextLabel")
				text.Size = UDim2.fromScale(1, 1)
				text.BackgroundTransparency = 1
				text.TextColor3 = Color3.new(1, 1, 1)
				text.TextStrokeTransparency = 0
				text.TextScaled = true
				text.Text = "Missing: " .. m.m
				text.Parent = gui
				gui.Parent = p
				p.Parent = boxes
			end
		end
	end

	-- Swap only once the new build exists, so a failed build leaves the old one standing.
	local previous = workspace:FindFirstChild(rootFolder.Name)
	rootFolder.Parent = workspace
	if previous and optReplace() then previous.Parent = nil end

	if optBaseplate() then
		local plate = workspace:FindFirstChild("Baseplate")
		if plate and plate:IsA("BasePart") and plate.Size.X >= 512 and plate.Size.Z >= 512 and plate.Size.Y <= 32 then
			plate.Parent = nil
		end
	end

	if optLock() then
		for i, d in rootFolder:GetDescendants() do
			if d:IsA("BasePart") then d.Locked = true end
			if i % 2000 == 0 then task.wait() end
		end
	end

	-- Off for now: setting this on about 1265 meshes at once likely crashed Studio.
	-- Bring it back in small batches, tested on a few parts first.
	table.clear(pendingFidelity)

	for _, w in water do
		workspace.Terrain:FillBlock(CFrame.new(w.c[1], w.c[2], w.c[3]), Vector3.new(w.s[1], w.s[2], w.s[3]), Enum.Material.Water)
	end

	if #lights > 0 then
		local holder = Instance.new("Part")
		holder.Name = "Lights"
		holder.Anchored = true
		holder.CanCollide = false
		holder.CanQuery = false
		holder.CanTouch = false
		holder.Transparency = 1
		holder.Size = Vector3.one
		holder.CFrame = CFrame.new()
		holder.Parent = rootFolder
		local matchLight = optMatchLight()
		for _, l in lights do
			if l.pn and not matchLight then continue end
			local a = Instance.new("Attachment")
			a.Position = Vector3.new(l.p[1], l.p[2], l.p[3])
			local li
			if l.d then
				a.CFrame = CFrame.lookAlong(a.Position, Vector3.new(l.d[1], l.d[2], l.d[3]))
				li = Instance.new("SpotLight")
				li.Angle = math.clamp(l.a * 2, 1, 180)
				li.Face = Enum.NormalId.Front
			else
				li = Instance.new("PointLight")
			end
			li.Color = Color3.fromRGB(l.c[1], l.c[2], l.c[3])
			li.Brightness = matchLight and l.fb or l.b
			li.Range = matchLight and l.fr or l.r
			li.Shadows = matchLight
			li.Parent = a
			a.Parent = holder
		end
	end

	if optSky() then
		if info.sky then
			for _, old in Lighting:GetChildren() do
				if old:IsA("Sky") then old.Parent = nil end
			end
			local sky = Instance.new("Sky")
			for face, hash in info.sky do
				local rec = images[hash]
				if rec then sky["Skybox" .. face] = imageUrl(rec) end
			end
			sky.Parent = Lighting
		end
		if info.sun then
			-- Search the clock and latitude for the sun direction closest to the map's.
			local target = Vector3.new(info.sun.dir[1], info.sun.dir[2], info.sun.dir[3]).Unit
			local best, bestClock, bestLat = -2, Lighting.ClockTime, Lighting.GeographicLatitude
			for lat = -60, 60, 10 do
				Lighting.GeographicLatitude = lat
				for clock = 6, 18, 0.5 do
					Lighting.ClockTime = clock
					local d = Lighting:GetSunDirection():Dot(target)
					if d > best then best, bestClock, bestLat = d, clock, lat end
				end
			end
			Lighting.ClockTime = bestClock
			Lighting.GeographicLatitude = bestLat
			local a = info.sun.ambient
			if a then Lighting.OutdoorAmbient = Color3.fromRGB(a[1], a[2], a[3]) end
		end
		-- An Atmosphere overrides the Lighting fog settings, so this is the one that counts.
		if info.fog and info.fog.density then
			local air = Lighting:FindFirstChildOfClass("Atmosphere")
			if not air then
				air = Instance.new("Atmosphere")
				air.Parent = Lighting
			end
			local color = Color3.fromRGB(info.fog.color[1], info.fog.color[2], info.fog.color[3])
			air.Color = color
			air.Decay = color
			air.Density = info.fog.density
			air.Offset = 0.25
			air.Glare = 0
			air.Haze = 0
		end
	end

	if optMatchLight() then
		Lighting.LightingStyle = Enum.LightingStyle.Realistic
		Lighting.PrioritizeLightingQuality = true
		local sun = info.sun
		Lighting.GlobalShadows = true
		Lighting.EnvironmentSpecularScale = 0.2
		Lighting.EnvironmentDiffuseScale = 0.2
		Lighting.OutdoorAmbient = Color3.new()
		Lighting.Ambient = Color3.new()
		-- A map with no light_environment has no sun in Source either.
		Lighting.Brightness = sun and 2 or 0
		if sun then
			local a = sun.ambient
			if a then
				-- Source fills shadows with baked bounce light, which Roblox lacks. Without a floor, maps
				-- with a low ambient value (most of L4D2) get pitch black shadows.
				local level = math.clamp((sun.ambientBrightness or 200) / 400, 0.2, 1)
				Lighting.Ambient = Color3.fromRGB(a[1], a[2], a[3]):Lerp(Color3.new(), 1 - level)
			end
			local c = sun.color
			if c then Lighting.ColorShift_Top = Color3.fromRGB(c[1], c[2], c[3]) end
			Lighting.ExposureCompensation = math.clamp((sun.brightness or 200) / 1000, -3, 3)
		end
	end

	if missing > 0 then table.insert(problems, missing .. " mesh(es) missing from the uploaded files") end
	Selection:Set({ rootFolder })
	return problems
end

local info = nil
local building = false

local function refresh()
	plugin:SetSetting("port", portBox.Text)
	local ok, res = pcall(getJson, "/plugin/info")
	if not ok then
		info = nil
		infoLabel.Text = "Can't reach the app. Open Source Map Importer, and allow HTTP if Studio asks."
		return
	end
	if not res.ready then
		info = nil
		infoLabel.Text = res.reason
		return
	end
	info = res
	local lines = {
		res.map,
		("%d meshes, %d props, %d colliders"):format(res.counts.meshes, res.counts.instances, res.counts.parts),
		("%d ropes, %d spawns, %d markers"):format(res.counts.ropes or 0, res.counts.spawns or 0, res.counts.markers or 0),
	}
	if (res.counts.missingProps or 0) > 0 then
		table.insert(lines, ("%d props couldn't be found"):format(res.counts.missingProps))
	end
	if res.missing.images > 0 or res.missing.models > 0 then
		table.insert(lines, ("Not uploaded yet: %d textures, %d geometry files"):format(res.missing.images, res.missing.models))
	end
	if res.stale then table.insert(lines, "Decisions changed since this build. Rebuild in the app first.") end
	infoLabel.Text = table.concat(lines, "\n")
end

refreshBtn.Activated:Connect(refresh)

buildBtn.Activated:Connect(function()
	if building then return end
	refresh()
	if not info then return end
	if info.stale then status("Rebuild in the app first."); return end
	if info.missing.models > 0 or info.missing.images > 0 then status("Upload the map in the app first."); return end
	building = true
	startedAt = os.clock()
	local rec = ChangeHistoryService:TryBeginRecording("Build Source map")
	local ok, res = pcall(buildMap, info)
	if rec then
		ChangeHistoryService:FinishRecording(rec, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel)
	end
	building = false
	barBack.Visible = false
	if not ok then
		warn("[SourceMapImporter]", res)
		status("Failed: " .. tostring(res))
	elseif #res > 0 then
		for _, p in res do warn("[SourceMapImporter]", p) end
		status("Built with " .. #res .. " problem(s). See Output.")
	else
		status("Done.")
	end
end)

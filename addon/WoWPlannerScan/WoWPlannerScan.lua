local ADDON = "WoWPlannerScan"
local INTERVAL = 600
local CHUNK = 400
local PAGE_SIZE = NUM_AUCTION_ITEMS_PER_PAGE or 50
local REGIONS = { [1] = "us", [2] = "kr", [3] = "eu", [4] = "tw", [5] = "cn" }

local f = CreateFrame("Frame")
local ahOpen = false
local scanning = false
local mode = nil
local page = 0
local rows = {}
local waitingList = false
local pendingSave = false

local function say(msg)
  DEFAULT_CHAT_FRAME:AddMessage("|cff4cc3ffWoWPlanner|r " .. msg)
end

local function db()
  WoWPlannerScanDB = WoWPlannerScanDB or {}
  local d = WoWPlannerScanDB
  d.v = 1
  d.scans = d.scans or {}
  if d.auto == nil then d.auto = true end
  return d
end

local function ownerHash(s)
  if not s or s == "" then return 0 end
  local h = 5381
  for i = 1, #s do
    h = (h * 33 + s:byte(i)) % 2147483647
  end
  return h
end

local function readEntry(i)
  local name, _, count, _, _, _, _, minBid, _, buyout, bidAmount, _, _, owner, ownerFull, _, itemId = GetAuctionItemInfo("list", i)
  if not itemId or itemId == 0 then return end
  local tl = GetAuctionItemTimeLeft("list", i) or 0
  rows[#rows + 1] = itemId .. "," .. (count or 1) .. "," .. (buyout or 0) .. "," .. ((bidAmount and bidAmount > 0) and bidAmount or (minBid or 0)) .. "," .. tl .. "," .. ownerHash(ownerFull or owner)
end

local saveFrame

local function showSave()
  if not saveFrame then
    saveFrame = CreateFrame("Frame", "WoWPlannerScanSave", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
    saveFrame:SetSize(250, 74)
    saveFrame:SetPoint("TOP", UIParent, "TOP", 0, -140)
    if saveFrame.SetBackdrop then
      saveFrame:SetBackdrop({ bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background", edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border", tile = true, tileSize = 32, edgeSize = 16, insets = { left = 4, right = 4, top = 4, bottom = 4 } })
    end
    saveFrame:SetMovable(true)
    saveFrame:EnableMouse(true)
    saveFrame:RegisterForDrag("LeftButton")
    saveFrame:SetScript("OnDragStart", saveFrame.StartMoving)
    saveFrame:SetScript("OnDragStop", saveFrame.StopMovingOrSizing)
    local text = saveFrame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    text:SetPoint("TOP", 0, -12)
    saveFrame.text = text
    local b = CreateFrame("Button", nil, saveFrame, "UIPanelButtonTemplate")
    b:SetSize(130, 22)
    b:SetPoint("BOTTOMLEFT", 12, 10)
    b:SetText("Save and upload")
    b:SetScript("OnClick", function() ReloadUI() end)
    local c = CreateFrame("Button", nil, saveFrame, "UIPanelButtonTemplate")
    c:SetSize(80, 22)
    c:SetPoint("BOTTOMRIGHT", -12, 10)
    c:SetText("Later")
    c:SetScript("OnClick", function() saveFrame:Hide() end)
  end
  saveFrame.text:SetText(string.format("Auction scan ready (%d listings)", #rows))
  saveFrame:Show()
end

local function finish()
  local d = db()
  local realm = GetRealmName() or "Unknown"
  local faction = UnitFactionGroup("player") or "Neutral"
  local region = REGIONS[GetCurrentRegion and GetCurrentRegion() or 1] or "us"
  local key = realm .. "#" .. faction
  local header = table.concat({ "v1", time(), region, realm, faction, #rows }, "#")
  d.scans[key] = header .. "#" .. table.concat(rows, ";")
  d.last = time()
  scanning = false
  mode = nil
  pendingSave = true
  say(string.format("Scan done: %d listings on %s (%s). Click Save and upload, or /reload, to send it.", #rows, realm, faction))
  showSave()
end

local function readAll(i, total)
  local last = math.min(total, i + CHUNK - 1)
  for k = i, last do readEntry(k) end
  if last < total then
    C_Timer.After(0, function() readAll(last + 1, total) end)
  else
    finish()
  end
end

local function queryPage()
  if not ahOpen then
    scanning = false
    say("Auction house closed, scan stopped.")
    return
  end
  if not CanSendAuctionQuery() then
    C_Timer.After(0.3, queryPage)
    return
  end
  waitingList = true
  QueryAuctionItems("", nil, nil, page, false, 0, false, false, nil)
end

local function startScan(manual)
  if scanning or not ahOpen then return end
  local canQuery, canAll = CanSendAuctionQuery()
  rows = {}
  scanning = true
  if canAll then
    mode = "all"
    waitingList = true
    say("Scanning the whole auction house...")
    QueryAuctionItems("", nil, nil, 0, false, 0, true, false, nil)
  else
    mode = "page"
    page = 0
    say(manual and "Full scan is on cooldown, scanning page by page..." or "Scanning page by page...")
    queryPage()
  end
end

local function onList()
  if not scanning or not waitingList then return end
  waitingList = false
  local batch, total = GetNumAuctionItems("list")
  if mode == "all" then
    C_Timer.After(0.5, function()
      local b = GetNumAuctionItems("list")
      readAll(1, b)
    end)
  else
    for i = 1, batch do readEntry(i) end
    page = page + 1
    if page * PAGE_SIZE >= (total or 0) or batch == 0 then
      finish()
    else
      C_Timer.After(0.1, queryPage)
    end
  end
end

local ticker
local function tick()
  local d = db()
  if d.auto and ahOpen and not scanning and time() - (d.last or 0) >= INTERVAL then startScan(false) end
end

f:SetScript("OnEvent", function(_, event)
  if event == "AUCTION_HOUSE_SHOW" then
    ahOpen = true
    if not ticker then ticker = C_Timer.NewTicker(15, tick) end
    C_Timer.After(2, tick)
  elseif event == "AUCTION_HOUSE_CLOSED" then
    ahOpen = false
  elseif event == "AUCTION_ITEM_LIST_UPDATE" then
    onList()
  elseif event == "PLAYER_LOGIN" then
    db()
  end
end)
f:RegisterEvent("AUCTION_HOUSE_SHOW")
f:RegisterEvent("AUCTION_HOUSE_CLOSED")
f:RegisterEvent("AUCTION_ITEM_LIST_UPDATE")
f:RegisterEvent("PLAYER_LOGIN")

SLASH_WOWPLANNERSCAN1 = "/wps"
SlashCmdList.WOWPLANNERSCAN = function(msg)
  msg = (msg or ""):lower()
  local d = db()
  if msg == "scan" then
    if not ahOpen then say("Open the auction house first.") else startScan(true) end
  elseif msg == "auto on" then
    d.auto = true
    say("Auto scan on: every 10 minutes while the auction house is open.")
  elseif msg == "auto off" then
    d.auto = false
    say("Auto scan off.")
  elseif msg == "save" then
    ReloadUI()
  else
    local n = 0
    for _ in pairs(d.scans) do n = n + 1 end
    say(string.format("Auto scan %s. Last scan %s. Saved scans: %d. Commands: /wps scan, /wps auto on|off, /wps save", d.auto and "on" or "off", d.last and date("%H:%M", d.last) or "never", n))
  end
end

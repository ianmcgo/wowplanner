$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$configFile = Join-Path $here 'config.json'
$stateFile = Join-Path $here 'uploaded.json'

if (-not (Test-Path $configFile)) {
  Write-Host 'First run setup.'
  $tok = Read-Host 'Paste your GitHub token (Contents and Actions read and write on ianmcgo/wowplanner)'
  $wtf = Read-Host 'WoW Forever WTF folder (press Enter for C:\Program Files (x86)\World of Warcraft\_forever_\WTF)'
  if (-not $wtf) { $wtf = 'C:\Program Files (x86)\World of Warcraft\_forever_\WTF' }
  @{ token = $tok; wtf = $wtf; repo = 'ianmcgo/wowplanner'; branch = 'scans'; game = 'forever'; dispatchMinutes = 10 } | ConvertTo-Json | Set-Content -Encoding UTF8 $configFile
}

$cfg = Get-Content -Raw $configFile | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($cfg.token)"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'WoWPlannerUploader'; 'X-GitHub-Api-Version' = '2022-11-28' }
$api = "https://api.github.com/repos/$($cfg.repo)"
$state = @{}
if (Test-Path $stateFile) { (Get-Content -Raw $stateFile | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = [long]$_.Value } }
$lastDispatch = [datetime]::MinValue
$dispatchDue = $false
$seenWrite = @{}

function Save-State { $state | ConvertTo-Json | Set-Content -Encoding UTF8 $stateFile }

function Get-Slug([string]$s) { ($s.ToLower() -replace '[^a-z0-9]+', '-').Trim('-') }

function Send-Scan($key, $text, $region, $realm, $faction) {
  $path = "$($cfg.game)/$region/$(Get-Slug $realm)-$(Get-Slug $faction).txt"
  $sha = $null
  try {
    $cur = Invoke-RestMethod -Headers $headers -Uri "$api/contents/$path`?ref=$($cfg.branch)"
    $sha = $cur.sha
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 404) { throw }
  }
  $body = @{ message = "Scan $realm $faction"; branch = $cfg.branch; content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }
  if ($sha) { $body.sha = $sha }
  Invoke-RestMethod -Method Put -Headers $headers -Uri "$api/contents/$path" -Body ($body | ConvertTo-Json) -ContentType 'application/json' | Out-Null
}

function Send-Dispatch {
  $body = @{ ref = 'main'; inputs = @{ games = $cfg.game; keep_others = '1' } } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Headers $headers -Uri "$api/actions/workflows/collect.yml/dispatches" -Body $body -ContentType 'application/json' | Out-Null
}

Write-Host "Watching $($cfg.wtf) for WoWPlanner scans. Leave this window open while you play. Press Ctrl+C to stop."
while ($true) {
  try {
    $files = Get-ChildItem -Path (Join-Path $cfg.wtf 'Account') -Recurse -Filter 'WoWPlannerScan.lua' -ErrorAction SilentlyContinue | Where-Object { $_.DirectoryName -like '*SavedVariables' }
    foreach ($file in $files) {
      $stamp = $file.LastWriteTimeUtc.Ticks
      if ($seenWrite[$file.FullName] -eq $stamp) { continue }
      $raw = Get-Content -Raw -Encoding UTF8 $file.FullName
      $found = [regex]::Matches($raw, '"(v1#[^"]*)"')
      foreach ($m in $found) {
        $text = $m.Groups[1].Value
        $parts = $text.Split('#', 7)
        if ($parts.Count -lt 7) { continue }
        $t = [long]$parts[1]; $region = $parts[2]; $realm = $parts[3]; $faction = $parts[4]; $n = $parts[5]
        $key = "$region|$realm|$faction"
        if ($state.ContainsKey($key) -and $state[$key] -ge $t) { continue }
        Write-Host ("{0:HH:mm} Uploading {1} listings from {2} ({3})" -f (Get-Date), $n, $realm, $faction)
        Send-Scan $key $text $region $realm $faction
        $state[$key] = $t
        Save-State
        $dispatchDue = $true
      }
      $seenWrite[$file.FullName] = $stamp
    }
    if ($dispatchDue -and ((Get-Date) - $lastDispatch).TotalMinutes -ge $cfg.dispatchMinutes) {
      Send-Dispatch
      $lastDispatch = Get-Date
      $dispatchDue = $false
      Write-Host ("{0:HH:mm} Asked the site to update. New prices show in a few minutes." -f (Get-Date))
    }
  } catch {
    Write-Host ("{0:HH:mm} Problem: {1}" -f (Get-Date), $_.Exception.Message)
  }
  Start-Sleep -Seconds 30
}

param(
  [string]$OutFile = 'data/europe/eu_cities_30k.js'
)

$ErrorActionPreference = 'Stop'

$work = Join-Path $PSScriptRoot '..\tmp_eu'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$zip = Join-Path $work 'cities15000.zip'
$txt = Join-Path $work 'cities15000.txt'

$dl = 'http://download.geonames.org/export/dump/cities15000.zip'
Write-Host "Downloading Geonames cities15000..."
Invoke-WebRequest -Uri $dl -OutFile $zip

Write-Host "Extracting..."
Expand-Archive -Path $zip -DestinationPath $work -Force

# Geonames columns
$headers = @(
  'geonameid','name','asciiname','alternatenames','latitude','longitude','feature_class','feature_code','country_code','cc2','admin1_code','admin2_code','admin3_code','admin4_code','population','elevation','dem','timezone','modification_date'
)

# Allowed European ISO2 country codes (incl. UK, Iceland; exclude Greenland and overseas)
$allowed = @(
  'AL','AD','AT','BA','BE','BG','BY','CH','CZ','DE','DK','EE','ES','FI','FR','GB','GI','GR','HR','HU','IE','IM','IS','IT','JE','LI','LT','LU','LV','MC','MD','ME','MK','MT','NL','NO','PL','PT','RO','RS','RU','SE','SI','SK','SM','TR','UA','VA','GG','FO','AX'
)

$rows = Get-Content -Path $txt

$records = foreach ($line in $rows) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $parts = $line -split "`t", $headers.Count
  if ($parts.Count -lt $headers.Count) { continue }
  $obj = [ordered]@{}
  for ($i=0; $i -lt $headers.Count; $i++) { $obj[$headers[$i]] = $parts[$i] }
  $obj
}

# Filter
$filtered = $records | Where-Object {
  $cc = $_.country_code
  if (-not $allowed.Contains($cc)) { return $false }
  $pop = [int64]$_.population
  if ($pop -lt 30000) { return $false }
  $lat = [double]$_.latitude
  $lon = [double]$_.longitude
  if ($lat -lt 34 -or $lat -gt 72 -or $lon -lt -25 -or $lon -gt 40) { return $false }
  # Restrict Turkey to European side roughly (west of Bosphorus)
  if ($cc -eq 'TR' -and ($lon -gt 30.5 -or $lat -lt 40)) { return $false }
  # Restrict Russia to west of ~40E is already ensured by bbox
  return $true
}

# Project to our minimal schema and dedupe by name+cc rounded coords
$seen = New-Object System.Collections.Generic.HashSet[string]
$out = New-Object System.Collections.Generic.List[object]
foreach ($r in $filtered) {
  $name = $r.name
  $cc = $r.country_code
  $lat = [math]::Round([double]$r.latitude, 6)
  $lon = [math]::Round([double]$r.longitude, 6)
  $pop = [int64]$r.population
  $key = ($name.ToLower() + '|' + $cc + '|' + ([math]::Round($lat*1000)) + '|' + ([math]::Round($lon*1000)))
  if ($seen.Add($key)) {
    $out.Add([pscustomobject]@{ name = $name; state = $cc; lat = $lat; lon = $lon; pop = $pop }) | Out-Null
  }
}

# Sort by pop desc for nicer ordering
$out = $out | Sort-Object -Property @{Expression='pop';Descending=$true}

# Write JS file
$dest = Resolve-Path $OutFile -ErrorAction SilentlyContinue
if (-not $dest) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
}
Write-Host "Writing $OutFile ..."
"const EU_CITY_DATA_30K = [" | Out-File -FilePath $OutFile -Encoding UTF8
$first = $true
foreach ($c in $out) {
  $line = "  { name: '" + ($c.name.Replace("'","\\'")) + "', state: '" + $c.state + "', lat: " + ($c.lat.ToString().Replace(',', '.')) + ", lon: " + ($c.lon.ToString().Replace(',', '.')) + ", pop: " + $c.pop + " },"
  Add-Content -Path $OutFile -Value $line
}
"];
" | Add-Content -Path $OutFile

Write-Host "Done. Wrote $($out.Count) cities to $OutFile"

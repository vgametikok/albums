param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$Ref = "rizveurkjpcwrmbtoawj"
)
$ErrorActionPreference = "Stop"
$token = (Get-Content -Raw -Encoding UTF8 "$PSScriptRoot\..\.supabase-token").Trim()
$sql = Get-Content -Raw -Encoding UTF8 $Path

# PS 5.1 ConvertTo-Json ломается на длинных строках -> экранируем вручную
$esc = $sql.Replace('\','\\').Replace('"','\"').Replace("`r",'\r').Replace("`n",'\n').Replace("`t",'\t')
$body = '{"query":"' + $esc + '"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

try {
  $resp = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$Ref/database/query" `
    -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
    -Method Post -Body $bytes
  "OK"
  if ($resp) { $resp | ConvertTo-Json -Depth 6 }
} catch {
  "FAILED"
  $_.ErrorDetails.Message
  exit 1
}

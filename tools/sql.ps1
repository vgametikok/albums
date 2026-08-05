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

function Invoke-Sql([string]$text) {
  $e = $text.Replace('\','\\').Replace('"','\"').Replace("`r",'\r').Replace("`n",'\n').Replace("`t",'\t')
  $b = [System.Text.Encoding]::UTF8.GetBytes('{"query":"' + $e + '"}')
  Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$Ref/database/query" `
    -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
    -Method Post -Body $b
}

try {
  $resp = Invoke-Sql $sql
  "OK"
  if ($resp) { $resp | ConvertTo-Json -Depth 6 }

  # Файл вида 041_access_hardening.sql — это миграция: отмечаем её применённой.
  # Журнал вели «в голове», пока аудит не показал, что база уже не воспроизводится
  # из репозитория. Теперь отметка ставится сама.
  $leaf = Split-Path -Leaf $Path
  if ($leaf -match '^(\d{3,})_(.+)\.sql$') {
    $ver = $Matches[1]; $nm = $Matches[2]
    $note = "insert into supabase_migrations.schema_migrations (version, name) " +
            "values ('$ver', '$nm') on conflict (version) do nothing;"
    try { Invoke-Sql $note | Out-Null; "LOGGED $ver" } catch { "WARN: журнал миграций не обновлён" }
  }
} catch {
  "FAILED"
  $_.ErrorDetails.Message
  exit 1
}

param(
  [Parameter(Mandatory=$true)][string]$Slug,   # напр. r2-sign
  [Parameter(Mandatory=$true)][string]$Dir,    # папка функции с index.ts
  [switch]$VerifyJwt,                            # по умолчанию verify_jwt=false
  [string]$Ref = "rizveurkjpcwrmbtoawj"
)
# Деплой edge-функции через Supabase Management API multipart-эндпоинтом
# /v1/projects/{ref}/functions/deploy?slug=... (MCP-коннектор видит другую
# организацию — им деплоить нельзя). Сырые файлы, бандлит сервер.
$ErrorActionPreference = "Stop"
$token = (Get-Content -Raw -Encoding UTF8 "$PSScriptRoot\..\.supabase-token").Trim()
$code = Get-Content -Raw -Encoding UTF8 (Join-Path $Dir "index.ts")
$vj = if ($VerifyJwt) { 'true' } else { 'false' }
$metadata = '{"entrypoint_path":"index.ts","name":"' + $Slug + '","verify_jwt":' + $vj + '}'

$boundary = [System.Guid]::NewGuid().ToString()
$nl = "`r`n"
$b = New-Object System.Text.StringBuilder
[void]$b.Append("--$boundary$nl")
[void]$b.Append("Content-Disposition: form-data; name=`"metadata`"$nl")
[void]$b.Append("Content-Type: application/json$nl$nl")
[void]$b.Append("$metadata$nl")
[void]$b.Append("--$boundary$nl")
[void]$b.Append("Content-Disposition: form-data; name=`"file`"; filename=`"index.ts`"$nl")
[void]$b.Append("Content-Type: application/typescript$nl$nl")
[void]$b.Append("$code$nl")
[void]$b.Append("--$boundary--$nl")
$bytes = [System.Text.Encoding]::UTF8.GetBytes($b.ToString())

try {
  $resp = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$Ref/functions/deploy?slug=$Slug" `
    -Headers @{ Authorization = "Bearer $token" } `
    -Method Post -ContentType "multipart/form-data; boundary=$boundary" -Body $bytes
  "OK"
  if ($resp) { $resp | ConvertTo-Json -Depth 6 }
} catch {
  "FAILED"
  if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  exit 1
}

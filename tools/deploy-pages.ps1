param(
  [string]$Project = "albums",
  [switch]$Preview          # выложить в предпросмотр, не трогая боевую ветку
)
# Прямая выкладка сайта в Cloudflare Pages, без привязки к GitHub.
# Нужен .cf-token в корне (API-токен с правом Account -> Cloudflare Pages -> Edit),
# он в .gitignore. Идентификатор аккаунта скрипт узнаёт сам.
#
# Git-интеграция Pages удобнее (деплой по push), но её привязка к GitHub
# ломается со стороны Cloudflare; этот путь от неё не зависит вовсе.
$ErrorActionPreference = "Stop"

$tokenPath = "$PSScriptRoot\..\.cf-token"
if (-not (Test-Path $tokenPath)) {
  Write-Output "Нет файла .cf-token в корне репозитория."
  Write-Output "Создайте токен: Cloudflare -> My Profile -> API Tokens -> Create Token"
  Write-Output "  права: Account -> Cloudflare Pages -> Edit"
  Write-Output "и сохраните его одной строкой в D:\Albums\.cf-token"
  exit 1
}
$token = (Get-Content -Raw -Encoding UTF8 $tokenPath).Trim()

# Идентификатор аккаунта — из самого API, чтобы не держать второй файл.
try {
  $acc = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts" `
    -Headers @{ Authorization = "Bearer $token" }
} catch {
  Write-Output "FAILED: токен не принят Cloudflare"
  if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message }
  exit 1
}
if (-not $acc.result -or $acc.result.Count -eq 0) {
  Write-Output "FAILED: у токена нет доступа ни к одному аккаунту"
  exit 1
}
$accountId = $acc.result[0].id
Write-Output "Аккаунт: $($acc.result[0].name)"

Push-Location "$PSScriptRoot\.."
try {
  node build.mjs
  if ($LASTEXITCODE -ne 0) { throw "сборка не удалась" }

  $env:CLOUDFLARE_API_TOKEN = $token
  $env:CLOUDFLARE_ACCOUNT_ID = $accountId

  $branch = if ($Preview) { "preview" } else { "main" }
  npx --yes wrangler@latest pages deploy dist `
    --project-name=$Project --branch=$branch --commit-dirty=true
  if ($LASTEXITCODE -ne 0) { throw "выкладка не удалась" }
} finally {
  Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
  Pop-Location
}

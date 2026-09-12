[CmdletBinding()]
param(
  [string]$HostName = "127.0.0.1",
  [ValidateRange(1, 65535)]
  [int]$Port = 5432,
  [string]$AdminUser = "postgres",
  [SecureString]$AdminPassword
)

$ErrorActionPreference = "Stop"

function Resolve-Psql {
  $command = Get-Command psql -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $knownPath = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
  if (Test-Path -LiteralPath $knownPath) {
    return $knownPath
  }

  throw "psql was not found in PATH or the PostgreSQL 18 default install directory."
}

if (-not $AdminPassword -and $env:SPARK_POSTGRES_ADMIN_PASSWORD) {
  $AdminPassword = ConvertTo-SecureString `
    $env:SPARK_POSTGRES_ADMIN_PASSWORD `
    -AsPlainText `
    -Force
}

if (-not $AdminPassword) {
  $AdminPassword = Read-Host "PostgreSQL password for $AdminUser" -AsSecureString
}

$psql = Resolve-Psql
$credential = [PSCredential]::new($AdminUser, $AdminPassword)
$plainPassword = $credential.GetNetworkCredential().Password
$previousPassword = $env:PGPASSWORD

try {
  $env:PGPASSWORD = $plainPassword
  & $psql `
    --host $HostName `
    --port $Port `
    --username $AdminUser `
    --dbname postgres `
    --no-password `
    --set ON_ERROR_STOP=1 `
    --set app_password=spark_app_local_only `
    --set migrator_password=spark_migrate_local_only `
    --file (Join-Path $PSScriptRoot "..\infra\postgres\bootstrap-local.sql")

  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL bootstrap failed with exit code $LASTEXITCODE."
  }
} finally {
  $plainPassword = $null
  if ($null -eq $previousPassword) {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  } else {
    $env:PGPASSWORD = $previousPassword
  }
}

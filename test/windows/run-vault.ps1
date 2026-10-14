param([ValidateSet('node','bun')][string]$Runtime, [string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
$version = (& $Runtime --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Runtime version command failed' }
if ($ExpectedVersion -and $version -ne $ExpectedVersion) { throw "Wrong runtime: expected $ExpectedVersion, got $version" }
if ($Runtime -eq 'node' -and $version -notmatch '^v24\.') { throw "Expected Node 24, got $version" }
Write-Host "$Runtime $version"
New-Item -ItemType Directory -Force -Path windows-vault-evidence | Out-Null
$log = Join-Path windows-vault-evidence ("suite-$Runtime-$version.log")
[IO.File]::WriteAllText((Join-Path $PWD $log), '')
function Record-Line($value) {
  $line = $value.ToString()
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  [IO.File]::AppendAllText((Join-Path $PWD $log), $line + [Environment]::NewLine)
}
if ($Runtime -eq 'node') { & node --test --test-reporter=tap test/windows/claustrum-vault.mjs 2>&1 | ForEach-Object { Record-Line $_ }; $exit = $LASTEXITCODE }
else { & bun test ./test/windows/claustrum-vault.mjs --timeout 100000 2>&1 | ForEach-Object { Record-Line $_ }; $exit = $LASTEXITCODE }
if ($exit -ne 0) { throw "Windows vault qualification failed ($exit); exact output is in $log" }
& $Runtime test/windows/vault-summary.mjs $Runtime $log
if ($LASTEXITCODE -ne 0) { throw "Windows vault execution-count guard failed; exact output is in $log" }

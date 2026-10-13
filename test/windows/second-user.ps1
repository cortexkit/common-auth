$ErrorActionPreference = 'Stop'
$request = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'request.json')) | ConvertFrom-Json
function IsDenied([scriptblock]$Operation) {
  try { & $Operation | Out-Null; return $false }
  catch {
    $errorObject = $_.Exception
    while ($errorObject.InnerException) { $errorObject = $errorObject.InnerException }
    if ($errorObject -is [UnauthorizedAccessException]) { return $true }
    throw
  }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -ne $request.expectedSid) { throw 'Probe ran as the wrong user' }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Probe must be non-admin' }
$publicRead = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'control.txt')) -eq 'public control'
if (-not $publicRead) { throw 'Public read positive control failed' }
$filesDenied = $true
foreach ($path in $request.paths) {
  if (-not (IsDenied { [IO.File]::ReadAllBytes($path) })) { $filesDenied = $false }
}
$directoryDenied = IsDenied { [IO.Directory]::GetFiles($request.directory) }
@{ sid = $identity.User.Value; standardUser = $true; publicRead = $publicRead; filesDenied = $filesDenied; directoryDenied = $directoryDenied; fileCount = @($request.paths).Count } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.json')
if (-not $filesDenied -or -not $directoryDenied) { throw 'Private objects were accessible' }

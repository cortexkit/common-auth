$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$request = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'request.json')) | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -ne $request.expectedSid) { throw 'Config probe ran as the wrong user' }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Config probe must be non-admin' }
$profile = [Environment]::GetFolderPath('UserProfile')
$dir = Join-Path $profile '.config\opencode'
[IO.Directory]::CreateDirectory($dir) | Out-Null
$legacy = Join-Path $dir ('common-auth-legacy-' + [Guid]::NewGuid().ToString('N') + '.json')
$sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
function Descriptor($path, $directory) {
  if ($directory) { $acl = [Security.AccessControl.DirectorySecurity]::new($path, $sections) }
  else { $acl = [Security.AccessControl.FileSecurity]::new($path, $sections) }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  return @{ path = $path; owner = $raw.Owner.Value; control = [int]$raw.ControlFlags; aces = @($raw.DiscretionaryAcl | ForEach-Object { @{ sid = $_.SecurityIdentifier.Value; flags = [int]$_.AceFlags; mask = $_.AccessMask; type = [int]$_.AceType } }) }
}
$env:COMMON_AUTH_CONFIG_DIR = $dir
$env:COMMON_AUTH_LEGACY_FILE = $legacy
$result = $null
try {
  [IO.File]::WriteAllText($legacy, '{"legacy":true}')
  $before = Descriptor $legacy $false
  if ($before.owner -ne $identity.User.Value -or ($before.control -band 0x1000) -ne 0) { throw 'Legacy fixture must be user-owned with inherited ACLs' }
  $parentBefore = Descriptor $dir $true
  $child = Start-Process -FilePath (Join-Path $PSScriptRoot $request.runtimeName) -ArgumentList ('"' + (Join-Path $PSScriptRoot 'standard-config.mjs') + '"') -WorkingDirectory $PSScriptRoot -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'runtime-out.txt') -RedirectStandardError (Join-Path $PSScriptRoot 'runtime-err.txt')
  $null = $child.Handle
  if (-not $child.WaitForExit(20000)) { $child.Kill(); throw 'Standard config runtime timeout' }
  $child.WaitForExit()
  if ($child.ExitCode) { throw ('Standard-user config runtime failed: ' + [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'runtime-err.txt'))) }
  $result = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'runtime-out.txt')) | ConvertFrom-Json
  $records = @($legacy, $result.path, $result.port | ForEach-Object { Descriptor $_ $false })
  foreach ($record in $records) {
    if ($record.owner -ne $identity.User.Value -or ($record.control -band 0x1004) -ne 0x1004 -or $record.aces.Count -ne 1 -or $record.aces[0].sid -ne $identity.User.Value -or $record.aces[0].flags -ne 0 -or $record.aces[0].mask -ne 0x1f01ff) { throw 'Independent owner-only inspection failed' }
  }
  $parentAfter = Descriptor $dir $true
  if (($parentBefore | ConvertTo-Json -Depth 6 -Compress) -ne ($parentAfter | ConvertTo-Json -Depth 6 -Compress)) { throw 'Config parent was modified' }
  $profileAcl = Descriptor $profile $true
  @{ sid = $identity.User.Value; standardUser = $true; before = $before; files = $records; profile = $profileAcl; parent = $parentAfter; checks = $result } | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.json')
} finally {
  foreach ($path in @($legacy, $result.path, $result.port)) { if ($path -and [IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
}

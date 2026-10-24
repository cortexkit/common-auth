$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
function Progress($message) { [Console]::Error.WriteLine("inspector: +$($clock.ElapsedMilliseconds)ms $message"); [Console]::Error.Flush() }
Progress 'start'
# Only Windows PowerShell's built-in modules are needed by this helper or its credentialed child.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
trap {
  $errorObject = $_.Exception
  while ($errorObject.InnerException) { $errorObject = $errorObject.InnerException }
  [Console]::Error.WriteLine((@{ event = 'powershell-error'; type = $errorObject.GetType().FullName; message = $errorObject.Message; hresult = $errorObject.HResult; nativeCode = $errorObject.NativeErrorCode } | ConvertTo-Json -Compress))
  break
}
Progress 'module load begin: Microsoft.PowerShell.Utility'
Import-Module Microsoft.PowerShell.Utility
Progress 'module load done: Microsoft.PowerShell.Utility'
Progress 'request read begin'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Progress $request.action
if ($request.action -eq 'inspect') {
  # JSON uses Utility; ACL and volume inspection must not autoload Storage or query CIM.
  $PSModuleAutoLoadingPreference = 'None'
  Progress 'type load begin: identity, ACL, DriveInfo'
  $null = [Security.Principal.WindowsIdentity], [Security.AccessControl.AccessControlSections], [Security.AccessControl.DirectorySecurity], [Security.AccessControl.FileSecurity], [Security.AccessControl.RawSecurityDescriptor], [IO.DriveInfo]
  Progress 'type load done: identity, ACL, DriveInfo'
  Progress 'identity read begin'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  Progress 'identity read done'
  $objects = @(foreach ($path in $request.paths) {
    Progress "ACL read begin: $path"
    $isDir = [IO.Directory]::Exists($path)
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    if ($isDir) { $security = [Security.AccessControl.DirectorySecurity]::new($path, $sections) }
    else { $security = [Security.AccessControl.FileSecurity]::new($path, $sections) }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
    $aces = @($raw.DiscretionaryAcl | ForEach-Object {
      @{ type = [int]$_.AceType; flags = [int]$_.AceFlags; mask = $_.AccessMask; sid = $_.SecurityIdentifier.Value }
    })
    @{ path = $path; directory = $isDir; owner = $raw.Owner.Value; control = [int]$raw.ControlFlags; aces = $aces }
    Progress "ACL read done: $path"
  })
  Progress 'filesystem read begin: DriveInfo.DriveFormat'
  $filesystem = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($request.paths[0])).DriveFormat
  Progress 'filesystem read done: DriveInfo.DriveFormat'
  Progress 'JSON write begin'
  @{ sid = $sid; objects = $objects; os = [Environment]::OSVersion.ToString(); filesystem = $filesystem } | ConvertTo-Json -Depth 8 -Compress
  Progress 'inspect done'
  exit
}
if ($request.action -eq 'grant') {
  $isDir = [IO.Directory]::Exists($request.path)
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
  if ($isDir) { $acl = [Security.AccessControl.DirectorySecurity]::new($request.path, $sections) }
  else { $acl = [Security.AccessControl.FileSecurity]::new($request.path, $sections) }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  if ($isDir) { [IO.Directory]::SetAccessControl($request.path, $acl) }
  else { [IO.File]::SetAccessControl($request.path, $acl) }
  exit
}
if ($request.action -eq 'users-modify' -or $request.action -eq 'users-read' -or $request.action -eq 'admin-legacy') {
  if ($request.action -eq 'users-modify' -or $request.action -eq 'users-read') {
    $acl = [Security.AccessControl.DirectorySecurity]::new($request.path, [Security.AccessControl.AccessControlSections]::All)
    $rights = if ($request.action -eq 'users-read') { 'ReadAndExecute' } else { 'Modify' }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    [IO.Directory]::SetAccessControl($request.path, $acl)
  } else {
    [IO.File]::WriteAllText($request.path, '{"legacy":true}')
    $acl = [Security.AccessControl.FileSecurity]::new($request.path, [Security.AccessControl.AccessControlSections]::All)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    [IO.File]::SetAccessControl($request.path, $acl)
  }
  exit
}
if ($request.action -ne 'deny' -and $request.action -ne 'config-user') { throw 'Unknown inspector action' }
$name = $env:COMMON_AUTH_PROBE_USER
if (-not $name -or -not $env:COMMON_AUTH_PROBE_PASSWORD -or -not $env:COMMON_AUTH_PROBE_SID) { throw 'Provision and warm the standard probe user before running suites' }
$user = Get-LocalUser -Name $name
if ($user.SID.Value -ne $env:COMMON_AUTH_PROBE_SID) { throw 'Provisioned probe SID mismatch' }
$password = ConvertTo-SecureString $env:COMMON_AUTH_PROBE_PASSWORD -AsPlainText -Force
Progress "reusing warmed standard user: $($user.SID.Value)"
$public = Join-Path $env:PUBLIC ('common-auth-probe-' + [Guid]::NewGuid().ToString('N'))
try {
  Progress 'public control provisioning'
  New-Item -ItemType Directory -Path $public | Out-Null
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  [IO.Directory]::SetAccessControl($public, $acl)
  [IO.File]::WriteAllText((Join-Path $public 'control.txt'), 'public control')
  if ($request.action -eq 'config-user') {
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination (Join-Path $public 'dist') -Recurse
    $modules = Join-Path $public 'node_modules\@cortexkit'
    [IO.Directory]::CreateDirectory($modules) | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo 'node_modules\@cortexkit\private-files') -Destination (Join-Path $modules 'private-files') -Recurse
    Copy-Item -LiteralPath $request.runtime -Destination (Join-Path $public 'runtime.exe')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'standard-config.mjs') -Destination $public
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'standard-config.ps1') -Destination (Join-Path $public 'probe.ps1')
    @{ expectedSid = $user.SID.Value; runtimeName = 'runtime.exe' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $public 'request.json')
  } else {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'second-user.ps1') -Destination (Join-Path $public 'probe.ps1')
    @{ paths = $request.paths; directory = $request.directory; expectedSid = $user.SID.Value } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $public 'request.json')
  }
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Progress 'credentialed child launch'
  $child = Start-Process -FilePath $exe -Credential $credential -LoadUserProfile -WorkingDirectory $public -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $public 'probe.ps1') + '"')) -PassThru -RedirectStandardOutput (Join-Path $public 'stdout.txt') -RedirectStandardError (Join-Path $public 'stderr.txt')
  # Holding the handle before exit makes ExitCode observable for credentialed children.
  $null = $child.Handle
  Progress 'waiting for credentialed child'
  if (-not $child.WaitForExit(30000)) { $child.Kill(); $child.WaitForExit(5000) | Out-Null; throw 'Second-user probe timed out' }
  $child.WaitForExit()
  Progress "credentialed child exit: $($child.ExitCode)"
  $resultExists = [IO.File]::Exists((Join-Path $public 'result.json'))
  if ($child.ExitCode -ne 0 -or -not $resultExists) {
    $diagnostic = @{ exitCode = $child.ExitCode; userCreated = [bool]$user; LoadUserProfile = $true; resultExists = $resultExists; stdout = [IO.File]::ReadAllText((Join-Path $public 'stdout.txt')); stderr = [IO.File]::ReadAllText((Join-Path $public 'stderr.txt')) } | ConvertTo-Json -Compress
    throw ('Second-user probe failed: ' + $diagnostic)
  }
  $result = [IO.File]::ReadAllText((Join-Path $public 'result.json')) | ConvertFrom-Json
  if ($request.action -eq 'deny' -and ($result.sid -ne $user.SID.Value -or -not $result.standardUser -or -not $result.publicRead -or -not $result.directoryDenied -or -not $result.filesDenied)) { throw 'Second-user identity, positive control or denial failed' }
  if ($request.action -eq 'config-user' -and ($result.sid -ne $user.SID.Value -or -not $result.standardUser)) { throw 'Standard config identity failed' }
  $result | ConvertTo-Json -Depth 10 -Compress
} finally {
  Progress 'public control cleanup'
  # The copied runtime's image can stay mapped for a moment after the
  # credentialed process exits (seen on windows-11-arm with Bun 1.3.14), so a
  # sharing violation on removal is retried for a bounded time. Anything still
  # holding it after that is named and the original error is rethrown.
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([IO.Directory]::Exists($public)) {
    try { Remove-Item -LiteralPath $public -Recurse -Force -ErrorAction Stop; break }
    catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        $holders = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($public, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" })
        Progress ("public control still held after 10 s by: " + ($(if ($holders.Count) { $holders -join '; ' } else { 'no running process' })))
        throw
      }
      Start-Sleep -Milliseconds 250
    }
  }
}

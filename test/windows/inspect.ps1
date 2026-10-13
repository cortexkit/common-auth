$ErrorActionPreference = 'Stop'
# Only Windows PowerShell's built-in modules are needed by this helper or its credentialed child.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
function Progress($message) { [Console]::Error.WriteLine("inspector: $message"); [Console]::Error.Flush() }
trap {
  $errorObject = $_.Exception
  while ($errorObject.InnerException) { $errorObject = $errorObject.InnerException }
  [Console]::Error.WriteLine((@{ event = 'powershell-error'; type = $errorObject.GetType().FullName; message = $errorObject.Message; hresult = $errorObject.HResult; nativeCode = $errorObject.NativeErrorCode } | ConvertTo-Json -Compress))
  break
}
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Progress $request.action
if ($request.action -eq 'inspect') {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $objects = @($request.paths | ForEach-Object {
    $path = $_
    $isDir = [IO.Directory]::Exists($path)
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    if ($isDir) { $security = [Security.AccessControl.DirectorySecurity]::new($path, $sections) }
    else { $security = [Security.AccessControl.FileSecurity]::new($path, $sections) }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
    $aces = @($raw.DiscretionaryAcl | ForEach-Object {
      @{ type = [int]$_.AceType; flags = [int]$_.AceFlags; mask = $_.AccessMask; sid = $_.SecurityIdentifier.Value }
    })
    @{ path = $path; directory = $isDir; owner = $raw.Owner.Value; control = [int]$raw.ControlFlags; aces = $aces }
  })
  @{ sid = $sid; objects = $objects; os = [Environment]::OSVersion.ToString(); filesystem = (Get-Volume -DriveLetter ([IO.Path]::GetPathRoot($request.paths[0]).Substring(0,1))).FileSystem } | ConvertTo-Json -Depth 8 -Compress
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
if ($request.action -ne 'deny') { throw 'Unknown inspector action' }
$name = 'ca' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$public = Join-Path $env:PUBLIC ('common-auth-probe-' + [Guid]::NewGuid().ToString('N'))
$user = $null
try {
  Progress 'public control provisioning'
  New-Item -ItemType Directory -Path $public | Out-Null
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  [IO.Directory]::SetAccessControl($public, $acl)
  [IO.File]::WriteAllText((Join-Path $public 'control.txt'), 'public control')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'second-user.ps1') -Destination (Join-Path $public 'probe.ps1')
  $password = ConvertTo-SecureString ('Aa1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $user = New-LocalUser -Name $name -Password $password -PasswordNeverExpires
  Progress "standard user created: $($user.SID.Value)"
  @{ paths = $request.paths; directory = $request.directory; expectedSid = $user.SID.Value } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $public 'request.json')
  Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Progress 'credentialed child launch'
  $child = Start-Process -FilePath $exe -Credential $credential -LoadUserProfile -WorkingDirectory $public -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $public 'probe.ps1') + '"')) -PassThru -RedirectStandardOutput (Join-Path $public 'stdout.txt') -RedirectStandardError (Join-Path $public 'stderr.txt')
  Progress 'waiting for credentialed child'
  if (-not $child.WaitForExit(30000)) { $child.Kill(); $child.WaitForExit(5000) | Out-Null; throw 'Second-user probe timed out' }
  Progress "credentialed child exit: $($child.ExitCode)"
  if ($child.ExitCode -ne 0) { throw ('Second-user probe failed: ' + [IO.File]::ReadAllText((Join-Path $public 'stderr.txt'))) }
  $result = [IO.File]::ReadAllText((Join-Path $public 'result.json')) | ConvertFrom-Json
  if ($result.sid -ne $user.SID.Value -or -not $result.standardUser -or -not $result.publicRead -or -not $result.directoryDenied -or -not $result.filesDenied) { throw 'Second-user identity, positive control or denial failed' }
  $result | ConvertTo-Json -Compress
} finally {
  Progress 'account and public control cleanup'
  if ($user) { Remove-LocalUser -Name $name }
  if ([IO.Directory]::Exists($public)) { Remove-Item -LiteralPath $public -Recurse -Force }
}

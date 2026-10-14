$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$watch = [Diagnostics.Stopwatch]::StartNew()
if (-not $env:GITHUB_OUTPUT) { throw 'Provision the probe account in a workflow step' }
$name = 'ca' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$plain = 'Aa1!' + [Guid]::NewGuid().ToString('N')
Write-Output "::add-mask::$plain"
$password = ConvertTo-SecureString $plain -AsPlainText -Force
$user = New-LocalUser -Name $name -Password $password -PasswordNeverExpires
# Publish only the account actually created, before membership/warmup can fail.
try { [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "user=$name`npassword=$plain`nsid=$($user.SID.Value)`n") }
catch { Remove-LocalUser -SID $user.SID; throw }
Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
Write-Output "Standard user created: $($user.SID.Value); elapsedMs=$($watch.ElapsedMilliseconds)"
$public = Join-Path $env:PUBLIC ('common-auth-warm-' + [Guid]::NewGuid().ToString('N'))
$child = $null
try {
  New-Item -ItemType Directory -Path $public | Out-Null
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  [IO.Directory]::SetAccessControl($public, $acl)
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'warm-user.ps1') -Destination (Join-Path $public 'warm.ps1')
  [IO.File]::WriteAllText((Join-Path $public 'expected-sid.txt'), $user.SID.Value)
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $warmStart = $watch.ElapsedMilliseconds
  Write-Output "Credentialed profile warmup start; elapsedMs=$warmStart"
  $child = Start-Process -FilePath $exe -Credential $credential -LoadUserProfile -WorkingDirectory $public -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $public 'warm.ps1') + '"')) -PassThru -RedirectStandardOutput (Join-Path $public 'stdout.txt') -RedirectStandardError (Join-Path $public 'stderr.txt')
  $null = $child.Handle
  if (-not $child.WaitForExit(150000)) { $child.Kill(); $child.WaitForExit(5000) | Out-Null; throw 'Profile warmup timed out' }
  $child.WaitForExit()
  if ($child.ExitCode -ne 0 -or -not [IO.File]::Exists((Join-Path $public 'ready.txt'))) { throw 'Credentialed profile warmup failed' }
  if ([IO.File]::ReadAllText((Join-Path $public 'ready.txt')).Trim() -ne $user.SID.Value) { throw 'Profile warmup ran as the wrong user' }
  Write-Output "Credentialed profile warmup passed; warmMs=$($watch.ElapsedMilliseconds - $warmStart); totalMs=$($watch.ElapsedMilliseconds)"
} finally {
  if ($child -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit(5000) | Out-Null }
  if ([IO.Directory]::Exists($public)) { Remove-Item -LiteralPath $public -Recurse -Force }
}

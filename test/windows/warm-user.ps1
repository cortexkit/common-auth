$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$expectedSid = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'expected-sid.txt')).Trim()
if ($identity.User.Value -ne $expectedSid) { throw 'Warmup ran as the wrong user' }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Warmup must run as a standard user' }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready.txt'), $identity.User.Value)

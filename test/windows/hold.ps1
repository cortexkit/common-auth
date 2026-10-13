$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$handle = [IO.File]::Open($request.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $request.holdMs
} finally { $handle.Dispose() }

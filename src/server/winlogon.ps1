$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $user = [string]$req.username
  $pass = [string]$req.password
  if (-not $user.Trim() -or -not $pass) { Write-Output "no"; exit 0 }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AimissLogon {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
"@

  # 1330 and 1907: the password matched and Windows wants it changed.
  # 1909: the account is locked, so the password was not judged.
  # 1326: the password did not match.
  function Test-Logon([string]$name, [string]$domain) {
    $token = [IntPtr]::Zero
    $domainArg = if ([string]::IsNullOrEmpty($domain)) { [NullString]::Value } else { $domain }
    $ok = [AimissLogon]::LogonUser($name, $domainArg, $pass, 3, 0, [ref]$token)
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($token -ne [IntPtr]::Zero) { [void][AimissLogon]::CloseHandle($token) }
    if ($ok -or $err -eq 1330 -or $err -eq 1907) { return "ok" }
    if ($err -eq 1909) { return "locked" }
    return "no"
  }

  $name = $user.Trim()
  $domain = "."
  if ($name -match '^([^\\]+)\\(.+)$') {
    $domain = $Matches[1]
    $name = $Matches[2]
  } elseif ($name.Contains("@")) {
    $domain = $null
    $name = $user.Trim()
  }

  function Test-Locked([string]$account) {
    if (-not $account) { return $false }
    try {
      return [bool]([ADSI]"WinNT://./$account,user").IsAccountLocked
    } catch {
      return $false
    }
  }

  $signedIn = [string]$env:USERNAME
  $machine = [string]$env:COMPUTERNAME
  $typed = $user.Trim()
  $typedMachine = $typed -eq $machine -or $typed -eq "$machine\$machine" -or $typed -eq ".\$machine"
  # Reading the lock does not count as another failed sign-in.
  if ((Test-Locked $name) -or ($typedMachine -and (Test-Locked $signedIn))) {
    Write-Output "locked"
    exit 0
  }

  $first = Test-Logon $name $domain
  if ($first -eq "ok") { Write-Output "ok"; exit 0 }

  # The name painted on the machine is not an account. The signed-in account is.
  if ($typedMachine -and $signedIn -and ($signedIn -ne $name)) {
    $second = Test-Logon $signedIn "."
    if ($second -eq "ok") { Write-Output "ok"; exit 0 }
    if ($second -eq "locked") { Write-Output "locked"; exit 0 }
  }
  if ($first -eq "locked") { Write-Output "locked"; exit 0 }
  Write-Output "no"
} catch {
  Write-Output "no"
}

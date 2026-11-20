$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AimissLock {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll")]
  public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("wtsapi32.dll", SetLastError=true)]
  public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int klass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")]
  public static extern void WTSFreeMemory(IntPtr memory);
  public static bool IsLocked() {
    IntPtr desk = OpenInputDesktop(0, false, 0x0001);
    if (desk == IntPtr.Zero) return true;
    CloseDesktop(desk);
    IntPtr buffer;
    int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buffer, out bytes) || buffer == IntPtr.Zero) return false;
    try {
      if (bytes < 20) return false;
      // On this Windows 11 build the flag at offset 16 is 0 while the session is in use and 1 while it is locked.
      return Marshal.ReadInt32(buffer, 16) == 1;
    } finally {
      WTSFreeMemory(buffer);
    }
  }
}
"@

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $locked = "0"
  try { if ([AimissLock]::IsLocked()) { $locked = "1" } } catch { $locked = "0" }
  [Console]::Out.WriteLine($locked)
  [Console]::Out.Flush()
}

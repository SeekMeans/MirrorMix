import { execFile } from "node:child_process";

// The paths go in through the environment, one per line, so nothing in a file name is ever read as a command.
const SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($item in ($env:AIMISS_TRASH -split "\`n")) {
  if (-not $item) { continue }
  if (Test-Path -LiteralPath $item -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($item, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } elseif (Test-Path -LiteralPath $item -PathType Leaf) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($item, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
}
`;

/** Moves files and folders to the Windows Recycle Bin, where they can be restored. */
export function moveToRecycleBin(paths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { env: { ...process.env, AIMISS_TRASH: paths.join("\n") }, windowsHide: true, timeout: 30_000 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve();
      },
    );
  });
}

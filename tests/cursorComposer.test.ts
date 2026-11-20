import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Cursor window matching", () => {
  it.skipIf(process.platform !== "win32")("recognizes the current title button and rejects a different chat sharing its prefix", () => {
    const source = fileURLToPath(new URL("../src/process/cursorComposer.ps1", import.meta.url)).replace(/'/g, "''");
    // Extract only matching functions and supply fake controls. This never queries or changes a real window.
    const script = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName UIAutomationClient
      $tokens = $null; $errors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile('${source}', [ref]$tokens, [ref]$errors)
      if ($errors.Count) { throw 'PowerShell parse failed' }
      foreach ($name in @('Get-ActiveChat', 'Same-Title')) {
        $fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
        Invoke-Expression $fn.Extent.Text
      }
      function Find-ByType($win, $type) { return $script:buttons }
      $script:buttons = @([pscustomobject]@{Current=[pscustomobject]@{Name='Chat title. Two-part tariff optimization'}})
      $win = [pscustomobject]@{}
      $script:legacyTab = $null
      $win | Add-Member ScriptMethod FindFirst {param($scope,$condition) return $script:legacyTab}
      $current = Get-ActiveChat $win
      $script:buttons = @()
      $missing = Get-ActiveChat $win
      $script:tabItem = [pscustomobject]@{Current=[pscustomobject]@{Name='Legacy chat'}}
      $script:tabItem | Add-Member ScriptMethod GetCurrentPattern {param($pattern) return [pscustomobject]@{Current=[pscustomobject]@{IsSelected=$true}}}
      $script:legacyTab = [pscustomobject]@{}
      $script:legacyTab | Add-Member ScriptMethod FindAll {param($scope,$condition) return @($script:tabItem)}
      $legacy = Get-ActiveChat $win
      @{current=$current; missing=$missing; legacy=$legacy; exact=(Same-Title $current 'Two-part tariff optimization'); prefix=(Same-Title $current 'Two-part tariff'); spaced=(Same-Title '  Two-part  tariff optimization ' $current)} | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }));
    expect(result).toEqual({ current: "Two-part tariff optimization", missing: "", legacy: "Legacy chat", exact: true, prefix: false, spaced: true });
  });
});

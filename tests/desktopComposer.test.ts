import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native desktop selectors", () => {
  it.skipIf(process.platform !== "win32")("reads Chinese Claude and Codex controls and requires complete conversation titles", () => {
    const source = fileURLToPath(new URL("../src/process/desktopComposer.ps1", import.meta.url)).replace(/'/g, "''");
    // Parse only isolated functions against fake controls; no desktop is queried or changed.
    const script = `
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
      Add-Type -AssemblyName UIAutomationClient
      $tokens = $null; $errors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile('${source}', [ref]$tokens, [ref]$errors)
      if ($errors.Count) { throw 'PowerShell parse failed' }
      foreach ($name in @('Find-Prompt', 'Get-ActiveTitle', 'Same-Title', 'Has-Draft', 'Find-SessionItem')) {
        $fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
        Invoke-Expression $fn.Extent.Text
      }
      $win = [pscustomobject]@{}
      $win | Add-Member ScriptMethod FindFirst {param($scope,$condition)
        if ($condition.Value -eq $script:promptName) { return [pscustomobject]@{Current=[pscustomobject]@{Name=$condition.Value}} }
        return $null
      }
      $win | Add-Member ScriptMethod FindAll {param($scope,$condition) return $script:docs}
      $Tool = 'claude'; $script:promptName = '提示词'
      $script:docs = @([pscustomobject]@{Current=[pscustomobject]@{Name=''}}, [pscustomobject]@{Current=[pscustomobject]@{Name='中文会话 - Claude Code'}})
      $claude = @{prompt=(Find-Prompt $win).Current.Name; title=(Get-ActiveTitle $win)}
      $Tool = 'codex'; $script:promptName = '和 Codex 一起工作'
      $script:docs = @([pscustomobject]@{Current=[pscustomobject]@{Name='Codex title'}}, [pscustomobject]@{Current=[pscustomobject]@{Name='MirrorMix'}})
      @{claude=$claude; codex=@{prompt=(Find-Prompt $win).Current.Name; title=(Get-ActiveTitle $win)}; exact=(Same-Title ' 中文  会话 ' '中文 会话'); prefix=(Same-Title '中文会话 2' '中文会话'); placeholderDraft=(Has-Draft ('和 Codex 一起工作' + [char]13) '和 Codex 一起工作'); realDraft=(Has-Draft '未发送的内容' '提示词'); emptyDraft=(Has-Draft '' '提示词')} | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true }));
    expect(result).toEqual({ claude: { prompt: "提示词", title: "中文会话" }, codex: { prompt: "和 Codex 一起工作", title: "Codex title" }, exact: true, prefix: false, placeholderDraft: false, realDraft: true, emptyDraft: false });
  });
});

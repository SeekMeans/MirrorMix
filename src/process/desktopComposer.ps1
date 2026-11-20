param([ValidateSet('claude','codex')][string]$Tool = 'claude')
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient
Add-Type -Namespace Native -Name Win -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
[DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", EntryPoint="GetWindowLong")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", EntryPoint="SetWindowLong")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
"@

# Win+L switches the input desktop to the secure one. The Claude window stops updating there, so typing into it
# cannot bring up Send. OpenInputDesktop fails from this session for exactly that case.
function Test-WorkstationLocked {
  $desk = [Native.Win]::OpenInputDesktop(0, $false, 0x0001)
  if ($desk -eq [IntPtr]::Zero) { return $true }
  [void][Native.Win]::CloseDesktop($desk)
  return $false
}

# A minimized window stops updating its page, so text put into the input box never brings up the Send button.
# The window is shown without taking focus for the moment of sending, then put back exactly as it was. While it is
# shown it is made fully transparent and click-through, so nothing pops up on the screen and clicks go past it.
$GWL_EXSTYLE = -20
$WS_EX_LAYERED = 0x80000
$WS_EX_TRANSPARENT = 0x20
$script:savedStyles = @{}

function Show-IfMinimized($win) {
  try {
    $handle = [IntPtr]$win.Current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero -or -not [Native.Win]::IsIconic($handle)) { return $null }
    try {
      $style = [Native.Win]::GetWindowLong($handle, $GWL_EXSTYLE)
      $script:savedStyles[[string]$handle] = $style
      [void][Native.Win]::SetWindowLong($handle, $GWL_EXSTYLE, ($style -bor $WS_EX_LAYERED -bor $WS_EX_TRANSPARENT))
      # 2 = LWA_ALPHA; alpha 0 draws nothing.
      [void][Native.Win]::SetLayeredWindowAttributes($handle, 0, 0, 2)
    } catch { }
    # 4 = show in its last size without activating; a window minimized from maximized comes back maximized.
    [void][Native.Win]::ShowWindow($handle, 4)
    return $handle
  } catch {
    return $null
  }
}

# Gives a window its own look back: the style it had, opaque again.
function Restore-Look($handle) {
  $key = [string]$handle
  if (-not $script:savedStyles.ContainsKey($key)) { return }
  $style = $script:savedStyles[$key]
  $script:savedStyles.Remove($key)
  try {
    [void][Native.Win]::SetWindowLong([IntPtr]$handle, $GWL_EXSTYLE, $style)
    if ($style -band $WS_EX_LAYERED) { [void][Native.Win]::SetLayeredWindowAttributes([IntPtr]$handle, 0, 255, 2) }
  } catch { }
}

# Used only if the page would not bring up its Send button while unseen: the window shows as it used to.
function Reveal-Shown($shown) {
  foreach ($handle in $shown) { Restore-Look $handle }
}

function Restore-Minimized($shown) {
  foreach ($handle in $shown) {
    # 7 = minimize without activating, so whatever the person is typing in keeps the focus.
    try { [void][Native.Win]::ShowWindow([IntPtr]$handle, 7) } catch { }
    # Only once it is minimized again, so it never flashes on the screen.
    Restore-Look $handle
  }
}

# A short record of how sends went, beside the server's own notes of refused sends. Never the message itself.
$script:sendLog = Join-Path $env:USERPROFILE ".mirrormix\desktop-send.log"
function Log-Send([string]$what) {
  try {
    if ((Test-Path $script:sendLog) -and (Get-Item $script:sendLog).Length -gt 200KB) { Remove-Item $script:sendLog -Force }
    $line = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + $Tool + "] " + $what
    Add-Content -Path $script:sendLog -Value $line -Encoding UTF8
  } catch { }
}

# Filling the input box focuses it, and that brings the Claude window to the front. The window the person was in
# before the send gets the focus back, but only while a Claude window this send touched is still the one in front,
# so a window the person switched to themselves is left alone.
$script:frontBefore = [IntPtr]::Zero
$script:touched = @()
function Give-Front {
  $prev = $script:frontBefore
  if ($prev -eq [IntPtr]::Zero) { return }
  try {
    $now = [Native.Win]::GetForegroundWindow()
    if ($now -eq $prev) { return }
    if (-not ($script:touched -contains [string]$now)) { return }
    $me = [Native.Win]::GetCurrentThreadId()
    $owner = [uint32]0
    $their = [Native.Win]::GetWindowThreadProcessId($now, [ref]$owner)
    $attached = $false
    if ($their -ne 0 -and $their -ne $me) { $attached = [Native.Win]::AttachThreadInput($me, $their, $true) }
    try { [void][Native.Win]::SetForegroundWindow($prev) } finally {
      if ($attached) { [void][Native.Win]::AttachThreadInput($me, $their, $false) }
    }
    Log-Send ("focus given back: " + ([Native.Win]::GetForegroundWindow() -eq $prev))
  } catch { }
}

function Emit($ok, $errorName, $text) {
  $payload = @{ id = $script:requestId; ok = $ok; error = $errorName; text = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Decode([string]$value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}

function Find-ClaudeWindows {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window))
  )
  $found = @()
  foreach ($win in $windows) {
    try { $processName = (Get-Process -Id $win.Current.ProcessId -ErrorAction Stop).ProcessName } catch { continue }
    if ($Tool -eq 'claude' -and $processName -ine 'claude') { continue }
    if ($Tool -eq 'codex' -and $processName -notin @('ChatGPT','Codex')) { continue }
    $prompt = Find-Prompt $win
    if ($prompt) { $found += $win }
  }
  return $found
}

function Find-Prompt($win) {
  $names = if ($Tool -eq 'claude') { @('Prompt', '提示词') } else { @('和 Codex 一起工作', 'Work with Codex') }
  foreach ($name in $names) {
    $hit = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)))
    if ($hit) { return $hit }
  }
  return $null
}

function Get-ActiveTitle($win) {
  $docs = $win.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Document))
  )
  foreach ($doc in $docs) {
    $name = $doc.Current.Name
    if ($Tool -eq 'codex' -and $name) { return $name }
    $suffix = " - Claude Code"
    if ($name.EndsWith($suffix) -and $name.Length -gt $suffix.Length) {
      return $name.Substring(0, $name.Length - $suffix.Length)
    }
  }
  return ""
}

function Same-Title([string]$active, [string]$wanted) {
  if (-not $active -or -not $wanted) { return $false }
  return ($active -replace '\s+', ' ').Trim() -eq ($wanted -replace '\s+', ' ').Trim()
}

function Has-Draft([string]$text, [string]$placeholder) {
  return [bool]($text.Trim() -and $text.Trim() -ne $placeholder.Trim())
}

function Find-SessionItem($win, [string]$title) {
  $items = $win.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ListItem))
  )
  foreach ($item in $items) {
    if ($item.Current.Name -eq $title) { return $item }
  }
  return $null
}

# Codex task rows are ListItems, but their only exposed Invoke controls are the Pin and Archive actions. Clicking one
# of those actions does not open the task. Select a safe point on the row itself, away from the actions at its right.
function Click-CodexSession($item) {
  try {
    $clickable = New-Object System.Windows.Point
    if (-not $item.TryGetClickablePoint([ref]$clickable)) { return $false }
    $rect = $item.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { return $false }
    $x = [int][Math]::Round($rect.X + [Math]::Min(80, [Math]::Max(20, $rect.Width / 4)))
    $y = [int][Math]::Round($rect.Y + ($rect.Height / 2))
    $before = New-Object Native.Win+POINT
    [void][Native.Win]::GetCursorPos([ref]$before)
    [void][Native.Win]::SetCursorPos($x, $y)
    [Native.Win]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [Native.Win]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    [void][Native.Win]::SetCursorPos($before.X, $before.Y)
    return $true
  } catch {
    return $false
  }
}

function Select-Session($win, [string]$title) {
  if ($Tool -eq 'codex') {
    $chosen = Find-SessionItem $win $title
    if (-not $chosen) { return $false }
    if (-not (Click-CodexSession $chosen)) { return $false }
    # Codex's task rows expose neither a selected state nor their title as the document name.
    # Give its navigation a moment to render before resolving the composer for this window.
    Start-Sleep -Milliseconds 300
    return $true
  } else {
  $buttons = $win.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button))
  )
  # The sidebar names a session by its title, followed by its state while it has one:
  # "Fix login Running", "Fix login Unread response". The header's "Fix login, rename session" is not a row.
  $chosen = $null
  $withState = $null
  foreach ($button in $buttons) {
    $name = $button.Current.Name
    if (-not $name -or $name.StartsWith("More options") -or $name.StartsWith("New session") -or $name.EndsWith(", rename session")) { continue }
    if ($name -eq $title) { $chosen = $button; break }
    if (-not $withState -and $name.StartsWith("$title ")) {
      $state = $name.Substring($title.Length + 1)
      if ($state -match '^(Running|Unread response|Needs (your )?(input|approval|attention)|Waiting( for .+)?|Awaiting .+|Paused|Stopped|Error|Failed)$') { $withState = $button }
    }
  }
  if (-not $chosen) { $chosen = $withState }
  if (-not $chosen) { return $false }
  $pattern = $chosen.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    if (Same-Title (Get-ActiveTitle $win) $title) { return $true }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Find-Button($win, [string[]]$names) {
  $buttons = $win.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button))
  )
  foreach ($button in $buttons) {
    if ($names -contains $button.Current.Name -and $button.Current.IsEnabled) { return $button }
  }
  return $null
}

# Stay inside this composer: Codex can embed MirrorMix itself in another document.
# A whole-window search could otherwise click the web page's Send button.
function Find-ComposerButton($prompt, [string[]]$names) {
  $scope = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($prompt)
  while ($scope -and $scope.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document) {
    $button = Find-Button $scope $names
    if ($button) { return $button }
    $scope = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($scope)
  }
  return $null
}

$script:streamGroup = $null

function Get-StreamText($win) {
  if ($Tool -eq 'codex') { return "" }
  if ($script:streamGroup) {
    try {
      if ($script:streamGroup.Current.Name -ne "Currently streaming message") { $script:streamGroup = $null }
    } catch {
      $script:streamGroup = $null
    }
  }
  if (-not $script:streamGroup) {
    $script:streamGroup = $win.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "Currently streaming message"))
    )
  }
  $group = $script:streamGroup
  if (-not $group) { return "" }
  $texts = $group.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Text))
  )
  $parts = @()
  foreach ($item in $texts) {
    $name = $item.Current.Name.Trim()
    if (-not $name) { continue }
    if ($name -eq "Claude is responding") { continue }
    if ($name.StartsWith("Ran ")) { continue }
    if ($name.StartsWith("Use the up and down")) { continue }
    $parts += $name
  }
  return ($parts -join "`n").Trim()
}

$shown = @()
$filled = $null
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  try {
    $script:requestId = ""
    $req = $line | ConvertFrom-Json
    if ($req.id) { $script:requestId = [string]$req.id }
    $title = Decode $req.title
    # The app's usage meter is a button named like "Usage: Weekly · all models: 62%, Resets Tue 1:30 AM".
    # Its name shows only the fullest window. The 5-hour window is in the panel the button opens.
    # Read a panel the person already opened too. Only expand a closed panel while locked, since expanding it
    # can bring Claude to the front. Leave an already-open panel exactly as it is.
    if ($req.op -eq "usage") {
      $meter = ""
      $five = $null
      $fiveReset = ""
      foreach ($candidate in @(Find-ClaudeWindows)) {
        $button = $candidate.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button))
        ) | Where-Object { $_.Current.Name -match '^(Usage:|用量[:：])' } | Select-Object -First 1
        if (-not $button) { continue }
        $meter = $button.Current.Name
        if ($req.text -and (Decode $req.text) -eq "panel") {
          $toggle = $null
          try { $toggle = $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern) } catch { }
          $opened = $toggle -and $toggle.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed
          $canOpen = $opened -and (Test-WorkstationLocked)
          if (-not $opened -or $canOpen) {
            try {
              if ($canOpen) { $toggle.Expand() }
              $deadline = [DateTime]::UtcNow.AddSeconds(4)
              $bar = $null
              do {
                # English "5-hour limit", Chinese "5 小时限额".
                $bar = $candidate.FindAll(
                  [System.Windows.Automation.TreeScope]::Descendants,
                  (New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::ProgressBar))) |
                  Where-Object { $_.Current.Name -match '^5[- ]?(hour limit|小时限额)' } | Select-Object -First 1
                if (-not $bar -and $canOpen) { Start-Sleep -Milliseconds 150 }
              } while (-not $bar -and $canOpen -and [DateTime]::UtcNow -lt $deadline)
              if ($bar) {
                try { $five = $bar.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern).Current.Value } catch { }
                # The bar's reset time is the text just before it: "Resets Tue 1:20 AM".
                $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
                $previous = $walker.GetPreviousSibling($bar)
                for ($step = 0; $previous -and $step -lt 3; $step++) {
                  if ($previous.Current.Name.StartsWith("Resets") -or $previous.Current.Name.Contains("重置")) { $fiveReset = $previous.Current.Name; break }
                  $previous = $walker.GetPreviousSibling($previous)
                }
              }
            } finally {
              # Put it back the way it was.
              if ($canOpen) { try { $toggle.Collapse() } catch { } }
            }
          }
        }
        break
      }
      $payload = @{ meter = $meter; fiveHour = $five; fiveHourReset = $fiveReset } | ConvertTo-Json -Compress
      Emit $true "" $payload
      continue
    }
    # A new session in a folder the app already lists: its sidebar has "New session in <folder name>" for each.
    # The page it opens names the full folder ("Folder: E:\Me\AIMiss"), which is checked before anything is typed,
    # since two folders can share a name. The session exists once the first message is sent.
    if ($req.op -eq "create") {
      if ($Tool -ne 'claude') { Emit $false "failed" "only the Claude app creates sessions here"; continue }
      if (Test-WorkstationLocked) { Emit $false "locked" ""; continue }
      $want = (Decode $req.title).Replace('/', '\').TrimEnd('\')
      $text = Decode $req.text
      $leaf = Split-Path -Leaf $want
      $candidates = @(Find-ClaudeWindows)
      if ($candidates.Count -eq 0) { Emit $false "missing" "no Claude window"; continue }
      $why = "the app lists no folder named $leaf"
      $made = $false
      $shown = @()
      foreach ($candidate in $candidates) {
        $was = Show-IfMinimized $candidate
        if ($null -ne $was) { $shown += $was; Start-Sleep -Milliseconds 500 }
        $starts = @($candidate.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          (New-Object System.Windows.Automation.AndCondition(
            (New-Object System.Windows.Automation.PropertyCondition(
              [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
              [System.Windows.Automation.ControlType]::Button)),
            (New-Object System.Windows.Automation.PropertyCondition(
              [System.Windows.Automation.AutomationElement]::NameProperty, "New session in $leaf"))))))
        foreach ($start in $starts) {
          $start.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          $folder = ""
          $deadline = [DateTime]::UtcNow.AddSeconds(4)
          do {
            Start-Sleep -Milliseconds 150
            foreach ($button in $candidate.FindAll(
              [System.Windows.Automation.TreeScope]::Descendants,
              (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Button)))) {
              if ($button.Current.Name.StartsWith("Folder: ")) { $folder = $button.Current.Name.Substring(8).Trim(); break }
            }
          } while (-not $folder -and [DateTime]::UtcNow -lt $deadline)
          if (-not ($folder.Replace('/', '\').TrimEnd('\') -ieq $want)) { $why = "the new session opened in '$folder'"; continue }
          $prompt = Find-Prompt $candidate
          if (-not $prompt) { $why = "no input box on the new session page"; break }
          $value = $prompt.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          if (Has-Draft $value.Current.Value $prompt.Current.Name) { $why = "the new session page already has a draft"; break }
          $value.SetValue($text)
          $filled = $value
          $send = $null
          $deadline = [DateTime]::UtcNow.AddSeconds(6)
          do {
            $send = Find-ComposerButton $prompt @("Send message", "Send", "发送消息", "发送")
            if ($send) { break }
            Start-Sleep -Milliseconds 150
          } while ([DateTime]::UtcNow -lt $deadline)
          if (-not $send) { $why = "no Send button on the new session page"; break }
          $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          $filled = $null
          $made = $true
          break
        }
        if ($made) { break }
      }
      if ($made) { Emit $true "" "" } else { Emit $false "missing" $why }
      continue
    }
    if ($req.op -eq "stream" -or $req.op -eq "send" -or $req.op -eq "stop") {
      if (Test-WorkstationLocked) {
        if ($req.op -eq "stream") { Emit $true "" ""; continue }
        Emit $false "locked" ""; continue
      }
    }
    $windows = @()
    $win = $null
    if ($Tool -ne 'codex' -and $script:matchedWindow -and $script:matchedTitle -eq $title) {
      try {
        if (Same-Title (Get-ActiveTitle $script:matchedWindow) $title) { $win = $script:matchedWindow }
      } catch {
        $script:matchedWindow = $null
      }
    }
    if (-not $win) {
      $windows = @(Find-ClaudeWindows)
      if ($windows.Count -eq 0) { Emit $false "missing" ""; continue }
      if ($Tool -ne 'codex') {
        foreach ($candidate in $windows) {
          if (Same-Title (Get-ActiveTitle $candidate) $title) { $win = $candidate; break }
        }
      }
    }
    if ($win) {
      $script:matchedWindow = $win
      $script:matchedTitle = $title
    }
    if ($req.op -eq "stream") {
      if (-not $win) { Emit $true "" ""; continue }
      Emit $true "" (Get-StreamText $win)
      continue
    }
    if ($req.op -ne "send" -and $req.op -ne "stop") { Emit $false "failed" ""; continue }
    $shown = @()
    $script:frontBefore = [Native.Win]::GetForegroundWindow()
    $script:touched = @()
    # The window already matched to this session, or else every candidate the session might be picked in.
    foreach ($candidate in $(if ($win) { @($win) } else { @($windows) })) {
      if (-not $candidate) { continue }
      try { $script:touched += [string]$candidate.Current.NativeWindowHandle } catch { }
      $was = Show-IfMinimized $candidate
      if ($null -ne $was) { $shown += $was }
    }
    if ($shown.Count -gt 0) { Start-Sleep -Milliseconds 500 }
    if (-not $win) {
      foreach ($candidate in $windows) {
        if (Select-Session $candidate $title) { $win = $candidate; break }
      }
    }
    if (-not $win) { Emit $false "missing" ""; continue }
    $prompt = Find-Prompt $win
    if ($req.op -eq "stop") {
      # The app's own Stop button beside the input box, shown while a reply runs. The box itself is not touched.
      $stopButton = Find-ComposerButton $prompt @("Stop", "Stop response", "Stop generating", "Interrupt", "停止", "停止回复", "停止响应", "停止生成", "中断")
      if (-not $stopButton) { Emit $false "idle" ""; continue }
      $stopButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      if (@($shown).Count -gt 0) {
        Start-Sleep -Milliseconds 400
        Restore-Minimized @($shown)
        $shown = @()
      }
      Emit $true "" ""
      continue
    }
    $value = $prompt.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $text = Decode $req.text
    $draft = $value.Current.Value
    if (Has-Draft $draft $prompt.Current.Name) {
      Emit $false "draft" ("active=" + (Get-ActiveTitle $win) + "; prompt=" + $prompt.Current.Name + "; length=" + $draft.Length)
      continue
    }
    $value.SetValue($text)
    Give-Front
    # Until the click lands, the words are ours to take back out if anything goes wrong.
    $filled = $value
    # While a reply is streaming, or the window is behind others, the page can take a few seconds to show the button.
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    $revealAt = [DateTime]::UtcNow.AddSeconds(3)
    $send = $null
    do {
      $send = Find-ComposerButton $prompt @("Send message", "Send", "发送消息", "发送", "提交", "Queue message", "加入队列")
      if ($send) { break }
      # Still no button while the window is unseen: the page may be waiting to be visible. Show it as before.
      if (@($shown).Count -gt 0 -and $revealAt -and [DateTime]::UtcNow -ge $revealAt) {
        Reveal-Shown @($shown)
        $revealAt = $null
        $deadline = [DateTime]::UtcNow.AddSeconds(4)
      }
      Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $send) {
      # Nothing was sent, so the words are taken back out; they are still in the page that sent them.
      try { $value.SetValue("") } catch { }
      $filled = $null
      if (Find-ComposerButton $prompt @("Stop", "Stop response", "停止", "停止回复", "停止响应")) { Emit $false "busy" ""; continue }
      Emit $false "failed" "the text went into the input box but no Send button appeared"; continue
    }
    $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $filled = $null
    Give-Front
    if (@($shown).Count -gt 0) {
      # Give the page a moment to take the click, then put the window away before answering,
      # so it is back in place even if this helper is stopped right after.
      Start-Sleep -Milliseconds 400
      Restore-Minimized @($shown)
      $shown = @()
    }
    Emit $true "" ""
  } catch {
    Emit $false "failed" ($_.Exception.Message + " at line " + $_.InvocationInfo.ScriptLineNumber)
  } finally {
    # A failure between typing and sending must not leave the words in the box to be sent by hand later.
    if ($filled) { try { $filled.SetValue("") } catch { } }
    $filled = $null
    if (@($shown).Count -gt 0) { Restore-Minimized @($shown) }
    $shown = @()
    # Minimizing the focused window hands the focus to whatever is next, not necessarily the person's window.
    Give-Front
    $script:frontBefore = [IntPtr]::Zero
    $script:touched = @()
  }
}

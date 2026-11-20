$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient
Add-Type -Namespace AimissDesk -Name Input -MemberDefinition @"
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
[DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
[DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int klass, out IntPtr buffer, out int bytes);
[DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
public static bool IsLocked() {
  IntPtr desk = OpenInputDesktop(0, false, 0x0001);
  if (desk == IntPtr.Zero) return true;
  CloseDesktop(desk);
  IntPtr buffer;
  int bytes;
  if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buffer, out bytes) || buffer == IntPtr.Zero) return false;
  try {
    if (bytes < 20) return false;
    return System.Runtime.InteropServices.Marshal.ReadInt32(buffer, 16) == 1;
  } finally {
    WTSFreeMemory(buffer);
  }
}
"@

# While the screen is locked the input desktop is the secure one, and clicks and typing cannot reach Cursor.
function Test-WorkstationLocked {
  return [AimissDesk.Input]::IsLocked()
}

# A minimized Cursor window shows nothing but its title bar to UI Automation: the chats and the prompt only exist
# while it is drawn. On a locked screen it can be drawn again without anyone seeing it; on an unlocked one that would
# pop it up in front of the person, so the caller is told instead and answers some other way.
function Test-Minimized($win) {
  try {
    $state = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState
    return $state -eq [System.Windows.Automation.WindowVisualState]::Minimized
  } catch {
    return $false
  }
}

function Show-Quietly($win) {
  $hwnd = [IntPtr]$win.Current.NativeWindowHandle
  # SW_SHOWNOACTIVATE: drawn again at its last size, without taking focus.
  [void][AimissDesk.Input]::ShowWindow($hwnd, 4)
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    Start-Sleep -Milliseconds 150
    $prompt = $win.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "Prompt"))
    )
    if ($prompt -or (Get-ActiveChat $win)) { return }
    # Drawn, but on the settings page: Select-Chat closes it.
    $settings = $win.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "Close Settings"))
    )
    if ($settings) { return }
  } while ([DateTime]::UtcNow -lt $deadline)
}

function Hide-Again($win) {
  try {
    $hwnd = [IntPtr]$win.Current.NativeWindowHandle
    # SW_SHOWMINNOACTIVE: back to the taskbar, as it was.
    [void][AimissDesk.Input]::ShowWindow($hwnd, 7)
  } catch {}
}

function Emit($ok, $errorName) {
  $payload = @{ ok = $ok; error = $errorName }
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Decode([string]$value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}

function Find-CursorWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  return $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)),
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "Cursor Agents"))))
  )
}

function Same-Title([string]$active, [string]$wanted) {
  if (-not $active -or -not $wanted) { return $false }
  $active = ($active -replace '[\u200B-\u200D\uFEFF]', '' -replace '\s+', ' ').Trim()
  $wanted = ($wanted -replace '[\u200B-\u200D\uFEFF]', '' -replace '\s+', ' ').Trim()
  return $active -eq $wanted
}

function Get-ActiveChat($win) {
  # Current Cursor Agents uses a title button instead of a Chats tab strip.
  foreach ($button in (Find-ByType $win ([System.Windows.Automation.ControlType]::Button))) {
    $name = $button.Current.Name
    if ($name -match '^Chat title\.\s*(.+)$') { return $Matches[1].Trim() }
  }
  $tab = $win.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Tab)),
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "Chats"))))
  )
  if (-not $tab) { return "" }
  $items = $tab.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem))
  )
  foreach ($item in $items) {
    try {
      $selected = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($selected.Current.IsSelected) { return $item.Current.Name }
    } catch {}
  }
  return ""
}

# A sidebar row is the title plus a short time or status. A message preview is longer than that.
function Is-ChatRow([string]$name, [string]$title) {
  if (-not $name -or -not $title) { return $false }
  if ($name -eq $title) { return $true }
  if (-not $name.StartsWith($title)) { return $false }
  $rest = $name.Substring($title.Length).Trim()
  if (-not $rest) { return $true }
  return $rest -match '^(?:\u8fd0\u884c\u4e2d|\d+\s*(?:mo|m|d|h)|(?:\d+\s*)?(?:\u5206\u949f|\u5c0f\u65f6|\u5929)\u524d|\d+\u6708\d+\u65e5)$'
}

function Invoke-Item($item) {
  try {
    $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return
  } catch {}
  $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
}

function Find-ByType($win, $type) {
  return $win.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type))
  )
}

# Cursor's settings page (left open after checking usage, say) covers the chats and the prompt. Its close control is a
# toggle button, which UI Automation can press even on a locked screen, where clicks and keys cannot reach the window.
function Leave-Settings($win) {
  $close = $null
  foreach ($button in (Find-ByType $win ([System.Windows.Automation.ControlType]::Button))) {
    if ($button.Current.Name -eq "Close Settings" -and $button.Current.IsEnabled) { $close = $button; break }
  }
  if (-not $close) { return }
  try {
    $close.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
  } catch {
    try { $close.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { return }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    Start-Sleep -Milliseconds 150
    $prompt = $win.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "Prompt"))
    )
    if ($prompt) { return }
  } while ([DateTime]::UtcNow -lt $deadline)
}

function Select-Chat($win, [string]$title) {
  Leave-Settings $win
  if (Same-Title (Get-ActiveChat $win) $title) { return $true }
  $chosen = $null
  foreach ($button in (Find-ByType $win ([System.Windows.Automation.ControlType]::Button))) {
    if ($button.Current.IsEnabled -and $button.Current.Name -eq $title) { $chosen = $button; break }
  }
  if (-not $chosen) {
    foreach ($item in (Find-ByType $win ([System.Windows.Automation.ControlType]::ListItem))) {
      if ($item.Current.IsEnabled -and (Is-ChatRow $item.Current.Name $title)) { $chosen = $item; break }
    }
  }
  if (-not $chosen) { return $false }
  Invoke-Item $chosen
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    if (Same-Title (Get-ActiveChat $win) $title) { return $true }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Find-Button($win, [string]$name) {
  foreach ($button in (Find-ByType $win ([System.Windows.Automation.ControlType]::Button))) {
    if ($button.Current.Name -eq $name -and $button.Current.IsEnabled) { return $button }
  }
  return $null
}

# The submit control sits next to the prompt. While a reply is running it is "Stop generation" until the
# text lands, then "Queue message". Searching the whole window takes longer than the button takes to rename.
function Find-Submit($prompt) {
  $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($prompt)
  if (-not $parent) { return $null }
  foreach ($label in @("Queue message", "Queue", "Send message")) {
    $buttons = $parent.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button)),
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty, $label))))
    )
    foreach ($button in $buttons) {
      if ($button.Current.IsEnabled) { return $button }
    }
  }
  return $null
}

function Find-Named($root, [string]$name) {
  return $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $name))
  )
}

function Test-InTranscript($element) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $element
  for ($i = 0; $i -lt 14 -and $node; $i++) {
    if ($node.Current.Name -eq "Chat transcript") { return $true }
    $node = $walker.GetParent($node)
  }
  return $false
}

# The same sentence also sits in the transcript. The queue copy is the one outside that pane.
function Find-QueueText($win, [string]$text) {
  $found = $win.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $text))
  )
  foreach ($item in $found) {
    if (-not (Test-InTranscript $item)) { return $item }
  }
  return $null
}

function Find-SendNow($row) {
  foreach ($label in @("Send now", "Send Now", "Interrupt")) {
    $hit = Find-Named $row $label
    if ($hit) { return $hit }
  }
  return $null
}

function Move-Over($element) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.Width -lt 1 -or $rect.Height -lt 1) { return }
  Add-Type -AssemblyName System.Windows.Forms
  $x = [int]($rect.X + [Math]::Min(24, $rect.Width / 2))
  $y = [int]($rect.Y + $rect.Height / 2)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
}

# Clicks the queue row's own Send now. Typing the text again would only add a second queued copy.
function Invoke-SendNow($win, [string]$text) {
  $textEl = Find-QueueText $win $text
  if (-not $textEl) { return $false }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $row = $textEl
  $action = $null
  for ($i = 0; $i -lt 6; $i++) {
    $parent = $walker.GetParent($row)
    if (-not $parent) { break }
    $row = $parent
    $action = Find-SendNow $row
    if ($action) { break }
  }
  if (-not $action) {
    Move-Over $textEl
    Start-Sleep -Milliseconds 250
    $action = Find-SendNow $row
  }
  if (-not $action) { return $false }
  try {
    $action.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  } catch {
    Move-Over $action
    Start-Sleep -Milliseconds 80
    if (-not ("AimissClick" -as [type])) {
      Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public static class AimissClick { [DllImport(`"user32.dll`")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e); }"
    }
    [AimissClick]::mouse_event(2, 0, 0, 0, 0)
    [AimissClick]::mouse_event(4, 0, 0, 0, 0)
  }
  return $true
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  try {
    $req = $line | ConvertFrom-Json
    if ($req.op -ne "send" -and $req.op -ne "send-now") { Emit $false "failed"; continue }
    $win = Find-CursorWindow
    if (-not $win) { Emit $false "missing"; continue }
    $restored = $false
    if (Test-Minimized $win) {
      if (-not (Test-WorkstationLocked)) { Emit $false "minimized"; continue }
      Show-Quietly $win
      $restored = $true
    }
    try {
    $title = Decode $req.title
    if (-not (Select-Chat $win $title)) { Emit $false "missing"; continue }
    if ($req.op -eq "send-now") {
      if (-not (Invoke-SendNow $win (Decode $req.text))) { Emit $false "failed"; continue }
      Emit $true ""
      continue
    }
    $prompt = $win.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "Prompt"))
    )
    if (-not $prompt) { Emit $false "failed"; continue }
    $value = $prompt.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $text = Decode $req.text
    $value.SetValue($text)
    # The prompt is a ProseMirror editor. The button stays "Stop generation" until that editor
    # accepts the text, then it becomes "Queue message" (a reply is running) or "Send message".
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $send = $null
    do {
      Start-Sleep -Milliseconds 200
      $box = $prompt
      try { $null = $box.Current.Name } catch { $box = $null }
      if (-not $box) {
        $box = $win.FindFirst(
          [System.Windows.Automation.TreeScope]::Descendants,
          (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, "Prompt"))
        )
        if ($box) { $prompt = $box }
      }
      if ($box) { $send = Find-Submit $box }
      if ($send) { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $send) { Emit $false "failed"; continue }
    $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    # Give Cursor a moment to take the message before the window goes back down.
    if ($restored) { Start-Sleep -Milliseconds 600 }
    Emit $true ""
    } finally {
      if ($restored) { Hide-Again $win }
    }
  } catch {
    Emit $false "failed"
  }
}

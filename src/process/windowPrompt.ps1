# Questions an AI app's window asks in the conversation: allow a command or an edit, approve a plan, pick an answer.
# Shared by desktopComposer.ps1 (Claude, Codex) and cursorComposer.ps1 (Cursor), which dot-source this file.
#
# A question is recognised by its buttons, not by each app's layout: at least one that says yes (Allow, Approve,
# Run, Accept...) and one that says no (Deny, Reject, Skip...) in the conversation. The card is the smallest part of the
# page holding all of them, and its texts are the question and what it is about.

$script:YesWords = '^(Allow|Always allow|Approve|Accept|Run|Yes|Proceed|Continue|Keep planning|Trust|Allow once|允许|始终允许|总是允许|批准|接受|运行|是|继续|信任)'
$script:NoWords = '^(Deny|Reject|Decline|Don.?t allow|Do not allow|Skip|No\b|拒绝|跳过|否|不允许|不同意)'
$script:SubmitWords = '^(Submit|Submit answers?|Send answers?|Done|提交|提交答案|完成)$'

function Get-ButtonsIn($scope) {
  $all = $scope.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button)))
  $found = @()
  foreach ($button in $all) {
    try {
      $name = $button.Current.Name
      if (-not $name -or $name.Length -gt 80 -or -not $button.Current.IsEnabled -or $button.Current.IsOffscreen) { continue }
      $found += $button
    } catch { }
  }
  return $found
}

function Test-Answer([string]$name) {
  return ($name -match $script:YesWords) -or ($name -match $script:NoWords)
}

# The smallest ancestor of the first answer button that holds every answer button: the question's card.
function Find-Card($answers) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $walker.GetParent($answers[0])
  $names = @($answers | ForEach-Object { $_.Current.Name })
  for ($level = 0; $node -and $level -lt 8; $level++) {
    $inside = @(Get-ButtonsIn $node | Where-Object { $names -contains $_.Current.Name })
    if ($inside.Count -ge $answers.Count) {
      # One more level up when the card is only the row of buttons: the question sits beside that row.
      $texts = @(Get-TextsIn $node @())
      if ($texts.Count -eq 0) { $up = $walker.GetParent($node); if ($up) { return $up } }
      return $node
    }
    $node = $walker.GetParent($node)
  }
  return $null
}

function Get-TextsIn($scope, $skip) {
  $all = $scope.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Text)))
  $texts = @()
  foreach ($item in $all) {
    try {
      $name = $item.Current.Name.Trim()
      if (-not $name -or $skip -contains $name -or $texts -contains $name) { continue }
      $texts += $name
    } catch { }
  }
  return $texts
}

# The question in `scope` (a conversation), or $null: @{ title; detail; buttons = @(names) }.
function Read-WindowPrompt($scope) {
  if (-not $scope) { return $null }
  $buttons = @(Get-ButtonsIn $scope)
  $answers = @($buttons | Where-Object { Test-Answer $_.Current.Name })
  $yes = @($answers | Where-Object { $_.Current.Name -match $script:YesWords })
  $no = @($answers | Where-Object { $_.Current.Name -match $script:NoWords })
  if ($yes.Count -lt 1 -or $no.Count -lt 1) { return $null }
  $card = Find-Card $answers
  if (-not $card) { return $null }
  $names = @(Get-ButtonsIn $card | ForEach-Object { $_.Current.Name } | Where-Object { Test-Answer $_ } | Select-Object -Unique)
  $texts = @(Get-TextsIn $card $names | Select-Object -First 14)
  $title = ($texts | Where-Object { $_ -match '[?？]\s*$' } | Select-Object -First 1)
  if (-not $title) { $title = if ($texts.Count) { $texts[0] } else { "" } }
  $detail = (($texts | Where-Object { $_ -ne $title }) -join "`n")
  if ($detail.Length -gt 1500) { $detail = $detail.Substring(0, 1500) + "…" }
  return @{ title = $title; detail = $detail; buttons = $names }
}

function Invoke-Element($element) {
  try { $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { }
  try { $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return $true } catch { }
  try { $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); return $true } catch { }
  return $false
}

# Picks `label` in the conversation: a button of the question's card, or one of a question's choices (a button, radio
# button, list item or check box named so), then that question's Submit when it has one. True once clicked.
function Answer-WindowPrompt($scope, [string]$label) {
  if (-not $scope -or -not $label) { return $false }
  $types = @(
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::RadioButton,
    [System.Windows.Automation.ControlType]::ListItem,
    [System.Windows.Automation.ControlType]::CheckBox,
    [System.Windows.Automation.ControlType]::MenuItem
  )
  $target = $null
  foreach ($type in $types) {
    $hits = $scope.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $label)))))
    foreach ($hit in $hits) {
      try { if ($hit.Current.IsEnabled -and -not $hit.Current.IsOffscreen) { $target = $hit; break } } catch { }
    }
    if ($target) { break }
  }
  # A choice whose name carries its description too: "Terminal first Full support for…".
  if (-not $target) {
    foreach ($button in (Get-ButtonsIn $scope)) {
      if ($button.Current.Name.StartsWith($label + " ") -or $button.Current.Name.StartsWith($label + "`n")) { $target = $button; break }
    }
  }
  if (-not $target) { return $false }
  if (-not (Invoke-Element $target)) { return $false }
  if (Test-Answer $label) { return $true }
  # A question's choice: its Submit, if the card has one, sends the answer.
  Start-Sleep -Milliseconds 250
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $walker.GetParent($target)
  for ($level = 0; $node -and $level -lt 6; $level++) {
    $submit = Get-ButtonsIn $node | Where-Object { $_.Current.Name -match $script:SubmitWords } | Select-Object -First 1
    if ($submit) { [void](Invoke-Element $submit); break }
    $node = $walker.GetParent($node)
  }
  return $true
}

# For working out a new app version's layout: the conversation's buttons and texts, written to
# ~/.mirrormix/window-prompt-dump.txt. Names only, as UI Automation reports them; nothing is clicked.
function Dump-WindowPrompt($scope, [string]$tool) {
  $file = Join-Path $env:USERPROFILE ".mirrormix\window-prompt-dump.txt"
  $lines = @("=== " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + " [" + $tool + "]")
  if (-not $scope) { $lines += "(no conversation found)" } else {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    # Depth first, so the indentation reads as the tree it is.
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($scope, 0))
    $count = 0
    while ($stack.Count -gt 0 -and $count -lt 1500) {
      $pair = $stack.Pop()
      $node = $pair[0]; $depth = $pair[1]
      try {
        $type = $node.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        $name = $node.Current.Name
        if ($name.Length -gt 120) { $name = $name.Substring(0, 120) + "…" }
        if ($name -or $type -in @('Button','RadioButton','ListItem','CheckBox','Group')) { $lines += ("  " * [Math]::Min($depth, 30)) + $type + ": " + $name; $count++ }
      } catch { continue }
      $children = @()
      $child = $walker.GetFirstChild($node)
      while ($child) { $children += $child; $child = $walker.GetNextSibling($child) }
      for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push(@($children[$i], $depth + 1)) }
    }
  }
  try { Add-Content -Path $file -Value ($lines -join "`r`n") -Encoding UTF8 } catch { }
}

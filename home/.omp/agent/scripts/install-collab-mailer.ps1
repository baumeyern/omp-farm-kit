$ErrorActionPreference = 'Stop'
$taskName = 'OMP Collab Link Mailer'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$node = (Get-Command node.exe).Source
$script = Join-Path $PSScriptRoot 'collab-mailer.mjs'
# Own Node directly: wrapping it in PowerShell leaves an orphan on Stop-ScheduledTask.
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Email private omp Collab control links to the Gmail account owner; links never stored locally.' -Force | Select-Object TaskName, State

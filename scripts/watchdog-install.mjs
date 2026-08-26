/**
 * Register (or remove) the Forge watchdog as a Windows logon task.
 *
 *   npm run watchdog:install     register "Forge Watchdog (<profile>)" and start it now
 *   npm run watchdog:uninstall   stop it and remove the task
 *
 * A scheduled task rather than the Startup folder because the defaults there
 * are wrong for a guardian process — the Startup folder is fine, but a task can
 * be told to never time out (schtasks' default is to kill anything after 72h),
 * to run on battery, to survive idle, and to be restarted by Windows if it dies.
 * It runs as the logged-on user, interactively, so the Forge it launches gets a
 * desktop and a window like any other app.
 *
 * Task name carries the profile so the stable checkout and Forge Dev can each
 * have one without stepping on each other.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LAUNCHER = join(ROOT, 'Start Forge Watchdog.vbs')

function profile() {
  try {
    return readFileSync(join(ROOT, '.forge-profile'), 'utf8').trim() || 'Forge'
  } catch {
    return 'Forge'
  }
}
const TASK = `Forge Watchdog (${profile()})`

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit']
  })
}

const uninstall = process.argv.includes('--uninstall')

if (uninstall) {
  ps(`
    $t = Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue
    if ($t) {
      Stop-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false
      Write-Output 'removed'
    } else { Write-Output 'not installed' }
  `)
  // The task stopping does not kill the node process the vbs started.
  ps(`
    Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -and $_.CommandLine.ToLower().Contains('watchdog') -and $_.CommandLine.ToLower().Contains('${ROOT.toLowerCase().replace(/'/g, "''")}')
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `)
  console.log(`${TASK}: uninstalled`)
} else {
  const out = ps(`
    $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${LAUNCHER}"' -WorkingDirectory '${ROOT}'
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $trigger.Delay = 'PT20S'
    $settings = New-ScheduledTaskSettingsSet \`
      -ExecutionTimeLimit ([TimeSpan]::Zero) \`
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
      -DontStopOnIdleEnd -StartWhenAvailable \`
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) \`
      -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName '${TASK}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName '${TASK}'
    (Get-ScheduledTask -TaskName '${TASK}').State
  `)
  console.log(`${TASK}: installed, state ${out.trim()}`)
  console.log(`launcher: ${LAUNCHER}`)
}

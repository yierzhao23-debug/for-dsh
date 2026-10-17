# dsh-context-alert notification backend (Windows, no dependencies).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File alert.ps1
#
# Reads base64(UTF-8 JSON) from the environment variable DSH_CTX_ALERT_PAYLOAD:
#   {"mode":"toast|speak|sound|both","title":"...","message":"..."}
#
# Environment (rather than argv) carries the payload so Chinese text never has
# to survive command-line quoting or a code-page round trip.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes a BOM-less .ps1 using
# the system ANSI code page, so non-ASCII source would mojibake. All user-facing
# text arrives through the base64 payload instead.
param()

$ErrorActionPreference = 'Stop'

$payloadB64 = $env:DSH_CTX_ALERT_PAYLOAD
if (-not $payloadB64) { [Console]::Error.WriteLine('DSH_CTX_ALERT_PAYLOAD is not set'); exit 1 }

$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadB64))
$cfg = $json | ConvertFrom-Json
$mode = [string]$cfg.mode
if (-not $mode) { $mode = 'toast' }
$title = [string]$cfg.title
if (-not $title) { $title = 'dsh context alert' }
$message = [string]$cfg.message
if ($mode -ne 'probe' -and -not $message) { [Console]::Error.WriteLine('message is empty'); exit 1 }

# --- audio capability probe ---------------------------------------------
# On a machine with no render endpoint, SAPI reports the thoroughly misleading
# "no voice installed or none available with the current security setting", and
# a balloon-only notification is the honest outcome. Ask winmm directly so the
# diagnostic says what is actually wrong. -1 means "could not tell".
$renderDevices = -1
try {
    if (-not ('CtxAlertAudio' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class CtxAlertAudio {
    [DllImport("winmm.dll")] public static extern int waveOutGetNumDevs();
}
'@ -ErrorAction Stop
    }
    $renderDevices = [CtxAlertAudio]::waveOutGetNumDevs()
} catch {
    $renderDevices = -1
}
$canPlayAudio = $renderDevices -ne 0

if ($mode -eq 'probe') {
    Write-Output "render-devices=$renderDevices"
    exit 0
}

# --- sound ---------------------------------------------------------------
# Look for a custom effect in this plugin's OWN sound directory --
# <DSH_CTX_ALERT_HOME, default ~/.dsh/context-alert>/sounds/<name>.wav -- and
# fall back to the system exclamation sound when it is absent. Own directory
# only: no other plugin's files are ever read, so nothing else has to be
# installed for sound to work, and moving that plugin cannot break this one.
if ($mode -in @('sound', 'both')) {
    if (-not $canPlayAudio) {
        Write-Warning "no audio render device (waveOutGetNumDevs=$renderDevices); sound skipped"
    } else {
        $effect = $env:DSH_CTX_ALERT_SOUND
        if (-not $effect) { $effect = 'explode' }
        $alertHome = $env:DSH_CTX_ALERT_HOME
        if (-not $alertHome) { $alertHome = Join-Path $env:USERPROFILE '.dsh\context-alert' }
        $wav = Join-Path $alertHome ('sounds\' + $effect + '.wav')
        try {
            if (Test-Path -LiteralPath $wav) {
                $player = New-Object System.Media.SoundPlayer($wav)
                $player.PlaySync()
            } else {
                [System.Media.SystemSounds]::Exclamation.Play() | Out-Null
                Start-Sleep -Milliseconds 300
            }
        } catch {
            Write-Warning "sound failed: $_"
        }
    }
}

# --- speech --------------------------------------------------------------
# Offline SAPI, Chinese voice preferred. Synchronous so the caller's process
# lifetime covers the whole utterance.
if ($mode -in @('speak', 'both')) {
    if (-not $canPlayAudio) {
        Write-Warning "no audio render device (waveOutGetNumDevs=$renderDevices); speech skipped"
    } else {
        try {
            Add-Type -AssemblyName System.Speech -ErrorAction Stop
            $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
            $zh = $synth.GetInstalledVoices() |
                Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh*' } |
                Select-Object -First 1
            if ($zh) { $synth.SelectVoice($zh.VoiceInfo.Name) }
            $synth.Volume = 100
            $synth.Rate = 0
            $synth.Speak($message)
            $synth.Dispose()
        } catch {
            # System.Speech can still fail on a machine whose audio stack is
            # present but unhelpful; fall back to COM SAPI before giving up.
            try {
                $com = New-Object -ComObject SAPI.SpVoice
                $null = $com.Speak($message, 0)
            } catch {
                Write-Warning "speech failed (System.Speech then SAPI COM): $_"
            }
        }
    }
}

# --- desktop toast -------------------------------------------------------
# NotifyIcon balloon: no extra module needed on any supported Windows.
if ($mode -in @('toast', 'both')) {
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Information
        $n.BalloonTipTitle = $title
        $n.BalloonTipText = $message
        $n.Visible = $true
        $n.ShowBalloonTip(10000)
        Start-Sleep -Seconds 4   # keep the process alive or the balloon vanishes
        $n.Dispose()
    } catch {
        Write-Warning "toast failed: $_"
    }
}

Write-Output "context-alert: $mode ok"

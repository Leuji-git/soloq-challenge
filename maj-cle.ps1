# =====================================================================
#  maj-cle.ps1 — pousser la nouvelle clé Riot dans Supabase
#
#  Ce que ça fait, en une commande :
#    1. lit la clé dans ton presse-papier (ou en argument) ;
#    2. vérifie sa forme avant d'envoyer quoi que ce soit ;
#    3. la pose dans le secret RIOT_API_KEY du projet ;
#    4. déclenche un relevé et te dit s'il est passé.
#
#  Ce que ça ne fait PAS, et ne fera pas : aller chercher la clé sur le
#  portail Riot. Ça demanderait d'y entrer ton mot de passe et de
#  franchir leur protection anti-robot — contraire à leurs conditions,
#  et un bon moyen de perdre ton compte. Ce clic-là reste à toi.
#
#  USAGE
#    1. Sur developer.riotgames.com : « Regenerate API Key », puis copie
#       la clé affichée (Ctrl+C).
#    2. Ici :   .\maj-cle.ps1
#
#  PREMIÈRE FOIS — le jeton Supabase
#    Crée un jeton personnel sur https://supabase.com/dashboard/account/tokens
#    puis enregistre-le, UNE SEULE FOIS, hors du dépôt :
#
#      "sbp_xxxxxxxx" | Set-Content "$env:USERPROFILE\.soloq-supabase-token"
#
#    Ce jeton donne un contrôle complet sur tes projets Supabase. Il est
#    rangé dans ton dossier utilisateur, jamais dans le dépôt, et ce
#    script ne l'affiche nulle part.
# =====================================================================

param([string]$Cle)

$ErrorActionPreference = "Stop"
$ref = "krdohsbydwvuyoegbsub"
$fichierJeton = Join-Path $env:USERPROFILE ".soloq-supabase-token"

# ------------------------------------------------------------------ cle
if ([string]::IsNullOrWhiteSpace($Cle)) { $Cle = Get-Clipboard }
if ($null -eq $Cle) { $Cle = "" }
$Cle = $Cle.Trim()

# On verifie AVANT d'envoyer : poser une cle abimee casserait le suivi
# pour tout le monde, et le diagnostic viendrait cinq minutes plus tard.
if ($Cle -notmatch '^RGAPI-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  Write-Host "Ce n'est pas une cle Riot valide." -ForegroundColor Red
  Write-Host "  longueur lue : $($Cle.Length)  (une cle en fait 42)"
  Write-Host "  attendu      : RGAPI- suivi d'un UUID"
  Write-Host ""
  Write-Host "Copie la cle depuis developer.riotgames.com, puis relance."
  exit 1
}

Write-Host "Cle valide ($($Cle.Length) caracteres)." -ForegroundColor Cyan

# ---------------------------------------------------------------- jeton
if (-not (Test-Path $fichierJeton)) {
  Write-Host "Jeton Supabase introuvable." -ForegroundColor Red
  Write-Host ""
  Write-Host "Cree-le sur https://supabase.com/dashboard/account/tokens puis :"
  Write-Host "  `"sbp_ton_jeton`" | Set-Content `"$fichierJeton`""
  exit 1
}
$jeton = (Get-Content $fichierJeton -Raw).Trim()

# -------------------------------------------------------------- envoi
Write-Host "Envoi vers Supabase..." -ForegroundColor Cyan
$corps = ConvertTo-Json @(@{ name = "RIOT_API_KEY"; value = $Cle })
try {
  Invoke-RestMethod -Method Post `
    -Uri "https://api.supabase.com/v1/projects/$ref/secrets" `
    -Headers @{ Authorization = "Bearer $jeton"; "Content-Type" = "application/json" } `
    -Body $corps | Out-Null
} catch {
  Write-Host "Supabase a refuse l'envoi." -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)"
  Write-Host ""
  Write-Host "Si c'est un 401 : le jeton de $fichierJeton est expire ou revoque."
  exit 1
}
Write-Host "Secret RIOT_API_KEY mis a jour." -ForegroundColor Green

# ------------------------------------------------------- verification
# Le secret met quelques secondes a atteindre la fonction deja chargee.
Write-Host "Attente de la propagation, puis releve de verification..." -ForegroundColor Cyan
Start-Sleep -Seconds 12

$config = Get-Content (Join-Path $PSScriptRoot "config.js") -Raw
$url = [regex]::Match($config, 'SUPABASE_URL\s*=\s*"([^"]+)"').Groups[1].Value
$pub = [regex]::Match($config, 'SUPABASE_ANON_KEY\s*=\s*"([^"]+)"').Groups[1].Value

try {
  $r = Invoke-RestMethod -Method Post -Uri "$url/functions/v1/riot" `
    -Headers @{ apikey = $pub; Authorization = "Bearer $pub"; "Content-Type" = "application/json" } `
    -Body '{"action":"sync"}'
} catch {
  Write-Host "Le releve n'a pas repondu : $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Reessaie dans une minute depuis la console admin."
  exit 0
}

if ($r.skipped) {
  Write-Host "Un releve venait d'avoir lieu. Reclique sur Actualiser dans 30 s." -ForegroundColor Yellow
} elseif ($r.errors -and $r.errors.Count -gt 0) {
  Write-Host "Le releve a tourne mais signale :" -ForegroundColor Yellow
  $r.errors | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host ""
  Write-Host "Tout est reparti." -ForegroundColor Green
  Write-Host "  $($r.players) joueurs releves, $($r.games) partie(s), $($r.gold) or distribue."
}

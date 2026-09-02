<powershell>
# Minimal userdata bootstrap for a TaskVantage DC. Rendered by terraform
# templatefile() — contains NO secrets; passwords come from SSM at runtime and
# the full setup script comes from S3 (userdata has a 16KB limit).
$ErrorActionPreference = "Continue"

$LogDir = "C:\Terraform"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LogFile = "$LogDir\bootstrap.log"

function Write-Log {
    param([string]$Message)
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "$Timestamp - $Message"
}

Write-Log "===== TaskVantage AD bootstrap started ====="

Import-Module AWSPowerShell.NetCore -ErrorAction SilentlyContinue
if (-not (Get-Module AWSPowerShell.NetCore)) {
    Import-Module AWSPowerShell -ErrorAction SilentlyContinue
}
Set-DefaultAWSRegion -Region "${aws_region}"

$StatusParam = "/taskvantage/${spoke_org_name}/setup-phase"
function Set-Phase {
    param([string]$Phase)
    try {
        Write-SSMParameter -Name $StatusParam -Value $Phase -Type String -Overwrite $true | Out-Null
        Write-Log "phase -> $Phase"
    } catch {
        Write-Log "WARN: could not write phase '$Phase': $_"
    }
}

# Everything ad-setup.ps1 needs to know about this spoke; the script itself is
# static (staged once in S3), so per-spoke values travel via this file + SSM.
$Config = @{
    spoke        = "${spoke_org_name}"
    region       = "${aws_region}"
    bucket       = "${s3_bucket}"
    prefix       = "${s3_prefix}"
    computerName = "${computer_name}"
    domainName   = "${ad_domain_name}"
    netbiosName  = "${ad_netbios_name}"
    statusParam  = $StatusParam
}
$Config | ConvertTo-Json | Set-Content -Path "$LogDir\config.json" -Encoding UTF8
Write-Log "config.json written"

try {
    Write-Log "Setting Administrator password from SSM..."
    $AdminPw = (Get-SSMParameterValue -Name "/taskvantage/${spoke_org_name}/admin-password" -WithDecryption $true).Parameters[0].Value
    $Admin = [ADSI]"WinNT://./Administrator,user"
    $Admin.SetPassword($AdminPw)
    Write-Log "Administrator password set"
} catch {
    Write-Log "ERROR setting password: $_"
    Set-Phase "ERROR:bootstrap:set-password"
}

try {
    Write-Log "Downloading setup artifacts from S3..."
    Read-S3Object -BucketName "${s3_bucket}" -Key "${s3_prefix}/ad-setup.ps1" -File "$LogDir\ad-setup.ps1" | Out-Null
    Read-S3Object -BucketName "${s3_bucket}" -Key "${s3_prefix}/ou-structure.json" -File "$LogDir\ou-structure.json" | Out-Null
} catch {
    Write-Log "ERROR downloading artifacts: $_"
    Set-Phase "ERROR:bootstrap:s3-download"
}

if (Test-Path "$LogDir\ad-setup.ps1") {
    Write-Log "Running ad-setup.ps1 -Phase boot1"
    & "$LogDir\ad-setup.ps1" -Phase boot1
} else {
    Write-Log "ERROR: ad-setup.ps1 missing"
    Set-Phase "ERROR:bootstrap:missing-script"
}

Write-Log "===== Bootstrap complete ====="
</powershell>

# ==============================================================================
# TaskVantage AD domain controller setup — staged in S3, downloaded and run by
# the userdata bootstrap (ad-bootstrap.ps1). STATIC script: all per-spoke values
# come from C:\Terraform\config.json and SSM parameters, never from templating.
#
# Phase-driven across three boots, via self-managed scheduled tasks:
#   boot1    (userdata)          rename computer, install AD DS, register tasks
#   promote  (startup task)      Install-ADDSForest (machine reboots itself)
#   populate (startup task +5m)  schema + OUs + groups + users + agent staging
#
# Every phase writes its progress to the SSM parameter in config.statusParam —
# that is the completion signal the portal (src/directory.mjs) watches.
# 'populate' is idempotent and safe to re-run for repair:
#   aws ssm send-command --document-name AWS-RunPowerShellScript \
#     --parameters commands='C:\Terraform\ad-setup.ps1 -Phase populate' ...
# ==============================================================================

param(
    [ValidateSet("boot1", "promote", "populate")]
    [string]$Phase = "populate"
)

$ErrorActionPreference = "Continue"
$LogDir = "C:\Terraform"
$LogFile = "$LogDir\bootstrap.log"
$ScriptPath = "$LogDir\ad-setup.ps1"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-Log {
    param([string]$Message)
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "$Timestamp [$Phase] - $Message"
    Write-Host "$Timestamp [$Phase] - $Message"
}

$Config = Get-Content "$LogDir\config.json" -Raw | ConvertFrom-Json

Import-Module AWSPowerShell.NetCore -ErrorAction SilentlyContinue
if (-not (Get-Module AWSPowerShell.NetCore)) {
    Import-Module AWSPowerShell -ErrorAction SilentlyContinue
}
Set-DefaultAWSRegion -Region $Config.region

function Set-TVPhase {
    param([string]$Value)
    try {
        Write-SSMParameter -Name $Config.statusParam -Value $Value -Type String -Overwrite $true | Out-Null
        Write-Log "phase -> $Value"
    } catch {
        Write-Log "WARN: could not write phase '$Value': $_"
    }
}

function Get-TVSecret {
    param([string]$Name)
    (Get-SSMParameterValue -Name "/taskvantage/$($Config.spoke)/$Name" -WithDecryption $true).Parameters[0].Value
}

function Test-IsDomainController {
    (Get-CimInstance Win32_ComputerSystem).DomainRole -ge 4
}

Write-Log "===== ad-setup starting (domain $($Config.domainName)) ====="

# ==============================================================================
# PHASE boot1 — first boot, run from userdata
# ==============================================================================
if ($Phase -eq "boot1") {
    try {
        Write-Log "Renaming computer to $($Config.computerName)..."
        Rename-Computer -NewName $Config.computerName -Force -ErrorAction Stop
        Write-Log "Computer renamed"
    } catch {
        Write-Log "ERROR renaming computer: $_"
    }

    try {
        Write-Log "Installing AD-Domain-Services role..."
        Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -ErrorAction Stop | Out-Null
        Write-Log "AD-Domain-Services installed"
    } catch {
        Write-Log "ERROR installing AD-Domain-Services: $_"
        Set-TVPhase "ERROR:boot1:adds-install"
        exit 1
    }

    $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

    $PromoteAction = New-ScheduledTaskAction -Execute "PowerShell.exe" `
        -Argument "-ExecutionPolicy Bypass -File $ScriptPath -Phase promote"
    Register-ScheduledTask -TaskName "PromoteDomainController" -Action $PromoteAction `
        -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $Principal -Settings $Settings -Force | Out-Null

    $PopulateTrigger = New-ScheduledTaskTrigger -AtStartup
    $PopulateTrigger.Delay = "PT5M"
    $PopulateAction = New-ScheduledTaskAction -Execute "PowerShell.exe" `
        -Argument "-ExecutionPolicy Bypass -File $ScriptPath -Phase populate"
    Register-ScheduledTask -TaskName "PostPromotionConfig" -Action $PopulateAction `
        -Trigger $PopulateTrigger -Principal $Principal -Settings $Settings -Force | Out-Null

    Write-Log "Scheduled tasks registered; rebooting in 30s"
    Set-TVPhase "ADDS_INSTALLED"
    shutdown /r /t 30
    exit 0
}

# ==============================================================================
# PHASE promote — second boot (startup task)
# ==============================================================================
if ($Phase -eq "promote") {
    if (Test-IsDomainController) {
        # Post-promotion boot: our work is done, retire this task.
        Write-Log "Already a domain controller — unregistering promote task"
        Unregister-ScheduledTask -TaskName "PromoteDomainController" -Confirm:$false -ErrorAction SilentlyContinue
        exit 0
    }

    try {
        Write-Log "Promoting to domain controller for $($Config.domainName)..."
        $SafeModePassword = ConvertTo-SecureString (Get-TVSecret "safe-mode-password") -AsPlainText -Force
        Set-TVPhase "PROMOTION_STARTED"

        Install-ADDSForest `
            -DomainName $Config.domainName `
            -DomainNetbiosName $Config.netbiosName `
            -SafeModeAdministratorPassword $SafeModePassword `
            -InstallDns `
            -Force `
            -ErrorAction Stop

        Write-Log "Promotion initiated (machine will reboot)"
    } catch {
        Write-Log "ERROR during promotion: $_"
        Set-TVPhase "ERROR:promote:$($_.ToString().Substring(0, [Math]::Min(120, $_.ToString().Length)))"
    }
    exit 0
}

# ==============================================================================
# PHASE populate — third boot (startup task, 5-min delay). Idempotent.
# ==============================================================================

if (-not (Test-IsDomainController)) {
    Write-Log "Not a domain controller yet — populate will retry next boot"
    exit 0
}

# AD web services can lag the boot; retry until the module answers.
$Ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        Import-Module ActiveDirectory -ErrorAction Stop
        Get-ADDomain -ErrorAction Stop | Out-Null
        $Ready = $true
        break
    } catch {
        Write-Log "AD not ready yet (attempt $($i + 1)); sleeping 30s"
        Start-Sleep -Seconds 30
    }
}
if (-not $Ready) {
    Write-Log "ERROR: AD services never became ready"
    Set-TVPhase "ERROR:populate:ad-not-ready"
    exit 1
}

$DomainDN = (Get-ADDomain).DistinguishedName
$SchemaDN = (Get-ADRootDSE).schemaNamingContext
$ConfigDN = (Get-ADRootDSE).configurationNamingContext

# ------------------------------------------------------------------------------
# 1. TaskVantage schema attributes (see docs/taskvantage-mapping.md)
# ------------------------------------------------------------------------------
Write-Log "Extending schema with TaskVantage attributes..."
$TVOIDBase = "1.2.840.113556.1.8000.2554.31284.19867.42055.27913.58120.4816325.9203716"

$SchemaAttributes = @(
    @{ Name = "tv-Cost-Center"; LDAPName = "tvCostCenter"; OID = "$TVOIDBase.1.2.2.1"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Cost Center Code" },
    @{ Name = "tv-Employee-Status"; LDAPName = "tvEmployeeStatus"; OID = "$TVOIDBase.1.2.2.2"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Employee Status" },
    @{ Name = "tv-Job-Number"; LDAPName = "tvJobNumber"; OID = "$TVOIDBase.1.2.2.3"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Job Number" },
    @{ Name = "tv-Local-Market-Employee-ID"; LDAPName = "tvLocalMarketEmployeeID"; OID = "$TVOIDBase.1.2.2.4"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Local Market Employee ID" },
    @{ Name = "tv-Manager-Number"; LDAPName = "tvManagerNumber"; OID = "$TVOIDBase.1.2.2.5"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Manager Number" },
    @{ Name = "tv-Source-System"; LDAPName = "tvSourceSystem"; OID = "$TVOIDBase.1.2.2.6"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Source System" },
    @{ Name = "tv-IDM-Portal-Managed"; LDAPName = "tvIDMPortalManaged"; OID = "$TVOIDBase.1.2.2.9"; Syntax = "2.5.5.8"; OMSyntax = 1; SingleValued = $true; Description = "IDM Portal Managed Flag" },
    @{ Name = "tv-Immutable-ID"; LDAPName = "tvImmutableID"; OID = "$TVOIDBase.1.2.2.41"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Immutable ID" },
    @{ Name = "tv-Profile-Last-Changed"; LDAPName = "tvProfileLastChanged"; OID = "$TVOIDBase.1.2.2.45"; Syntax = "2.5.5.11"; OMSyntax = 24; SingleValued = $true; Description = "Profile Last Changed Date" },
    @{ Name = "tv-Local-Market"; LDAPName = "tvLocalMarket"; OID = "$TVOIDBase.1.2.2.46"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Local Market" },
    @{ Name = "tv-Directory-Sync"; LDAPName = "tvDirectorySync"; OID = "$TVOIDBase.1.2.2.47"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $false; Description = "Directory Sync Targets" },
    @{ Name = "tv-Associate-Number-As-Integer"; LDAPName = "tvAssociateNumberAsInteger"; OID = "$TVOIDBase.1.2.2.49"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Associate Number as Integer" },
    @{ Name = "tv-Immutable-UPN"; LDAPName = "tvImmutableUPN"; OID = "$TVOIDBase.1.2.2.59"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Immutable UPN" },
    @{ Name = "tv-On-FieldNet"; LDAPName = "tvOnFieldNet"; OID = "$TVOIDBase.1.2.2.60"; Syntax = "2.5.5.8"; OMSyntax = 1; SingleValued = $true; Description = "On FieldNet Flag" },
    @{ Name = "tv-Company-Code"; LDAPName = "tvCompanyCode"; OID = "$TVOIDBase.1.2.2.61"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Company Code" },
    @{ Name = "tv-Org-Short-Name"; LDAPName = "tvOrgShortName"; OID = "$TVOIDBase.1.2.2.62"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Organization Short Name" },
    @{ Name = "tv-Org-Unit"; LDAPName = "tvOrgUnit"; OID = "$TVOIDBase.1.2.2.63"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Organization Unit" },
    @{ Name = "tv-Org-Area-ID"; LDAPName = "tvOrgAreaID"; OID = "$TVOIDBase.1.2.2.64"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Organization Area ID" },
    @{ Name = "tv-Org-Division-ID"; LDAPName = "tvOrgDivisionID"; OID = "$TVOIDBase.1.2.2.65"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Organization Division ID" },
    @{ Name = "tv-Org-Region-ID"; LDAPName = "tvOrgRegionID"; OID = "$TVOIDBase.1.2.2.66"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Organization Region ID" },
    @{ Name = "tv-Org-Site-ID"; LDAPName = "tvOrgSiteID"; OID = "$TVOIDBase.1.2.2.67"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Organization Site ID" },
    @{ Name = "tv-Org-Type"; LDAPName = "tvOrgType"; OID = "$TVOIDBase.1.2.2.68"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Organization Type" },
    @{ Name = "tv-Manager-Immutable-ID"; LDAPName = "tvManagerImmutableID"; OID = "$TVOIDBase.1.2.2.69"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Manager Immutable ID" },
    @{ Name = "tv-Middle-Name-Alt"; LDAPName = "tvMiddleNameAlt"; OID = "$TVOIDBase.1.2.2.70"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Middle Name (Alternate)" },
    @{ Name = "tv-Sn-Alt"; LDAPName = "tvSnAlt"; OID = "$TVOIDBase.1.2.2.71"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Surname (Alternate)" },
    @{ Name = "tv-Known-As-Alt"; LDAPName = "tvKnownAsAlt"; OID = "$TVOIDBase.1.2.2.72"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Known As (Alternate)" },
    @{ Name = "tv-Known-As"; LDAPName = "tvKnownAs"; OID = "$TVOIDBase.1.2.2.73"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Known As" },
    @{ Name = "tv-Preferred-Full-Name-Alt"; LDAPName = "tvPreferredFullNameAlt"; OID = "$TVOIDBase.1.2.2.74"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Preferred Full Name (Alternate)" },
    @{ Name = "tv-Preferred-Full-Name"; LDAPName = "tvPreferredFullName"; OID = "$TVOIDBase.1.2.2.75"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Preferred Full Name" },
    @{ Name = "tv-Full-Name-Alt"; LDAPName = "tvFullNameAlt"; OID = "$TVOIDBase.1.2.2.76"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Full Name (Alternate)" },
    @{ Name = "tv-Full-Name"; LDAPName = "tvFullName"; OID = "$TVOIDBase.1.2.2.77"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Full Name" },
    @{ Name = "tv-Given-Name-Alt"; LDAPName = "tvGivenNameAlt"; OID = "$TVOIDBase.1.2.2.78"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Given Name (Alternate)" },
    @{ Name = "tv-Sites-Managed"; LDAPName = "tvSitesManaged"; OID = "$TVOIDBase.1.2.2.79"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $false; Description = "Sites Managed" },
    @{ Name = "tv-Immutable-HR-ID"; LDAPName = "tvImmutableHRID"; OID = "$TVOIDBase.1.2.2.80"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Immutable HR ID" },
    @{ Name = "tv-Org-Territory-ID"; LDAPName = "tvOrgTerritoryID"; OID = "$TVOIDBase.1.2.2.81"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Organization Territory ID" },
    @{ Name = "tv-IDM-Group-Type"; LDAPName = "tvIDMGroupType"; OID = "$TVOIDBase.1.2.2.82"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "IDM Group Type" },
    @{ Name = "tv-Rehire-Date"; LDAPName = "tvRehireDate"; OID = "$TVOIDBase.1.2.2.83"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "Rehire Date" },
    @{ Name = "tv-External-Email-Address"; LDAPName = "tvExternalEmailAddress"; OID = "$TVOIDBase.1.2.2.84"; Syntax = "2.5.5.12"; OMSyntax = 64; SingleValued = $true; Description = "External Email Address" }
)

try {
    foreach ($attr in $SchemaAttributes) {
        $attrDN = "CN=$($attr.Name),$SchemaDN"
        if (-not (Get-ADObject -Filter "distinguishedName -eq '$attrDN'" -SearchBase $SchemaDN -ErrorAction SilentlyContinue)) {
            Write-Log "Creating schema attribute $($attr.Name)"
            New-ADObject -Name $attr.Name -Type attributeSchema -Path $SchemaDN -OtherAttributes @{
                lDAPDisplayName  = $attr.LDAPName
                attributeID      = $attr.OID
                attributeSyntax  = $attr.Syntax
                oMSyntax         = $attr.OMSyntax
                isSingleValued   = $attr.SingleValued
                adminDescription = $attr.Description
                searchFlags      = 1
            } -ErrorAction SilentlyContinue
        }
    }

    $schemaRoot = [ADSI]"LDAP://CN=Schema,$ConfigDN"
    $schemaRoot.Put("schemaUpdateNow", 1)
    $schemaRoot.SetInfo()
    Start-Sleep -Seconds 10
    Write-Log "Schema attributes applied ($($SchemaAttributes.Count) tv* attributes)"
    Set-TVPhase "SCHEMA_APPLIED"
} catch {
    Write-Log "ERROR extending schema: $_"
    Set-TVPhase "ERROR:populate:schema"
}

# ------------------------------------------------------------------------------
# 2. Auxiliary classes tvUser / tvGroup, linked to user / group
# ------------------------------------------------------------------------------
Write-Log "Creating TaskVantage auxiliary classes..."
try {
    $GroupAttrs = @("tvIDMGroupType", "tvDirectorySync", "tvIDMPortalManaged")
    $UserAttrs = @($SchemaAttributes | ForEach-Object { $_.LDAPName }) | Where-Object { $_ -notin @("tvIDMGroupType", "tvIDMPortalManaged") }

    $tvUserDN = "CN=tvUser,$SchemaDN"
    if (-not (Get-ADObject -Filter "distinguishedName -eq '$tvUserDN'" -SearchBase $SchemaDN -ErrorAction SilentlyContinue)) {
        New-ADObject -Name "tvUser" -Type classSchema -Path $SchemaDN -OtherAttributes @{
            lDAPDisplayName     = "tvUser"
            governsID           = "$TVOIDBase.1.2.1.1"
            objectClassCategory = 3
            subClassOf          = "top"
            mayContain          = $UserAttrs
            adminDescription    = "TaskVantage User Extension"
        } -ErrorAction SilentlyContinue
        Write-Log "Created tvUser auxiliary class"
    }

    $tvGroupDN = "CN=tvGroup,$SchemaDN"
    if (-not (Get-ADObject -Filter "distinguishedName -eq '$tvGroupDN'" -SearchBase $SchemaDN -ErrorAction SilentlyContinue)) {
        New-ADObject -Name "tvGroup" -Type classSchema -Path $SchemaDN -OtherAttributes @{
            lDAPDisplayName     = "tvGroup"
            governsID           = "$TVOIDBase.1.2.1.3"
            objectClassCategory = 3
            subClassOf          = "top"
            mayContain          = $GroupAttrs
            adminDescription    = "TaskVantage Group Extension"
        } -ErrorAction SilentlyContinue
        Write-Log "Created tvGroup auxiliary class"
    }

    $schemaRoot = [ADSI]"LDAP://CN=Schema,$ConfigDN"
    $schemaRoot.Put("schemaUpdateNow", 1)
    $schemaRoot.SetInfo()
    Start-Sleep -Seconds 10

    $userClass = Get-ADObject -SearchBase $SchemaDN -Filter "lDAPDisplayName -eq 'user'" -Properties auxiliaryClass
    if ($userClass.auxiliaryClass -notcontains "tvUser") {
        Set-ADObject -Identity $userClass.DistinguishedName -Add @{auxiliaryClass = "tvUser" } -ErrorAction SilentlyContinue
        Write-Log "Linked tvUser to user class"
    }
    $groupClass = Get-ADObject -SearchBase $SchemaDN -Filter "lDAPDisplayName -eq 'group'" -Properties auxiliaryClass
    if ($groupClass.auxiliaryClass -notcontains "tvGroup") {
        Set-ADObject -Identity $groupClass.DistinguishedName -Add @{auxiliaryClass = "tvGroup" } -ErrorAction SilentlyContinue
        Write-Log "Linked tvGroup to group class"
    }

    $schemaRoot.Put("schemaUpdateNow", 1)
    $schemaRoot.SetInfo()
    Write-Log "Auxiliary classes created and linked"
} catch {
    Write-Log "ERROR creating auxiliary classes: $_"
    Set-TVPhase "ERROR:populate:aux-classes"
}

# ------------------------------------------------------------------------------
# 3. Core OUs, groups, sample users (Field/Corp theme)
# ------------------------------------------------------------------------------
Write-Log "Creating core OUs..."
try {
    New-ADOrganizationalUnit -Name "Field" -Path $DomainDN -Description "Field Operations" -ErrorAction SilentlyContinue
    New-ADOrganizationalUnit -Name "Corp" -Path $DomainDN -Description "Corporate" -ErrorAction SilentlyContinue
    New-ADOrganizationalUnit -Name "Groups" -Path $DomainDN -Description "Security Groups" -ErrorAction SilentlyContinue
    New-ADOrganizationalUnit -Name "Service Accounts" -Path $DomainDN -ErrorAction SilentlyContinue

    $FieldOU = "OU=Field,$DomainDN"
    foreach ($n in @("Site Managers", "Team Leads", "Field Technicians", "Territory Managers")) {
        New-ADOrganizationalUnit -Name $n -Path $FieldOU -ErrorAction SilentlyContinue
    }
    $CorpOU = "OU=Corp,$DomainDN"
    foreach ($n in @("Executives", "IT", "HR", "Finance", "Operations")) {
        New-ADOrganizationalUnit -Name $n -Path $CorpOU -ErrorAction SilentlyContinue
    }
    Write-Log "Core OUs created"
} catch {
    Write-Log "ERROR creating core OUs: $_"
}

Write-Log "Creating security groups..."
try {
    $GroupsOU = "OU=Groups,$DomainDN"
    $Groups = @(
        @{ Name = "Field-All"; Description = "All Field Associates" },
        @{ Name = "Site-Managers"; Description = "Site Managers" },
        @{ Name = "Team-Leads"; Description = "Team Leads" },
        @{ Name = "Field-Technicians"; Description = "Field Technicians" },
        @{ Name = "Territory-Managers"; Description = "Territory Managers" },
        @{ Name = "Corp-All"; Description = "All Corporate Employees" },
        @{ Name = "IT-Team"; Description = "IT Department" },
        @{ Name = "HR-Team"; Description = "HR Department" },
        @{ Name = "Finance-Team"; Description = "Finance Department" },
        @{ Name = "Executives"; Description = "Executive Leadership" },
        @{ Name = "Operations-Leadership"; Description = "Operations Leadership" },
        @{ Name = "Dispatch-Admin-Access"; Description = "Dispatch Administration Access" },
        @{ Name = "HR-System-Access"; Description = "HR System Access" },
        @{ Name = "Financial-System-Access"; Description = "Financial System Access" }
    )
    foreach ($g in $Groups) {
        New-ADGroup -Name $g.Name -GroupScope Global -Path $GroupsOU -Description $g.Description -ErrorAction SilentlyContinue
    }
    Write-Log "Security groups created"
} catch {
    Write-Log "ERROR creating groups: $_"
}

Write-Log "Creating sample users..."
try {
    $DemoPassword = ConvertTo-SecureString (Get-TVSecret "admin-password") -AsPlainText -Force
    $Domain = $Config.domainName

    # tv* attribute values ride along so the Okta UD import has custom-schema
    # data worth mapping. tvAssociateNumberAsInteger = numeric EmployeeID.
    function New-TVUser {
        param($Name, $First, $Last, $Sam, $OU, $Dept, $Title, $Office, $EmpId, $CostCenter, $SiteId, $TerritoryId)
        $Other = @{
            tvEmployeeStatus           = "Active"
            tvSourceSystem             = "TaskVantage-HR"
            tvCostCenter               = $CostCenter
            tvKnownAs                  = $First
            tvFullName                 = $Name
            tvImmutableID              = $EmpId
            tvAssociateNumberAsInteger = ($EmpId -replace "[^0-9]", "")
        }
        if ($SiteId) { $Other.tvOrgSiteID = $SiteId }
        if ($TerritoryId) { $Other.tvOrgTerritoryID = $TerritoryId }
        New-ADUser -Name $Name -GivenName $First -Surname $Last -SamAccountName $Sam `
            -UserPrincipalName "$Sam@$Domain" -Path $OU -AccountPassword $DemoPassword `
            -Enabled $true -Department $Dept -Title $Title -Office $Office -EmployeeID $EmpId `
            -OtherAttributes $Other -ErrorAction SilentlyContinue
    }

    $TMPath = "OU=Territory Managers,OU=Field,$DomainDN"
    New-TVUser "Kevin Harris" "Kevin" "Harris" "kevin.harris" $TMPath "Operations" "Territory Manager" "Northwest-Territory" "EMP-0030" "701020" $null "T-100"
    New-TVUser "Lisa Clark" "Lisa" "Clark" "lisa.clark" $TMPath "Operations" "Territory Manager" "Pacific-Territory" "EMP-0031" "701021" $null "T-200"

    $SMPath = "OU=Site Managers,OU=Field,$DomainDN"
    New-TVUser "Brian Allen" "Brian" "Allen" "brian.allen" $SMPath "Operations" "Site Manager" "Site-1001-Harborview" "EMP-0100" "702001" "1001" "T-100"
    New-TVUser "Ashley Young" "Ashley" "Young" "ashley.young" $SMPath "Operations" "Site Manager" "Site-1002-Cascade-Center" "EMP-0101" "702002" "1002" "T-100"
    New-TVUser "Megan Green" "Megan" "Green" "megan.green" $SMPath "Operations" "Site Manager" "Site-4001-Midtown-Hub" "EMP-0107" "702041" "4001" "T-200"

    $TLPath = "OU=Team Leads,OU=Field,$DomainDN"
    New-TVUser "Marcus Carter" "Marcus" "Carter" "marcus.carter" $TLPath "Operations" "Team Lead" "Site-1001-Harborview" "EMP-0200" "702001" "1001" "T-100"
    New-TVUser "Olivia Mitchell" "Olivia" "Mitchell" "olivia.mitchell" $TLPath "Operations" "Team Lead" "Site-1002-Cascade-Center" "EMP-0201" "702002" "1002" "T-100"

    $FTPath = "OU=Field Technicians,OU=Field,$DomainDN"
    New-TVUser "Noah Campbell" "Noah" "Campbell" "noah.campbell" $FTPath "Operations" "Field Technician" "Site-1001-Harborview" "EMP-0300" "702001" "1001" "T-100"
    New-TVUser "Ava Parker" "Ava" "Parker" "ava.parker" $FTPath "Operations" "Field Technician" "Site-1001-Harborview" "EMP-0301" "702001" "1001" "T-100"
    New-TVUser "Isabella Edwards" "Isabella" "Edwards" "isabella.edwards" $FTPath "Operations" "Field Technician" "Site-4001-Midtown-Hub" "EMP-0303" "702041" "4001" "T-200"

    $ExecPath = "OU=Executives,OU=Corp,$DomainDN"
    New-TVUser "Maria Johnson" "Maria" "Johnson" "maria.johnson" $ExecPath "Executive" "Chief Executive Officer" "HQ-Denver" "EMP-0001" "800010" $null $null
    New-TVUser "David Chen" "David" "Chen" "david.chen" $ExecPath "Executive" "Chief Financial Officer" "HQ-Denver" "EMP-0002" "800010" $null $null
    New-TVUser "Sarah Williams" "Sarah" "Williams" "sarah.williams" $ExecPath "Executive" "Chief Information Officer" "HQ-Denver" "EMP-0003" "800010" $null $null

    $ITPath = "OU=IT,OU=Corp,$DomainDN"
    New-TVUser "Amanda Wilson" "Amanda" "Wilson" "amanda.wilson" $ITPath "IT" "VP of Information Technology" "HQ-Denver" "EMP-0011" "800040" $null $null
    New-TVUser "Benjamin Rogers" "Benjamin" "Rogers" "benjamin.rogers" $ITPath "IT" "Director of Engineering" "HQ-Denver" "EMP-0400" "800040" $null $null
    New-TVUser "Henry Bailey" "Henry" "Bailey" "henry.bailey" $ITPath "IT" "Senior Systems Administrator" "HQ-Denver" "EMP-0405" "800040" $null $null

    $HRPath = "OU=HR,OU=Corp,$DomainDN"
    New-TVUser "Christopher Lee" "Christopher" "Lee" "christopher.lee" $HRPath "HR" "VP of Human Resources" "HQ-Denver" "EMP-0012" "800050" $null $null
    New-TVUser "Jack Cooper" "Jack" "Cooper" "jack.cooper" $HRPath "HR" "Director of Talent Acquisition" "HQ-Denver" "EMP-0500" "800050" $null $null

    $FinPath = "OU=Finance,OU=Corp,$DomainDN"
    New-TVUser "Elizabeth Taylor" "Elizabeth" "Taylor" "elizabeth.taylor" $FinPath "Finance" "VP of Finance" "HQ-Denver" "EMP-0013" "800060" $null $null

    $OpsPath = "OU=Operations,OU=Corp,$DomainDN"
    New-TVUser "Jennifer Davis" "Jennifer" "Davis" "jennifer.davis" $OpsPath "Operations" "SVP of Operations" "HQ-Denver" "EMP-0005" "800070" $null $null

    Write-Log "Sample users created (20: 10 Field, 10 Corp)"
} catch {
    Write-Log "ERROR creating users: $_"
}

Write-Log "Adding users to groups..."
try {
    Add-ADGroupMember -Identity "Site-Managers" -Members "brian.allen", "ashley.young", "megan.green" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "Territory-Managers" -Members "kevin.harris", "lisa.clark" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "Team-Leads" -Members "marcus.carter", "olivia.mitchell" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "Field-Technicians" -Members "noah.campbell", "ava.parker", "isabella.edwards" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "Field-All" -Members "brian.allen", "ashley.young", "megan.green", "kevin.harris", "lisa.clark", "marcus.carter", "olivia.mitchell", "noah.campbell", "ava.parker", "isabella.edwards" -ErrorAction SilentlyContinue

    Add-ADGroupMember -Identity "Executives" -Members "maria.johnson", "sarah.williams", "david.chen" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "IT-Team" -Members "sarah.williams", "amanda.wilson", "benjamin.rogers", "henry.bailey" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "HR-Team" -Members "christopher.lee", "jack.cooper" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "Finance-Team" -Members "david.chen", "elizabeth.taylor" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "Operations-Leadership" -Members "jennifer.davis", "kevin.harris", "lisa.clark" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "Corp-All" -Members "maria.johnson", "sarah.williams", "david.chen", "amanda.wilson", "benjamin.rogers", "henry.bailey", "christopher.lee", "jack.cooper", "elizabeth.taylor", "jennifer.davis" -ErrorAction SilentlyContinue

    Add-ADGroupMember -Identity "Dispatch-Admin-Access" -Members "brian.allen", "ashley.young", "megan.green", "kevin.harris", "lisa.clark" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "HR-System-Access" -Members "christopher.lee", "jack.cooper" -ErrorAction SilentlyContinue
    Add-ADGroupMember -Identity "Financial-System-Access" -Members "david.chen", "elizabeth.taylor" -ErrorAction SilentlyContinue
    Write-Log "Group memberships applied"
    Set-TVPhase "USERS_CREATED"
} catch {
    Write-Log "ERROR adding users to groups: $_"
}

# ------------------------------------------------------------------------------
# 4. Full enterprise OU tree from ou-structure.json (242 OUs)
# ------------------------------------------------------------------------------
Write-Log "Creating enterprise OU tree..."
try {
    $OUData = Get-Content "$LogDir\ou-structure.json" -Raw | ConvertFrom-Json
    $Created = 0; $Existed = 0; $Failed = 0
    foreach ($ou in $OUData) {
        $Path = if ($ou.path) { "$($ou.path),$DomainDN" } else { $DomainDN }
        try {
            New-ADOrganizationalUnit -Name $ou.name -Path $Path -ProtectedFromAccidentalDeletion $false -ErrorAction Stop
            $Created++
        } catch {
            if ($_.ToString() -like "*already exists*" -or $_.ToString() -like "*already in use*") { $Existed++ }
            else { $Failed++; Write-Log "OU FAILED: $($ou.name) under $Path -- $_" }
        }
    }
    Write-Log "Enterprise OU tree: $Created created, $Existed existed, $Failed failed (of $($OUData.Count))"
    Set-TVPhase "OUS_CREATED"
} catch {
    Write-Log "ERROR creating enterprise OU tree: $_"
    Set-TVPhase "ERROR:populate:ou-tree"
}

# ------------------------------------------------------------------------------
# 5. Stage the Okta AD agent installer (operator stages it in S3 once)
# ------------------------------------------------------------------------------
Write-Log "Staging Okta AD agent installer..."
try {
    Read-S3Object -BucketName $Config.bucket -Key "$($Config.prefix)/OktaADAgentSetup.exe" -File "$LogDir\OktaADAgentSetup.exe" | Out-Null
    Write-Log "Okta AD agent staged at $LogDir\OktaADAgentSetup.exe"
} catch {
    Write-Log "WARN: Okta AD agent not staged in S3 ($($Config.bucket)/$($Config.prefix)/OktaADAgentSetup.exe) — download it via the Okta Admin Console instead"
}
Set-TVPhase "AGENT_STAGED"

# ------------------------------------------------------------------------------
# Done — retire the startup tasks
# ------------------------------------------------------------------------------
Unregister-ScheduledTask -TaskName "PostPromotionConfig" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "PromoteDomainController" -Confirm:$false -ErrorAction SilentlyContinue
Set-TVPhase "READY"
Write-Log "===== TaskVantage directory READY ====="

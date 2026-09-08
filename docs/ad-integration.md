# TaskVantage Active Directory option — operator guide

The portal's **"Include Active Directory"** toggle provisions, per spoke, a Windows
EC2 domain controller for the fictional company TaskVantage (`taskvantage.local`)
populated with 38 `tv*` custom schema attributes, 242 organizational units, 14 security
groups, and 20 sample users (with `tv*` attribute values), then stages the Okta AD agent
so the directory can be imported into that spoke's Universal Directory.

De-identification provenance: docs/taskvantage-mapping.md.

## One-time host setup

```bash
portal/scripts/setup-ad.sh
```

Idempotent. It: runs `terraform init -upgrade` in `portal/terraform` (vendors the aws
provider — commit the `.terraform.lock.hcl` change), applies the shared AD network
(`portal/terraform/ad-network`: VPC 10.77.0.0/16, public subnet, zero-inbound SG), and
stages `ad-setup.ps1` + `ou-structure.json` to `s3://okta-terraform-demo/ad/taskvantage/`.

**Stage the agent installer once** (it can only be downloaded from an Okta Admin
Console): any org → Directory → Directory Integrations → Add Active Directory →
Download Agent, then:

```bash
aws s3 cp OktaADAgentSetup.exe s3://okta-terraform-demo/ad/taskvantage/OktaADAgentSetup.exe
```

Without it, DCs still build fully; you just download the agent manually on the DC.

## What happens on provision

Terraform launches the DC and returns; the directory then builds itself across three
boots (~20 min). Progress is written to SSM parameter `/taskvantage/<spoke>/setup-phase`
(`LAUNCHING → ADDS_INSTALLED → PROMOTION_STARTED → SCHEMA_APPLIED → USERS_CREATED →
OUS_CREATED → AGENT_STAGED → READY`, or `ERROR:*`). The portal watches it in the
background and shows a live status chip on the org card. Secrets (Administrator + DSRM
passwords, generated per request) live only in SecureString SSM parameters under
`/taskvantage/<spoke>/`.

## Finishing the Okta UD import (manual, ~5 min)

The Okta AD agent registers through a browser activation-code flow (an admin signs in
and clicks Allow Access) — there is no supported unattended registration, and the
Okta-side directory integration has no terraform resource. When the org card shows
**AD: ready**:

1. Port-forward RDP over SSM (no inbound rules exist on the DC):
   ```bash
   aws ssm start-session --target <instance-id> \
     --document-name AWS-StartPortForwardingSession \
     --parameters portNumber=3389,localPortNumber=13389
   ```
2. RDP to `localhost:13389` as `TASKVANTAGE\Administrator` (password: "Reveal
   Administrator password" button on the org card).
3. Run `C:\Terraform\OktaADAgentSetup.exe`. When prompted, enter the **spoke** org URL
   and sign in as a spoke admin (an admin *login* is required — the pool's API tokens
   are not enough), then approve the activation.
4. Spoke Admin Console → **Directory → Directory Integrations → Active Directory**:
   - Select user OUs: `TASKVANTAGE` tree plus `Field` and `Corp`; group OU: `Groups`.
   - Okta username format: UPN.
   - Map the demo-relevant custom attributes to (custom) UD attributes:

   | AD attribute | Suggested UD attribute |
   |---|---|
   | `tvCostCenter` | costCenter |
   | `tvEmployeeStatus` | tvEmployeeStatus (custom) |
   | `tvOrgSiteID` | tvOrgSiteID (custom) |
   | `tvOrgTerritoryID` | tvOrgTerritoryID (custom) |
   | `tvAssociateNumberAsInteger` | employeeNumber |
   | `tvKnownAs` | nickName |
   | `tvSitesManaged` | tvSitesManaged (custom) |
   | `tvImmutableID` | externalId |

   (Custom app-user attributes: Directory → Profile Editor → the AD app → Add Attribute
   with the matching `tv*` external name first.)
   - Schedule: hourly import, auto-confirm exact matches (the sample users won't match
     existing spoke users — confirm as new).
5. Run a **Full Import** and verify ~21 users and 14 groups arrive.

## Migrating to Okta-managed

Once the import is verified, the org card offers **Migrate to Okta-managed** — the
automated phases 3+4 of [ad-to-okta-journey.md](ad-to-okta-journey.md): it mirrors every
AD-mastered group to an Okta-native twin (member copies), re-targets any app assignments
riding AD groups, creates attribute-driven groups + group rules from `tvOrgTerritoryID`
(where mapped), deactivates the AD integration so profile sourcing falls through to
Okta, then sets each migrated user's Okta password to the TaskVantage demo password (a
stand-in for the AD Password Sync agent — "same password, now against Okta") and
verifies users report Okta as their credential provider. Progress streams live on the
org card. Everything it creates is marked (`[tv-migrated]` group descriptions, `tv-`
rule prefix) so pool reset removes it, along with the imported users and the AD app.

## Repair / troubleshooting

- `aws ssm get-parameter --name /taskvantage/<spoke>/setup-phase --query Parameter.Value --output text`
- Setup log on the DC: `C:\Terraform\bootstrap.log`. Read it without RDP:
  ```bash
  aws ssm send-command --document-name AWS-RunPowerShellScript \
    --instance-ids <id> --parameters commands='Get-Content C:\Terraform\bootstrap.log -Tail 50'
  ```
- Re-run the (idempotent) population — schema, OUs, groups, users, agent staging:
  ```bash
  aws ssm send-command --document-name AWS-RunPowerShellScript \
    --instance-ids <id> --parameters commands='C:\Terraform\ad-setup.ps1 -Phase populate'
  ```
- After editing `ad-setup.ps1` or regenerating `ou-structure.json`
  (`node tools/gen-taskvantage-ous.mjs …`), re-run `portal/scripts/setup-ad.sh` to
  restage S3, and keep the deny-list test green (`node --test portal/test/`).

## Teardown and cost

Pool reset (`POST /api/pool/reset` or `portal/scripts/reset-pool.mjs`) destroys the DC
via targeted `terraform destroy` before deleting the spoke's state, with a tag-sweep
fallback (`TaskVantageSpoke=<spoke>`) that also removes the SSM parameters and the
`tv-ad-<spoke>` IAM role. The shared VPC survives resets; retire it with
`terraform -chdir=portal/terraform/ad-network destroy`.

Cost per AD-enabled spoke: t3.medium Windows ≈ $1.50/day + 60 GB gp3 ≈ $4.80/month —
reset promptly after demos.

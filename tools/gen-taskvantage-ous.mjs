#!/usr/bin/env node
// Regenerates portal/terraform/modules/active-directory/files/ou-structure.json
// from the sbux POC repo's inline OU array, applying the TaskVantage
// de-identification mapping (docs/taskvantage-mapping.md). The output is a
// committed artifact; this script exists for provenance and re-generation.
//
// Usage: node tools/gen-taskvantage-ous.mjs <path-to-ad-create-all-ous.yml> [outfile]
//
// The source file is NOT part of this repo. Nothing customer-derived
// (POC-data CSVs/LDIFs) is read — only the hand-written inline array.

import { readFileSync, writeFileSync } from "node:fs";

// Token substitutions, applied longest-match-first to OU names and paths.
// Keep this table in sync with docs/taskvantage-mapping.md.
const SUBSTITUTIONS = [
  ["SCCO/DHL Danzas Users", "NorthHaul Logistics Users"],
  ["SBUX Wireless Guest Accounts", "TV Wireless Guest Accounts"],
  ["Distribution Lists Partner Blend", "Distribution Lists Associate Blend"],
  ["Distribution Lists Retail", "Distribution Lists Field"],
  ["Retail Contact Objects", "Field Contact Objects"],
  ["Corp Store Mailbox Groups", "Corp Site Mailbox Groups"],
  ["HPR Link Logistics", "LinkPoint Logistics"],
  ["Licensed Store DL", "Reseller Site DL"],
  ["EMEA Kronos Servers", "EMEA ShiftTrack Servers"],
  ["CyberArk NonProd", "PAM NonProd"],
  ["Corp VISFed Servers", "Corp FedGateway Servers"],
  ["Retail Stores", "Field Sites"],
  ["STARBUCKS", "TASKVANTAGE"],
  ["StoreLaptops", "SiteLaptops"],
  ["Stores-LS", "Sites-Managed"],
  ["Stores", "Sites"],
  ["Licensee", "Resellers"],
  ["MICROS-EMEA", "FieldServe-EMEA"],
  ["MICROS", "FieldServe"],
  ["3C-EMEA", "TriCore-EMEA"],
  ["3C", "TriCore"],
  ["Kronos", "ShiftTrack"],
  ["GlobalPSP", "GlobalWSP"],
  ["China", "APAC"],
];

// Anything on this list surviving into the output means the mapping missed a
// construct — fail loudly rather than ship identifiable data.
const DENY = /STARBUCKS|SBUX|Starbucks|sbux|Barista|Pike\s?Place|DHL|Danzas|MICROS|Kronos|CyberArk|VISFed|Licensee|Licensed Store|GlobalPSP|China/;

function applyMapping(s) {
  let out = s;
  for (const [from, to] of SUBSTITUTIONS) out = out.split(from).join(to);
  return out;
}

const [srcPath, outPath = "portal/terraform/modules/active-directory/files/ou-structure.json"] =
  process.argv.slice(2);
if (!srcPath) {
  console.error("usage: gen-taskvantage-ous.mjs <ad-create-all-ous.yml> [outfile]");
  process.exit(2);
}

const src = readFileSync(srcPath, "utf8");

// Entries look like: @{Name="Cloud"; Path="OU=STARBUCKS,$DomainDN"} or Path=$DomainDN
const entryRe = /@\{Name="([^"]+)";\s*Path=(?:"([^"]*)"|(\$DomainDN))\}/g;
const ous = [];
for (const m of src.matchAll(entryRe)) {
  const name = applyMapping(m[1]);
  // Path relative to the domain root: strip the ,$DomainDN suffix; "" = root.
  const rawPath = m[3] ? "" : m[2].replace(/,?\$DomainDN$/, "");
  ous.push({ name, path: applyMapping(rawPath) });
}
if (ous.length < 200) {
  console.error(`parsed only ${ous.length} OU entries — source format changed?`);
  process.exit(1);
}

// Parent-before-child validation: every non-root path must already be creatable.
const seen = new Set([""]);
const problems = [];
for (const { name, path } of ous) {
  if (!seen.has(path)) problems.push(`"${name}" parented under not-yet-created "${path}"`);
  seen.add(path === "" ? `OU=${name}` : `OU=${name},${path}`);
}
// "Domain Controllers" etc. exist by default in a fresh domain; the consumer
// catches "already exists", so ordering is the only hard requirement here.
if (problems.length) {
  console.error("ordering problems:\n" + problems.join("\n"));
  process.exit(1);
}

const json = JSON.stringify(ous, null, 2) + "\n";
const hits = json.match(DENY);
if (hits) {
  console.error(`de-identification gate FAILED — output still contains "${hits[0]}"`);
  process.exit(1);
}

writeFileSync(outPath, json);
console.log(`wrote ${ous.length} OUs -> ${outPath} (deny-list clean)`);

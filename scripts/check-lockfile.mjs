// Fail when package-lock.json's copy of this project's own version disagrees
// with package.json.
//
// npm writes that copy on install. A release that bumps package.json without
// running an install leaves it behind, and nothing else catches it: `npm ci`
// fails when the lockfile's DEPENDENCY entries disagree with package.json, but
// it does not check the lockfile's copy of the project's own version. Measured
// in bareguard, where it sat at 0.13.0 while 0.14.0, 0.15.0 and 0.16.0 all
// shipped.
//
// Harmless to consumers — npm does not include a library's lockfile in the
// published tarball — so this is repo hygiene, not a user-visible bug. It is a
// hard failure anyway because it is trivially fixable and can never be a false
// positive: it compares two numbers this repo owns.
//
// No lockfile is not a failure. Some repos deliberately ship without one, and
// this check runs from a workflow shared across all of them.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (f) => JSON.parse(readFileSync(path.join(root, f), "utf8"));

let lock;
try {
  lock = read("package-lock.json");
} catch (err) {
  if (err.code === "ENOENT") {
    console.log("✓ no package-lock.json — nothing to check");
    process.exit(0);
  }
  throw err;
}

const pkg = read("package.json");

// Two places hold it: the lockfile root, and the root package's own entry in
// `packages[""]`. npm writes both, so both are checked — drift in either is the
// same drift, and checking only one lets the other move unseen.
const found = {
  "package-lock.json version": lock.version,
  'package-lock.json packages[""].version': lock.packages?.[""]?.version,
};
const wrong = Object.entries(found).filter(([, v]) => v !== pkg.version);

if (wrong.length) {
  console.error(`✗ lockfile version drift — package.json is ${pkg.version}:`);
  for (const [where, v] of wrong) console.error(`    ${where} = ${v ?? "(missing)"}`);
  console.error("  Fix: npm install --package-lock-only   (then commit package-lock.json)");
  process.exit(1);
}

console.log(`✓ package-lock.json version matches package.json — ${pkg.version}`);

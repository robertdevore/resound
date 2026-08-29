#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageFiles = [
  "package.json",
  ...fs
    .readdirSync(path.join(root, "apps"))
    .map((name) => `apps/${name}/package.json`),
  ...fs
    .readdirSync(path.join(root, "packages"))
    .map((name) => `packages/${name}/package.json`),
];
const manifests = packageFiles.map((file) => ({
  file,
  value: JSON.parse(fs.readFileSync(path.join(root, file), "utf8")),
}));
const expected = manifests[0].value.version;
const invalid = manifests.filter(({ value }) => value.version !== expected);
if (invalid.length > 0) {
  throw new Error(
    `Workspace versions differ from ${expected}: ${invalid.map(({ file, value }) => `${file}=${value.version}`).join(", ")}`,
  );
}
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${expected}]`)) {
  throw new Error(`CHANGELOG.md has no ${expected} release entry.`);
}
const tag =
  process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : undefined;
if (tag && tag !== `v${expected}`) {
  throw new Error(`Tag ${tag} does not match package version v${expected}.`);
}
console.log(
  `Release metadata is consistent for v${expected} across ${manifests.length} packages.`,
);

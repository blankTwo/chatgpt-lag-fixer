import fs from "node:fs";

const packagePath = "package.json";
const manifestPath = "extension/manifest.json";
const lockPath = "package-lock.json";

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const match = String(pkg.version || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) throw new Error(`无法递增非法版本号: ${pkg.version}`);

const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
pkg.version = nextVersion;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = nextVersion;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = nextVersion;
  if (lock.packages?.[""]) lock.packages[""].version = nextVersion;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(`版本号已递增到 ${nextVersion}`);

import { existsSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve("electron/package.json");
const electronDir = dirname(electronPackagePath);
const { downloadArtifact } = require(
  require.resolve("@electron/get", { paths: [electronDir] }),
);
const extract = require(
  require.resolve("extract-zip", { paths: [electronDir] }),
);
const electronPackage = JSON.parse(await readFile(electronPackagePath, "utf8"));
const platformPath = getPlatformPath();
const distPath = join(electronDir, "dist");

if (!isInstalled()) {
  const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: "electron",
    force: process.env.force_no_cache === "true",
    cacheRoot: process.env.electron_config_cache,
    platform: process.env.npm_config_platform || os.platform(),
    arch: process.env.npm_config_arch || process.arch,
  });

  await extract(zipPath, { dir: distPath });

  const extractedTypes = join(distPath, "electron.d.ts");
  if (existsSync(extractedTypes)) {
    await rename(extractedTypes, join(electronDir, "electron.d.ts"));
  }

  await writeFile(join(electronDir, "path.txt"), platformPath);
}

await ensureNodePtySpawnHelperExecutable();

function isInstalled() {
  return (
    existsSync(join(electronDir, "path.txt")) &&
    existsSync(join(distPath, platformPath))
  );
}

function getPlatformPath() {
  const platform = process.env.npm_config_platform || os.platform();

  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(
        `Electron builds are not available on platform: ${platform}`,
      );
  }
}

async function ensureNodePtySpawnHelperExecutable() {
  try {
    const nodePtyPackagePath = require.resolve("node-pty/package.json");
    const nodePtyDir = dirname(nodePtyPackagePath);
    const arch = process.env.npm_config_arch || process.arch;
    const helper = join(
      nodePtyDir,
      "prebuilds",
      `darwin-${arch}`,
      "spawn-helper",
    );
    if (existsSync(helper)) {
      await chmod(helper, 0o755);
    }
  } catch {
    return;
  }
}

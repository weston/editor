import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve("electron/package.json");
const electronDir = dirname(electronPackagePath);
const sourceApp = join(electronDir, "dist", "Electron.app");
const appRoot = resolve(".dev");
const editorApp = join(appRoot, "Editor.app");
const plistPath = join(editorApp, "Contents", "Info.plist");
const executable = join(editorApp, "Contents", "MacOS", "Electron");

await rm(editorApp, { recursive: true, force: true });
await mkdir(appRoot, { recursive: true });
await cp(sourceApp, editorApp, { recursive: true });
await patchPlist();

const child = spawn(executable, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

async function patchPlist() {
  let plist = await readFile(plistPath, "utf8");
  plist = setPlistString(plist, "CFBundleDisplayName", "Editor");
  plist = setPlistString(plist, "CFBundleName", "Editor");
  plist = setPlistString(plist, "CFBundleIdentifier", "com.weston.editor.dev");
  await writeFile(plistPath, plist);
}

function setPlistString(plist, key, value) {
  return plist.replace(
    new RegExp(
      `(<key>${escapeRegExp(key)}</key>\\s*<string>)([^<]*)(</string>)`,
    ),
    `$1${value}$3`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

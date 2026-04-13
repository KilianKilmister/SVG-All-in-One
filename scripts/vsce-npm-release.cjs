const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const mode = process.argv[2];
const passThroughArgs = process.argv.slice(3);

if (mode !== "package" && mode !== "publish") {
  console.error("Usage: node scripts/vsce-npm-release.cjs <package|publish> [vsce args]");
  process.exit(1);
}

const rootDir = path.resolve(__dirname, "..");
const stageDir = path.join(rootDir, ".tmp-vsce-npm");
const keepStage = process.env.KEEP_VSCE_STAGE === "1";
const excludedNames = new Set([
  ".git",
  "node_modules",
  ".tmp-vsce-npm",
  ".tmp-npm-test",
  ".tmp-vsix-inspect",
  ".tmp-vsix-inspect.zip"
]);

function run(command, args, cwd) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function copyProjectToStage() {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(rootDir, entry.name);
    const targetPath = path.join(stageDir, entry.name);

    fs.cpSync(sourcePath, targetPath, { recursive: true });
  }
}

function copyPackagedVsixBack() {
  const packageJsonPath = path.join(stageDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const vsixName = `${packageJson.name}-${packageJson.version}.vsix`;
  const stagedVsixPath = path.join(stageDir, vsixName);
  if (!fs.existsSync(stagedVsixPath)) {
    throw new Error(`VSIX not found in staging directory: ${stagedVsixPath}`);
  }

  const targetVsixPath = path.join(rootDir, vsixName);
  fs.copyFileSync(stagedVsixPath, targetVsixPath);
  console.log(`Copied VSIX to ${targetVsixPath}`);
}

function main() {
  copyProjectToStage();
  run("npm", ["install", "--no-package-lock"], stageDir);

  if (mode === "package") {
    run("npx", ["@vscode/vsce", "package", ...passThroughArgs], stageDir);
    copyPackagedVsixBack();
    return;
  }

  run("npx", ["@vscode/vsce", "publish", ...passThroughArgs], stageDir);
}

try {
  main();
  if (!keepStage) {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release workflow failed: ${message}`);
  if (!keepStage) {
    console.error(`Staging directory kept for debugging: ${stageDir}`);
  }
  process.exit(1);
}

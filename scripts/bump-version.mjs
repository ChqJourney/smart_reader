import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error("Usage: node scripts/bump-version.mjs <version>");
  console.error("Example: node scripts/bump-version.mjs 0.1.1");
  process.exit(1);
}

const root = path.resolve(__dirname, "..");

// Cargo.lock 里 [[package]] 的版本号要与 Cargo.toml 同步，否则发版后
// 工作区会留下 dirty lock（crate 名从 Cargo.toml 读取，不写死）。
const cargoTomlRaw = fs.readFileSync(
  path.join(root, "src-tauri", "Cargo.toml"),
  "utf8"
);
const crateName = cargoTomlRaw.match(/^name = "([^"]+)"$/m)?.[1];
if (!crateName) {
  console.error("Cannot read package name from src-tauri/Cargo.toml");
  process.exit(1);
}

const files = [
  {
    path: path.join(root, "package.json"),
    update: (content) => {
      const json = JSON.parse(content);
      json.version = version;
      return JSON.stringify(json, null, 2) + "\n";
    },
  },
  {
    path: path.join(root, "src-tauri", "Cargo.toml"),
    update: (content) => {
      return content.replace(/^version = "[^"]+"/m, `version = "${version}"`);
    },
  },
  {
    path: path.join(root, "src-tauri", "Cargo.lock"),
    update: (content) => {
      const pattern = new RegExp(
        `(\\[\\[package\\]\\]\\nname = "${crateName}"\\nversion = )"[^"]+"`
      );
      const updated = content.replace(pattern, `$1"${version}"`);
      if (
        !updated.includes(
          `[[package]]\nname = "${crateName}"\nversion = "${version}"`
        )
      ) {
        throw new Error(
          `Cargo.lock: cannot locate [[package]] entry for "${crateName}"`
        );
      }
      return updated;
    },
  },
  {
    path: path.join(root, "src-tauri", "tauri.conf.json"),
    update: (content) => {
      const json = JSON.parse(content);
      json.version = version;
      return JSON.stringify(json, null, 2) + "\n";
    },
  },
];

for (const file of files) {
  const raw = fs.readFileSync(file.path, "utf8");
  try {
    const updated = file.update(raw);
    fs.writeFileSync(file.path, updated);
  } catch (err) {
    console.error(
      `Failed to update ${path.relative(root, file.path)}: ${err.message}`
    );
    process.exit(1);
  }
  console.log(`Updated ${path.relative(root, file.path)} -> ${version}`);
}

console.log("\nNext steps:");
console.log(`  git add -A && git commit -m "release: v${version}"`);
console.log(`  git tag v${version}`);
console.log(`  git push origin v${version}`);

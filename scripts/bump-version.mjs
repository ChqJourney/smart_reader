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
  const updated = file.update(raw);
  fs.writeFileSync(file.path, updated);
  console.log(`Updated ${path.relative(root, file.path)} -> ${version}`);
}

console.log("\nNext steps:");
console.log(`  git add -A && git commit -m "release: v${version}"`);
console.log(`  git tag v${version}`);
console.log(`  git push origin v${version}`);

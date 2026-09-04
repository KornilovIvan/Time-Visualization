/**
 * Concatenate styles/*.css (order from styles/order.txt) into root styles.css.
 * Obsidian loads a single styles.css next to main.js.
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)));
const stylesDir = join(root, "styles");
const orderFile = join(stylesDir, "order.txt");

const order = readFileSync(orderFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

const missing = order.filter((f) => {
  try {
    readFileSync(join(stylesDir, f));
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error("styles-build: missing files:", missing.join(", "));
  process.exit(1);
}

const banner = `/*
 * GENERATED FILE — edit sources in styles/*.css, then run: node styles-build.mjs
 * (also run automatically from npm run build / npm run dev)
 */
`;

const body = order
  .map((f) => readFileSync(join(stylesDir, f), "utf8").trimEnd())
  .join("\n\n");

writeFileSync(join(root, "styles.css"), banner + "\n" + body + "\n");
console.log(`styles-build: wrote styles.css from ${order.length} sections`);

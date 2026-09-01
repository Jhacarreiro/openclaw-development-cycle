import { cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const packages = ["brace-expansion", "fast-uri", "ip-address", "undici"];
const root = process.cwd();

for (const name of packages) {
  const src = join(root, "node_modules", name);
  const dest = join(root, "node_modules", "openclaw", "node_modules", name);
  let wanted;
  let current;
  try {
    wanted = JSON.parse(await readFile(join(src, "package.json"), "utf8")).version;
  } catch {
    continue;
  }
  try {
    current = JSON.parse(await readFile(join(dest, "package.json"), "utf8")).version;
  } catch {
    current = null;
  }
  if (current === wanted) continue;
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
}

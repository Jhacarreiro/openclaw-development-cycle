import { readFile, readdir } from "node:fs/promises";

// The coordinator lives in src/index.ts plus the modules it assembles from src/cycle/.
export async function readCoordinatorSource() {
  const cycleDir = new URL("../../src/cycle/", import.meta.url);
  const modules = (await readdir(cycleDir)).filter((name) => name.endsWith(".ts")).sort();
  const parts = [await readFile(new URL("../../src/index.ts", import.meta.url), "utf8")];
  for (const name of modules) parts.push(await readFile(new URL(name, cycleDir), "utf8"));
  return parts.join("\n");
}

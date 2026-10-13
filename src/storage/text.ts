import { open } from "node:fs/promises";

export async function readTextTail(path: string, maxChars = 40000): Promise<string> {
  if (!path) return "";
  let handle;
  try {
    handle = await open(path, "r");
    const size = (await handle.stat()).size;
    const length = Math.min(size, Math.max(0, maxChars * 4));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf8").slice(-maxChars);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  } finally { await handle?.close(); }
}

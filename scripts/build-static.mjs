import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "app-dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await cp(join(root, "index.html"), join(dist, "index.html"));
await cp(join(root, "src"), join(dist, "src"), { recursive: true });

console.log("Static frontend copied to app-dist");

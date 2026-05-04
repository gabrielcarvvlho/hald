import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "haldy" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // keep walking — wrong package.json or unreadable
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

export const VERSION: string = readPackageVersion();

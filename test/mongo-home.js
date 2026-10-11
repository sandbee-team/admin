// The Playwright test server (test/ui-server.js) keeps its in-memory Mongo
// data in a folder it owns: Playwright stops the server hard, so no cleanup
// runs at exit. Each run gets <base>/run-<pid>-<random>; the next start removes
// the runs whose process is gone. Nothing outside <base> is ever touched.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const RUN_RE = /^run-(\d+)-[A-Za-z0-9]+$/;
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
const removeDir = (path) =>
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
export function prepareMongoHome(
  base,
  { isAlive = alive, remove = removeDir } = {},
) {
  mkdirSync(base, { recursive: true });
  for (const name of readdirSync(base)) {
    const match = RUN_RE.exec(name);
    if (!match || isAlive(Number(match[1]))) continue;
    try {
      remove(join(base, name));
    } catch {
      // Still locked (a mongod that is exiting): removed on a later start.
    }
  }
  return mkdtempSync(join(base, `run-${process.pid}-`));
}

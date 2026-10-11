import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { alive, prepareMongoHome } from "./mongo-home.js";

// test/ui-server.js: Playwright stops it hard, so its in-memory Mongo folder
// is cleaned on the next start instead.
describe("UI test server: in-memory Mongo folder", () => {
  it("removes only the runs of dead processes inside its own folder and returns a fresh one", () => {
    const root = mkdtempSync(join(tmpdir(), "ui-infra-"));
    try {
      const base = join(root, "home");
      const foreign = join(root, "mongo-mem-foreign");
      mkdirSync(join(foreign, "db"), { recursive: true });
      writeFileSync(join(foreign, "db", "x"), "x");
      // Names that only look like runs are never touched.
      const odd = ["run-x-1", "run-12-a.b", "run-12-"];
      for (const run of [
        "run-1111-1",
        "run-4242-2",
        "run-2222-3",
        "notes",
        ...odd,
      ])
        mkdirSync(join(base, run, "db"), { recursive: true });
      writeFileSync(join(base, "run-1111-1", "db", "WiredTiger"), "data");
      writeFileSync(join(base, "keep.txt"), "x");
      const removed = [];
      const dir = prepareMongoHome(base, {
        isAlive: (pid) => pid === 4242,
        remove: (path) => {
          removed.push(basename(path));
          if (basename(path) === "run-2222-3")
            throw Object.assign(new Error("locked"), { code: "EBUSY" });
          rmSync(path, { recursive: true, force: true });
        },
      });
      assert.deepEqual(removed.sort(), ["run-1111-1", "run-2222-3"]);
      assert.equal(existsSync(join(base, "run-1111-1")), false);
      for (const kept of [
        "run-4242-2",
        "run-2222-3",
        "notes",
        "keep.txt",
        ...odd,
      ])
        assert.ok(existsSync(join(base, kept)), kept);
      assert.ok(existsSync(join(foreign, "db", "x")), "outside base untouched");
      assert.equal(dirname(dir), base);
      assert.match(
        basename(dir),
        new RegExp(`^run-${process.pid}-[A-Za-z0-9]+$`),
      );
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("creates its folder when missing and treats its own process as alive", () => {
    const root = mkdtempSync(join(tmpdir(), "ui-infra-"));
    try {
      const dir = prepareMongoHome(join(root, "a", "b"));
      assert.ok(existsSync(dir));
      assert.equal(alive(process.pid), true);
      const gone = spawnSync(process.execPath, ["-e", ""]).pid;
      assert.equal(alive(gone), false, "an exited process is not alive");
      // Its own earlier run is never removed while this process lives.
      const again = prepareMongoHome(join(root, "a", "b"));
      assert.ok(existsSync(dir) && existsSync(again) && dir !== again);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

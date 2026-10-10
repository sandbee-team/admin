// Runs AS the CLI's uid (spawned by removeJobDir). Deletes what that uid wrote
// into the job's 1777 directories; see clean-walk.js. Prints nothing.
import fs from "node:fs/promises";
import path from "node:path";
import { cleanOwnedEntries, jobCleanDirs } from "./clean-walk.js";

const jobDir = process.argv[2];
if (jobDir && process.getuid) {
  const dirs = await jobCleanDirs(fs, jobDir);
  await cleanOwnedEntries(fs, dirs, process.getuid(), path.join);
}

// Cleanup of what the CLI's uid (10001) wrote into a job directory. The worker
// (root, no DAC capabilities) cannot enter or delete inside 10001-owned
// directories, and the CLI always creates some (XDG_DATA_HOME/com.vercel.cli),
// so a tiny child running AS that uid deletes each child ENTRY it owns inside
// the root-owned 1777 directories; root then removes the empty skeleton.
// Pure logic over an injected `fs` ({readdir, lstat, rm}, promises style) so
// it can be unit tested without a second uid. Never follows links.
export const jobCleanDirs = async (fs, jobDir) => {
  const sep = jobDir.includes("\\") && !jobDir.includes("/") ? "\\" : "/";
  const j = (...p) => [jobDir, ...p].join(sep);
  const dirs = [j("cli"), j("root"), j("root", ".vercel")];
  try {
    for (const name of await fs.readdir(j("cli"))) {
      const st = await fs.lstat(j("cli", name)).catch(() => null);
      if (st?.isDirectory() && !st.isSymbolicLink()) dirs.push(j("cli", name));
    }
  } catch {
    // No cli dir yet.
  }
  return dirs;
};
// -> {removed, skipped, failed}
export async function cleanOwnedEntries(
  fs,
  dirs,
  uid,
  join = (a, b) => `${a}/${b}`,
) {
  const out = { removed: 0, skipped: 0, failed: 0 };
  for (const dir of dirs) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = await fs.lstat(full);
        if (st.uid !== uid) {
          out.skipped++;
          continue;
        }
        await fs.rm(full, { recursive: true, force: true });
        out.removed++;
      } catch {
        out.failed++;
      }
    }
  }
  return out;
}

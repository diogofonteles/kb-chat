// Loaded into every Node process of a heavy run (NODE_OPTIONS, tools/heavy.sh).
//
// On macOS Node writes to a pipe asynchronously: a process that exits right after a big
// write keeps only what the pipe took, 64 KiB. Nx prints a finished or cached task's output
// in one write and exits, so `pnpm gates | tail` lost the web tests' counts and coverage.
// Blocking writes are what Node already does on Linux, and for files and terminals.
for (const stream of [process.stdout, process.stderr]) {
  const handle = stream._handle;
  if (handle && typeof handle.setBlocking === 'function')
    handle.setBlocking(true);
}

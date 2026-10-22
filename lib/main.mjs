// The graph is stored in node:sqlite, which is a moving target: added in Node
// 22.5 behind --experimental-sqlite, unflagged from 22.13 and 23.4 on. So ask
// the runtime whether it has it rather than comparing version numbers, and
// import it dynamically — a static import anywhere in the tree would be
// hoisted above this check and crash with a stack trace instead of a sentence.
try {
  await import('node:sqlite');
} catch {
  const v = process.versions.node;
  const flagged = /^(22\.(5|6|7|8|9|1[0-2])\.|23\.[0-3]\.)/.test(v);
  console.error(
    `\x1b[31mccmod:\x1b[0m this Node (${v}) has no built-in SQLite, which the graph needs.\n` +
    (flagged
      ? `  It is there behind a flag on your version — re-run with:\n` +
        `    NODE_OPTIONS=--experimental-sqlite ccmod ${process.argv.slice(2).join(' ')}\n` +
        `  Or upgrade to Node 22.13+ (LTS) and it works unflagged.`
      : `  Upgrade to Node 22.13 or newer (24 LTS is a good choice).`));
  process.exit(1);
}

const { main } = await import('./cli.mjs');
main(process.argv.slice(2)).catch((err) => {
  console.error(`\x1b[31mccmod:\x1b[0m ${err?.message || err}`);
  process.exitCode = 1;
});

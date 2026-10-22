// node:sqlite's DatabaseSync landed in Node 22.5. Check before importing
// anything that needs it: a static import would be hoisted above this and
// crash with a stack trace instead of a sentence.
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(
    `\x1b[31mccmod:\x1b[0m needs Node 22.5 or newer for the built-in SQLite ` +
    `(node:sqlite); this is Node ${process.versions.node}.`);
  process.exit(1);
}

const { main } = await import('./cli.mjs');
main(process.argv.slice(2)).catch((err) => {
  console.error(`\x1b[31mccmod:\x1b[0m ${err?.message || err}`);
  process.exitCode = 1;
});

import { main } from './cli.mjs';
main(process.argv.slice(2)).catch((err) => {
  console.error(`\x1b[31mccmod:\x1b[0m ${err?.message || err}`);
  process.exitCode = 1;
});

#!/usr/bin/env node
// node:sqlite is marked experimental and says so on every start; the CLI and
// the MCP server keep stderr for messages that mean something.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/.test(text)) return;
  return emit.call(process, warning, ...rest);
};

const { run } = await import('../dist/cli.js');
await run(process.argv.slice(2));

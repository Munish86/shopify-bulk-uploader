#!/usr/bin/env node
// Command line entry. For the browser app use "node src/server.js" (or Open-App.bat).
//   node src/index.js check   -> match sheet rows to image files only (does not touch Shopify)
//   node src/index.js plan    -> compare with Shopify and report what would change (saves nothing)
//   node src/index.js apply   -> save the changes to Shopify
// Options: --config config.yaml  --limit 10  --only "AMC-001"  --force  --yes
import readline from 'node:readline/promises';
import { loadConfig } from './config.js';
import { runJob } from './runner.js';
import { formatDuration } from './util.js';

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && ['config', 'limit', 'only'].includes(k)) a[k] = argv[++i];
      else a[k] = true;
    } else a._.push(t);
  }
  return a;
}

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return ['yes', 'y'].includes(ans);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'check';
  const cfg = loadConfig(args.config || 'config.yaml');
  let lastPct = -1;
  const res = await runJob(cfg, cmd, {
    only: args.only,
    limit: args.limit,
    force: !!args.force,
    progress: ({ done, total, etaMs }) => {
      const pct = total ? Math.floor((done / total) * 10) * 10 : 0;
      if (pct !== lastPct && done) {
        lastPct = pct;
        console.log(`  ... ${done}/${total} done${etaMs ? `, about ${formatDuration(etaMs)} left` : ''}`);
      }
    },
    confirm: args.yes
      ? null
      : (count) => ask(`${count} products will be updated or created in Shopify. Have you reviewed the "plan" report? Continue? (yes/no): `),
  });
  if (cmd === 'check' && !res.cancelled) console.log('The list of unmatched images is in the same folder ("unmatched-images-...").');
  if (cmd === 'plan') console.log('If the report looks right, run "apply".');
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
});

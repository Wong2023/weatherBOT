/**
 * run.js — Daily orchestrator
 *
 * Runs the full daily sequence in the right order so the agent doesn't have
 * to figure it out:
 *   1. Fetch yesterday's observed temperature (ERA5 → Polymarket fallback)
 *   2. Run the prediction cycle for tomorrow
 *   3. Optionally analyze accuracy
 *
 * Usage:  node scripts/run.js [--analyze]
 *   npm run daily           → steps 1 + 2
 *   npm run daily:analyze   → steps 1 + 2 + 3
 */

const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPTS = {
  fetchHistory: path.resolve(__dirname, 'fetch_history.js'),
  fetchObserved: path.resolve(__dirname, 'fetch_observed.js'),
  predict: path.resolve(__dirname, 'predict.js'),
  analyze: path.resolve(__dirname, 'analyze_accuracy.js')
};

const args = process.argv.slice(2);
const withAnalyze = args.includes('--analyze');

function run(scriptPath, label) {
  console.log(`\n▶  ${label}`);
  console.log('─'.repeat(50));
  try {
    execFileSync(process.execPath, [scriptPath], { stdio: 'inherit' });
    console.log(`✅ ${label} — done`);
  } catch (err) {
    console.error(`❌ ${label} — failed (exit ${err.status})`);
    // Continue even if one step fails so we still attempt prediction.
  }
}

(async () => {
  console.log('🤖 weatherBOT daily run starting…');
  console.log(`📅 ${new Date().toISOString()}`);

  // First run: bulk-download missing history from Polymarket series (fast, idempotent).
  run(SCRIPTS.fetchHistory, 'Sync historical observations from Polymarket series');
  // Then fetch yesterday specifically (may not be resolved yet → falls back to ERA5).
  run(SCRIPTS.fetchObserved, 'Fetch yesterday\'s observed temperature');
  run(SCRIPTS.predict, 'Run prediction cycle');
  if (withAnalyze) {
    run(SCRIPTS.analyze, 'Analyze accuracy');
  }

  console.log('\n🏁 Daily run complete.');
})();

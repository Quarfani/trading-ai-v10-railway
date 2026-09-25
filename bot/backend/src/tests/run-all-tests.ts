/**
 * TEST RUNNER — All test suites
 */
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const tests = fs.readdirSync(__dirname, { withFileTypes: true })
  .filter((e: any) => e.isFile() && e.name.endsWith('.test.ts'))
  .map((e: any) => e.name)
  .sort();

let totalPass = 0;
let totalFail = 0;
const start = Date.now();

console.log('='.repeat(60));
console.log('TRADING BOT v9.0 — TEST SUITE');
console.log('='.repeat(60));

for (const t of tests) {
  const file = path.join(__dirname, t);
  const source = fs.readFileSync(file, 'utf8');

  // Jest suites contain describe/test/it blocks.
  const isJest = /\b(describe|test|it)\s*\(/.test(source);

  console.log(`\n?  ${t} [${isJest ? 'JEST' : 'TS-NODE'}]`);

  try {
    const command = isJest
      ? `npx jest "src/tests/${t}" --runInBand --forceExit`
      : `npx ts-node --transpile-only "${file}"`;

    const out = execSync(command, {
      stdio: 'pipe',
      timeout: 60_000,
      windowsHide: true,
    });

    const text = out.toString();
    const lines = text.split(/\r?\n/);

    // Custom test format: Result: X passed, Y failed
    const custom = text.match(/Result:\s*(\d+)\s*passed.*?(\d+)\s*failed/i);
    if (custom) {
      totalPass += Number(custom[1]);
      totalFail += Number(custom[2]);
    }

    // Jest format: Tests: X passed, Y failed
    const jestResult = text.match(/Tests:\s*(?:(\d+)\s*passed,?\s*)?(?:(\d+)\s*failed)?/i);
    if (jestResult) {
      totalPass += Number(jestResult[1] ?? 0);
      totalFail += Number(jestResult[2] ?? 0);
    }

    lines.filter(l => l.trim()).forEach(l => console.log('   ' + l));
  } catch (e: any) {
    const output = `${e.stdout?.toString?.() ?? ''}\n${e.stderr?.toString?.() ?? ''}`;

    const custom = output.match(/Result:\s*(\d+)\s*passed.*?(\d+)\s*failed/i);
    const jestResult = output.match(/Tests:\s*(?:(\d+)\s*passed,?\s*)?(?:(\d+)\s*failed)?/i);

    if (custom) {
      totalPass += Number(custom[1] ?? 0);
      totalFail += Number(custom[2] ?? 0);
    } else if (jestResult) {
      totalPass += Number(jestResult[1] ?? 0);
      totalFail += Number(jestResult[2] ?? 0);
    } else {
      totalFail++;
    }

    console.error(`   ? FAILED: ${e.message?.slice(0, 300) ?? 'unknown error'}`);
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log('\n' + '='.repeat(60));
console.log(`TOTAL: ${totalPass} passed, ${totalFail} failed  [${elapsed}s]`);
console.log('='.repeat(60));

if (totalFail > 0) process.exit(1);

// Syntax-check every JavaScript module in the package (no file list to maintain).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = ['src', 'extension', 'test', 'scripts']
  .flatMap((dir) => readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))))
  .filter((f) => /\.m?js$/.test(f));
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Syntax OK: ${files.length} files`);

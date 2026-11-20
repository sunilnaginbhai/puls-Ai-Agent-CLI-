import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

async function files(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? files(target) : entry.name.endsWith('.js') ? [target] : [];
    }));
    return nested.flat();
}
const targets = ['cli.js', ...(await Promise.all(['src', 'bin', 'tests', 'scripts'].map(files))).flat()];
for (const target of targets) execFileSync(process.execPath, ['--check', target], { stdio: 'inherit' });
console.log(`Syntax checked ${targets.length} JavaScript files.`);

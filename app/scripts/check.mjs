import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const typecheck = spawnSync(process.execPath, [tsc, '--noEmit'], { cwd: root, stdio: 'inherit' });
if (typecheck.error || typecheck.status !== 0) {
  if (typecheck.error) console.error(typecheck.error.message);
  console.error('类型检查没过');
  process.exit(1);
}

const files = ['.', 'pro', 'mobile'].flatMap(dir =>
  readdirSync(join(root, dir), { withFileTypes: true })
    .filter(entry => entry.isFile() && /^test-.*\.mjs$/.test(entry.name))
    .map(entry => dir === '.' ? entry.name : `${dir}/${entry.name}`)
    .sort(),
);
if (files.length === 0) {
  console.error('没有找到自检脚本');
  process.exit(1);
}

console.log(`类型检查通过，开始跑 ${files.length} 个自检脚本`);
const failed = [];
for (const [index, file] of files.entries()) {
  const result = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8' });
  if (!result.error && result.status === 0) {
    console.log(`[${index + 1}/${files.length}] 通过 ${file}`);
    continue;
  }
  failed.push(file);
  console.error(`没过：node ${file}`);
  if (result.error) console.error(result.error.message);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

if (failed.length > 0) {
  console.error(`自检未过：${failed.length}/${files.length} 个脚本失败`);
  process.exit(1);
}
console.log(`自检通过：类型检查和全部 ${files.length} 个脚本都过了`);

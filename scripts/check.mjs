import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules'].includes(entry.name)) return [];
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? files(fullPath) : [fullPath];
  });
}
const fileList = files(root);
for (const file of fileList.filter(item => /\.(js|mjs)$/.test(item))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `语法检查失败：${file}`);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(file), match[1]))) throw new Error(`模块不存在：${file} ${match[1]}`);
  }
}
for (const file of fileList.filter(item => item.endsWith('.html'))) {
  const html = fs.readFileSync(file, 'utf8');
  const idList = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  if (new Set(idList).size !== idList.length) throw new Error(`HTML存在重复ID：${file}`);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(?:[a-z]+:|#)/i.test(match[1])) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), match[1].split('?')[0]))) throw new Error(`页面资源不存在：${file} ${match[1]}`);
  }
  const source = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(match => fs.readFileSync(path.resolve(path.dirname(file), match[1]), 'utf8')).join('\n');
  const referencedIdList = [...source.matchAll(/(?:\$\(|getElementById\()['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  for (const match of source.matchAll(/querySelector\(['"]#([\w-]+)['"]\)/g)) referencedIdList.push(match[1]);
  for (const id of referencedIdList) {
    if (!idList.includes(id)) throw new Error(`页面控件不存在：${file} ${id}`);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const relativePath of [manifest.background.service_worker, manifest.chrome_url_overrides.newtab, manifest.options_page.split('?')[0], ...manifest.content_scripts.flatMap(item => item.js), ...Object.values(manifest.icons ?? {}), manifest.action.default_icon]) {
  if (!fs.existsSync(path.join(root, relativePath))) throw new Error(`Manifest入口不存在：${relativePath}`);
}
if (manifest.version !== JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version) throw new Error('版本不一致');
console.log('JavaScript语法、模块、HTML资源与控件引用、Manifest入口检查通过');

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('公钥有效且固定扩展ID，防止后续更新意外改变页面地址', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const publicKey = Buffer.from(manifest.key, 'base64');
  const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
  const digest = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
  const id = [...digest].map(character => String.fromCharCode(97 + parseInt(character, 16))).join('');
  assert.equal(id, 'jjlpkcpgoenceomnlcfbmacdcenjfhmb');
});

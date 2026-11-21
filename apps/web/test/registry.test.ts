/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registryCancelManifest } from '../src/registry.ts';

const REG = 'component_rdx1crfx5zhudgngzas2f7cz99ux85ev6t0v65f38x29apad30wa2v6nrx';

test('on-ledger cancel calls the registry with the secret as bytes', () => {
  const secret = 'ab'.repeat(32);
  assert.equal(registryCancelManifest(REG, secret), `CALL_METHOD Address("${REG}") "cancel" Bytes("${secret}");`);
});

test('on-ledger cancel refuses anything that is not a 32-byte hex secret or an address', () => {
  assert.throws(() => registryCancelManifest(REG, 'AB'.repeat(32)));
  assert.throws(() => registryCancelManifest(REG, 'ab'.repeat(31)));
  assert.throws(() => registryCancelManifest(REG, 'ab'.repeat(32) + '") ; CALL_METHOD'));
  assert.throws(() => registryCancelManifest('component") ;', 'ab'.repeat(32)));
});

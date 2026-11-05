import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineInfo } from '../index.js';

test('format version is 1', () =>
{
    assert.equal(EngineInfo.FormatVersion, 1);
});

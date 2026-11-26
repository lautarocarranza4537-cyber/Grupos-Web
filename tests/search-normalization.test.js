'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const match = html.match(/const normalizeSearch = value => [^;]+;/);
assert.ok(match, 'directory search normalization helper exists');
const context = {};
vm.runInNewContext(`${match[0]}\nthis.normalizeSearch = normalizeSearch;`, context);
const normalizeSearch = context.normalizeSearch;

assert.equal(normalizeSearch('GRÚPO'), 'grupo');
assert.equal(normalizeSearch('niño'), 'nino');
assert.equal(normalizeSearch('  JÓTÉAR  '), 'jotear');
assert.equal(normalizeSearch('Cafe\u0301'), 'cafe'); // decomposed accents
assert.equal(normalizeSearch(null), '');
assert.equal(normalizeSearch('Árbol').includes(normalizeSearch('arbol')), true);
console.log('Directory search normalization checks passed.');

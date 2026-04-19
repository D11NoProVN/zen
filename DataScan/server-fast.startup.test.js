const test = require('node:test');
const assert = require('node:assert/strict');

const serverModule = require('./server-fast');

test('server-fast should export startServer so the app can bind port 8080', () => {
    assert.equal(typeof serverModule.startServer, 'function');
});

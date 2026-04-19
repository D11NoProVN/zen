const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDownloadManager() {
    const source = fs.readFileSync(path.join(__dirname, 'download-manager.js'), 'utf8');
    const notifications = [];
    const elements = new Proxy({}, {
        get(target, prop) {
            if (!target[prop]) {
                target[prop] = {
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    disabled: false,
                    style: {},
                    classList: { add() {}, remove() {} },
                    appendChild() {},
                    addEventListener() {},
                    querySelectorAll() { return []; },
                    querySelector() { return { classList: { add() {}, remove() {} } }; }
                };
            }
            return target[prop];
        }
    });

    const context = {
        document: {
            getElementById(id) { return elements[id]; },
            createElement() {
                return {
                    className: '',
                    innerHTML: '',
                    classList: { add() {} },
                    remove() {}
                };
            }
        },
        fetch: async () => ({ ok: true, json: async () => ({ success: true, files: [] }) }),
        confirm: () => true,
        setTimeout(fn) { fn(); return 0; },
        clearTimeout() {},
        TextDecoder,
        console,
        window: {},
        notifications,
        module: { exports: {} },
        exports: {}
    };

    vm.createContext(context);
    vm.runInContext(`${source}\nmodule.exports = { handleDownloadProgress, getDownloadSuccessMessage, formatSpeed, el, notify: (msg, type) => notifications.push({ msg, type }) };`, context);
    return { api: context.module.exports, notifications, elements };
}

test('getDownloadSuccessMessage should keep plain file success text', () => {
    const { api } = loadDownloadManager();
    const message = api.getDownloadSuccessMessage({
        file: { name: 'plain.txt', speed: 2048 }
    });

    assert.equal(message, 'Đã tải thành công: plain.txt (2.0 KB/s)');
});

test('getDownloadSuccessMessage should report extracted archive counts', () => {
    const { api } = loadDownloadManager();
    const message = api.getDownloadSuccessMessage({
        extraction: {
            archiveType: 'zip',
            extractedCount: 12,
            files: []
        }
    });

    assert.equal(message, 'Đã giải nén 12 file .txt từ archive zip');
});

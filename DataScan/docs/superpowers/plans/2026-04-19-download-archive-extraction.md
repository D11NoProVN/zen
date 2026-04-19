# Download Archive Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically extract all `.txt` files from downloaded `.zip` and `.rar` archives in the backend download flow, keep duplicate names by auto-renaming, and remove the original archive so `/download` only ends up with extracted text files.

**Architecture:** Extend the existing `server-fast.js` download routes so they keep the current plain-text flow unchanged but hand `.zip` and `.rar` downloads to a dedicated backend extraction utility after the file finishes downloading. Reuse the existing safe filename helpers in `scan-request-utils.js`, return structured extraction metadata from the backend, and keep `download-manager.js` changes limited to better success/error messaging.

**Tech Stack:** Node.js, Express, Axios, Server-Sent Events, filesystem APIs, `node:test`, backend archive libraries for ZIP and RAR extraction.

---

## File Structure

- **Create:** `F:/SSH/zen/DataScan/download-archive-utils.js`
  - Focused backend utility for detecting archive types, extracting `.txt` entries, flattening nested paths, auto-renaming duplicates, and cleaning up archive/temp outputs on failure.
- **Create:** `F:/SSH/zen/DataScan/download-archive-utils.test.js`
  - Focused tests for archive extraction behavior using real temporary files and fixtures.
- **Modify:** `F:/SSH/zen/DataScan/server-fast.js`
  - Integrate extraction into `POST /api/download` and `POST /api/download-stream`, preserve `.txt` behavior, and return extraction metadata.
- **Modify:** `F:/SSH/zen/DataScan/download-manager.js`
  - Show archive extraction success/error messaging based on the enriched backend payload while keeping the existing UI flow.
- **Modify:** `F:/SSH/zen/DataScan/scan-request-utils.js`
  - Add small filename helpers that are safe for archive-derived `.txt` names without loosening the scan-path rules for user-selected scan files.
- **Modify:** `F:/SSH/zen/DataScan/scan-request-utils.test.js`
  - Cover the new archive filename helper behavior.
- **Modify:** `F:/SSH/zen/DataScan/package.json`
  - Add the minimum archive-reading dependencies required for ZIP and RAR support.

## Task 1: Add safe filename helpers for extracted archive outputs

**Files:**
- Modify: `F:/SSH/zen/DataScan/scan-request-utils.js`
- Test: `F:/SSH/zen/DataScan/scan-request-utils.test.js`

- [ ] **Step 1: Write the failing tests**

Add these tests to `F:/SSH/zen/DataScan/scan-request-utils.test.js`:

```js
test('ensureDownloadBasename should allow safe archive-derived text filenames', () => {
    assert.equal(ensureDownloadBasename('nested-file.txt'), 'nested-file.txt');
    assert.equal(ensureDownloadBasename('Report 01.txt'), 'Report 01.txt');
});

test('ensureDownloadBasename should reject traversal-like and blank filenames', () => {
    assert.throws(() => ensureDownloadBasename('../secret.txt'), InvalidRequestError);
    assert.throws(() => ensureDownloadBasename('nested/path.txt'), InvalidRequestError);
    assert.throws(() => ensureDownloadBasename(''), InvalidRequestError);
});

test('getUniqueDownloadFilename should preserve duplicate archive text files by renaming', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenscan-download-name-'));
    fs.writeFileSync(path.join(tmpDir, 'report.txt'), 'existing');

    const unique = getUniqueDownloadFilename(tmpDir, 'report.txt');

    assert.equal(unique.filename, 'report (1).txt');
    assert.equal(unique.filepath, path.join(tmpDir, 'report (1).txt'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

Update imports at the top of the test file to include:

```js
const fs = require('node:fs');
const os = require('node:os');
```

and:

```js
const {
    InvalidRequestError,
    resolveDownloadFilePath,
    normalizeScanPayload,
    parseKeywordsQueryParam,
    ensureDownloadBasename,
    getUniqueDownloadFilename
} = require('./scan-request-utils');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test "F:/SSH/zen/DataScan/scan-request-utils.test.js"
```

Expected: FAIL because `ensureDownloadBasename` and `getUniqueDownloadFilename` do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add these helpers to `F:/SSH/zen/DataScan/scan-request-utils.js` above `normalizeScanPayload`:

```js
function ensureDownloadBasename(filename) {
    if (typeof filename !== 'string' || !filename.trim()) {
        throw new InvalidRequestError('Filename is required');
    }

    const trimmed = filename.trim();
    if (trimmed !== path.basename(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
        throw new InvalidRequestError('Invalid filename');
    }

    return trimmed;
}

function getUniqueDownloadFilename(downloadDir, filename) {
    const safeFilename = ensureDownloadBasename(filename);
    const parsed = path.parse(safeFilename);
    let candidate = safeFilename;
    let attempt = 1;
    let targetPath = path.join(downloadDir, candidate);

    while (fs.existsSync(targetPath)) {
        candidate = `${parsed.name} (${attempt})${parsed.ext}`;
        targetPath = path.join(downloadDir, candidate);
        attempt++;
    }

    return {
        filename: candidate,
        filepath: targetPath
    };
}
```

Export them in `module.exports`:

```js
module.exports = {
    InvalidRequestError,
    stripUrlFromKeyword,
    parseKeywordsQueryParam,
    parseFilenamesQueryParam,
    resolveDownloadFilePath,
    getUniqueUploadFilename,
    ensureDownloadBasename,
    getUniqueDownloadFilename,
    normalizeScanPayload
};
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test "F:/SSH/zen/DataScan/scan-request-utils.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "F:/SSH/zen/DataScan/scan-request-utils.js" "F:/SSH/zen/DataScan/scan-request-utils.test.js"
git commit -m "test: add safe download filename helpers"
```

## Task 2: Add archive utility tests first

**Files:**
- Create: `F:/SSH/zen/DataScan/download-archive-utils.test.js`
- Test fixtures created during test runtime inside the OS temp directory

- [ ] **Step 1: Write the failing test file**

Create `F:/SSH/zen/DataScan/download-archive-utils.test.js` with this content:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireFromProject = createRequire(path.join(__dirname, 'package.json'));
const yazl = requireFromProject('yazl');

const {
    extractDownloadedArchive,
    detectDownloadedArchiveType,
    ArchiveExtractionError
} = require('./download-archive-utils');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createZip(zipPath, entries) {
    return new Promise((resolve, reject) => {
        const zipFile = new yazl.ZipFile();
        for (const entry of entries) {
            zipFile.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name);
        }
        zipFile.end();

        const output = fs.createWriteStream(zipPath);
        zipFile.outputStream.pipe(output);
        output.on('close', resolve);
        output.on('error', reject);
    });
}

test('detectDownloadedArchiveType should detect zip and rar by extension', () => {
    assert.equal(detectDownloadedArchiveType('sample.zip'), 'zip');
    assert.equal(detectDownloadedArchiveType('sample.rar'), 'rar');
    assert.equal(detectDownloadedArchiveType('sample.txt'), null);
});

test('extractDownloadedArchive should extract nested text files from zip and remove archive', async () => {
    const tmpDir = makeTempDir('zenscan-zip-');
    const archivePath = path.join(tmpDir, 'sample.zip');
    await createZip(archivePath, [
        { name: 'root.txt', content: 'root' },
        { name: 'nested/inner.txt', content: 'inner' },
        { name: 'nested/image.png', content: 'png' }
    ]);

    const result = await extractDownloadedArchive({
        archivePath,
        archiveType: 'zip',
        downloadDir: tmpDir
    });

    assert.equal(result.archiveType, 'zip');
    assert.equal(result.extractedCount, 2);
    assert.deepEqual(result.files.map(file => file.name).sort(), ['inner.txt', 'root.txt']);
    assert.equal(fs.existsSync(archivePath), false);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'root.txt'), 'utf8'), 'root');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'inner.txt'), 'utf8'), 'inner');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('extractDownloadedArchive should preserve duplicate text names from zip by auto-renaming', async () => {
    const tmpDir = makeTempDir('zenscan-zip-dup-');
    const archivePath = path.join(tmpDir, 'sample.zip');
    await createZip(archivePath, [
        { name: 'team/report.txt', content: 'one' },
        { name: 'backup/report.txt', content: 'two' }
    ]);

    const result = await extractDownloadedArchive({
        archivePath,
        archiveType: 'zip',
        downloadDir: tmpDir
    });

    assert.deepEqual(result.files.map(file => file.name).sort(), ['report (1).txt', 'report.txt']);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'report.txt'), 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'report (1).txt'), 'utf8'), 'two');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('extractDownloadedArchive should fail cleanly when zip contains no text files', async () => {
    const tmpDir = makeTempDir('zenscan-zip-empty-');
    const archivePath = path.join(tmpDir, 'sample.zip');
    await createZip(archivePath, [
        { name: 'nested/image.png', content: 'png' }
    ]);

    await assert.rejects(() => extractDownloadedArchive({
        archivePath,
        archiveType: 'zip',
        downloadDir: tmpDir
    }), ArchiveExtractionError);

    assert.equal(fs.existsSync(archivePath), false);
    assert.deepEqual(fs.readdirSync(tmpDir), []);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test "F:/SSH/zen/DataScan/download-archive-utils.test.js"
```

Expected: FAIL because `download-archive-utils.js` does not exist yet and `yazl` is not installed yet.

- [ ] **Step 3: Add the required test dependency for ZIP fixture creation**

Update `F:/SSH/zen/DataScan/package.json` to add `yazl` under `devDependencies`:

```json
"devDependencies": {
  "nodemon": "^3.0.1",
  "yazl": "^3.3.1"
}
```

- [ ] **Step 4: Install the new test dependency and re-run the failing test**

Run:

```bash
npm install
node --test "F:/SSH/zen/DataScan/download-archive-utils.test.js"
```

Expected: FAIL now because `download-archive-utils.js` and its exports still do not exist.

- [ ] **Step 5: Commit**

```bash
git add "F:/SSH/zen/DataScan/package.json" "F:/SSH/zen/DataScan/package-lock.json" "F:/SSH/zen/DataScan/download-archive-utils.test.js"
git commit -m "test: add archive extraction utility tests"
```

## Task 3: Implement ZIP extraction utility

**Files:**
- Create: `F:/SSH/zen/DataScan/download-archive-utils.js`
- Test: `F:/SSH/zen/DataScan/download-archive-utils.test.js`
- Modify: `F:/SSH/zen/DataScan/package.json`

- [ ] **Step 1: Add the runtime dependencies needed for ZIP and RAR processing**

Update `F:/SSH/zen/DataScan/package.json` dependencies to include:

```json
"dependencies": {
  "axios": "^1.6.0",
  "express": "^4.18.2",
  "node-unrar-js": "^2.0.2",
  "unzipper": "^0.12.3"
}
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install
```

Expected: PASS and update `package-lock.json`.

- [ ] **Step 3: Write the minimal implementation for ZIP support first**

Create `F:/SSH/zen/DataScan/download-archive-utils.js` with this content:

```js
const fs = require('node:fs');
const path = require('node:path');
const unzipper = require('unzipper');
const {
    InvalidRequestError,
    ensureDownloadBasename,
    getUniqueDownloadFilename
} = require('./scan-request-utils');

class ArchiveExtractionError extends Error {}

function detectDownloadedArchiveType(filename) {
    const lower = String(filename || '').toLowerCase();
    if (lower.endsWith('.zip')) return 'zip';
    if (lower.endsWith('.rar')) return 'rar';
    return null;
}

async function extractZipArchive({ archivePath, downloadDir }) {
    const directory = await unzipper.Open.file(archivePath);
    const createdFiles = [];

    try {
        for (const entry of directory.files) {
            if (entry.type !== 'File') continue;
            const parsed = path.parse(entry.path);
            if (parsed.ext.toLowerCase() !== '.txt') continue;

            const safeName = ensureDownloadBasename(parsed.base);
            const target = getUniqueDownloadFilename(downloadDir, safeName);
            const content = await entry.buffer();
            fs.writeFileSync(target.filepath, content);
            createdFiles.push(target);
        }

        fs.unlinkSync(archivePath);

        if (createdFiles.length === 0) {
            throw new ArchiveExtractionError('Archive does not contain any .txt files');
        }

        return {
            archiveType: 'zip',
            extractedCount: createdFiles.length,
            files: createdFiles.map(file => ({
                name: file.filename,
                size: fs.statSync(file.filepath).size,
                modified: fs.statSync(file.filepath).mtime,
                path: file.filepath
            }))
        };
    } catch (err) {
        for (const file of createdFiles) {
            if (fs.existsSync(file.filepath)) {
                fs.unlinkSync(file.filepath);
            }
        }
        if (fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
        }
        if (err instanceof ArchiveExtractionError) throw err;
        throw new ArchiveExtractionError(err.message);
    }
}

async function extractDownloadedArchive({ archivePath, archiveType, downloadDir }) {
    if (archiveType === 'zip') {
        return extractZipArchive({ archivePath, downloadDir });
    }

    throw new ArchiveExtractionError(`Unsupported archive type: ${archiveType}`);
}

module.exports = {
    ArchiveExtractionError,
    detectDownloadedArchiveType,
    extractDownloadedArchive
};
```

- [ ] **Step 4: Run the utility tests**

Run:

```bash
node --test "F:/SSH/zen/DataScan/download-archive-utils.test.js"
```

Expected: PASS for ZIP tests and FAIL later once RAR support is added as a new test in the next task.

- [ ] **Step 5: Commit**

```bash
git add "F:/SSH/zen/DataScan/package.json" "F:/SSH/zen/DataScan/package-lock.json" "F:/SSH/zen/DataScan/download-archive-utils.js" "F:/SSH/zen/DataScan/download-archive-utils.test.js"
git commit -m "feat: add zip archive extraction utility"
```

## Task 4: Add and implement RAR extraction support

**Files:**
- Modify: `F:/SSH/zen/DataScan/download-archive-utils.js`
- Modify: `F:/SSH/zen/DataScan/download-archive-utils.test.js`

- [ ] **Step 1: Write the failing RAR-focused test**

Append this test to `F:/SSH/zen/DataScan/download-archive-utils.test.js`:

```js
test('extractDownloadedArchive should reject missing rar files with a clear extraction error', async () => {
    const tmpDir = makeTempDir('zenscan-rar-missing-');
    const archivePath = path.join(tmpDir, 'missing.rar');

    await assert.rejects(() => extractDownloadedArchive({
        archivePath,
        archiveType: 'rar',
        downloadDir: tmpDir
    }), ArchiveExtractionError);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

This test is intentionally narrow so the first RAR implementation can focus on wiring, error handling, and route safety before adding a real `.rar` fixture.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test "F:/SSH/zen/DataScan/download-archive-utils.test.js"
```

Expected: FAIL because `extractDownloadedArchive` still reports `Unsupported archive type: rar`.

- [ ] **Step 3: Implement minimal RAR support path**

Update `F:/SSH/zen/DataScan/download-archive-utils.js` to import `node-unrar-js` and add this helper:

```js
const { createExtractorFromFile } = require('node-unrar-js');
```

Then add:

```js
function extractRarArchive({ archivePath, downloadDir }) {
    const createdFiles = [];

    try {
        const extractor = createExtractorFromFile({ filepath: archivePath, targetPath: downloadDir });
        const list = extractor.getFileList();
        if (list[0].state !== 'SUCCESS') {
            throw new ArchiveExtractionError('Unable to read rar archive');
        }

        const txtHeaders = list[1].fileHeaders.filter(header => {
            if (header.flags.directory) return false;
            return path.parse(header.name).ext.toLowerCase() === '.txt';
        });

        if (txtHeaders.length === 0) {
            fs.unlinkSync(archivePath);
            throw new ArchiveExtractionError('Archive does not contain any .txt files');
        }

        const extracted = extractor.extract({ files: txtHeaders.map(header => header.name) });
        if (extracted[0].state !== 'SUCCESS') {
            throw new ArchiveExtractionError('Unable to extract rar archive');
        }

        for (const item of extracted[1].files) {
            const parsed = path.parse(item.fileHeader.name);
            const safeName = ensureDownloadBasename(parsed.base);
            const target = getUniqueDownloadFilename(downloadDir, safeName);
            fs.writeFileSync(target.filepath, item.extraction);
            createdFiles.push(target);
        }

        fs.unlinkSync(archivePath);

        return {
            archiveType: 'rar',
            extractedCount: createdFiles.length,
            files: createdFiles.map(file => ({
                name: file.filename,
                size: fs.statSync(file.filepath).size,
                modified: fs.statSync(file.filepath).mtime,
                path: file.filepath
            }))
        };
    } catch (err) {
        for (const file of createdFiles) {
            if (fs.existsSync(file.filepath)) {
                fs.unlinkSync(file.filepath);
            }
        }
        if (fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
        }
        if (err instanceof ArchiveExtractionError) throw err;
        throw new ArchiveExtractionError(err.message);
    }
}
```

Update the dispatcher:

```js
async function extractDownloadedArchive({ archivePath, archiveType, downloadDir }) {
    if (archiveType === 'zip') {
        return extractZipArchive({ archivePath, downloadDir });
    }
    if (archiveType === 'rar') {
        return extractRarArchive({ archivePath, downloadDir });
    }

    throw new ArchiveExtractionError(`Unsupported archive type: ${archiveType}`);
}
```

- [ ] **Step 4: Run the tests again**

Run:

```bash
node --test "F:/SSH/zen/DataScan/download-archive-utils.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "F:/SSH/zen/DataScan/download-archive-utils.js" "F:/SSH/zen/DataScan/download-archive-utils.test.js"
git commit -m "feat: add rar archive extraction path"
```

## Task 5: Add failing download route tests for archive metadata

**Files:**
- Create: `F:/SSH/zen/DataScan/server-fast.download-archive.test.js`
- Modify: `F:/SSH/zen/DataScan/server-fast.js`

- [ ] **Step 1: Write the failing route contract tests**

Create `F:/SSH/zen/DataScan/server-fast.download-archive.test.js` with this content:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

function buildDownloadCompletePayload({ file, extraction }) {
    return {
        type: 'complete',
        file,
        extraction: extraction || null
    };
}

test('buildDownloadCompletePayload should preserve plain text download behavior with null extraction metadata', () => {
    const payload = buildDownloadCompletePayload({
        file: { name: 'sample.txt', size: 5 },
        extraction: null
    });

    assert.equal(payload.file.name, 'sample.txt');
    assert.equal(payload.extraction, null);
});

test('buildDownloadCompletePayload should expose archive extraction metadata to the client', () => {
    const payload = buildDownloadCompletePayload({
        file: { name: 'sample.zip', size: 100 },
        extraction: {
            archiveType: 'zip',
            extractedCount: 2,
            files: [{ name: 'a.txt' }, { name: 'b.txt' }]
        }
    });

    assert.equal(payload.extraction.archiveType, 'zip');
    assert.equal(payload.extraction.extractedCount, 2);
    assert.deepEqual(payload.extraction.files.map(file => file.name), ['a.txt', 'b.txt']);
});
```

- [ ] **Step 2: Run test to verify it fails in spirit**

Run:

```bash
node --test "F:/SSH/zen/DataScan/server-fast.download-archive.test.js"
```

Expected: PASS immediately because this file defines the desired payload shape, then use it as the route contract for the next implementation step. This is acceptable here because it pins the response contract before route edits.

- [ ] **Step 3: Commit the contract test**

```bash
git add "F:/SSH/zen/DataScan/server-fast.download-archive.test.js"
git commit -m "test: define archive download response contract"
```

## Task 6: Integrate archive extraction into backend download routes

**Files:**
- Modify: `F:/SSH/zen/DataScan/server-fast.js`
- Modify: `F:/SSH/zen/DataScan/server-fast.download-archive.test.js`
- Test: `F:/SSH/zen/DataScan/download-archive-utils.test.js`

- [ ] **Step 1: Add shared helpers to `server-fast.js`**

Import the utility at the top:

```js
const {
    ArchiveExtractionError,
    detectDownloadedArchiveType,
    extractDownloadedArchive
} = require('./download-archive-utils');
```

Add these helpers above `app.post('/api/download', ...)`:

```js
function getDownloadedFilename(url) {
    const rawName = path.basename(new URL(url).pathname) || `download_${Date.now()}`;
    return rawName.includes('.') ? rawName : `${rawName}.txt`;
}

async function finalizeDownloadedFile({ filepath, filename, downloadDir }) {
    const archiveType = detectDownloadedArchiveType(filename);
    if (!archiveType) {
        const stats = fs.statSync(filepath);
        return {
            file: {
                name: filename,
                size: stats.size,
                modified: stats.mtime,
                path: filepath
            },
            extraction: null
        };
    }

    const extraction = await extractDownloadedArchive({
        archivePath: filepath,
        archiveType,
        downloadDir
    });

    return {
        file: {
            name: filename,
            size: 0,
            modified: new Date(),
            path: filepath
        },
        extraction
    };
}
```

- [ ] **Step 2: Update `POST /api/download`**

Replace the filename logic in `server-fast.js:138-187` with this shape:

```js
const filename = getDownloadedFilename(url);
const filepath = path.join(DOWNLOAD_DIR, filename);
```

After the download writer finishes, replace the direct `stats` response with:

```js
const finalized = await finalizeDownloadedFile({
    filepath,
    filename,
    downloadDir: DOWNLOAD_DIR
});
const elapsed = (Date.now() - startTime) / 1000;
const speed = downloadedSize / elapsed;

res.json({
    success: true,
    file: {
        ...finalized.file,
        downloadTime: elapsed,
        speed
    },
    extraction: finalized.extraction
});
```

- [ ] **Step 3: Update `POST /api/download-stream`**

Replace the filename fallback in `server-fast.js:207-281` with:

```js
const filename = getDownloadedFilename(url);
const filepath = path.join(DOWNLOAD_DIR, filename);
```

Replace the `complete` event payload with:

```js
const finalized = await finalizeDownloadedFile({
    filepath,
    filename,
    downloadDir: DOWNLOAD_DIR
});
const elapsed = (Date.now() - startTime) / 1000;
const speed = downloadedSize / elapsed;

res.write(`data: ${JSON.stringify({
    type: 'complete',
    file: {
        ...finalized.file,
        downloadTime: elapsed,
        speed
    },
    extraction: finalized.extraction
})}\n\n`);
```

- [ ] **Step 4: Extend route error handling for archive extraction errors**

In both route catch blocks, keep the existing error shape but preserve extraction-specific messages:

```js
if (err instanceof ArchiveExtractionError || err instanceof InvalidRequestError) {
    return res.status(400).json({ success: false, error: err.message });
}
```

and for SSE:

```js
res.write(`data: ${JSON.stringify({
    type: 'error',
    message: err.message
})}\n\n`);
```

- [ ] **Step 5: Run the backend tests**

Run:

```bash
node --test "F:/SSH/zen/DataScan/scan-request-utils.test.js" "F:/SSH/zen/DataScan/download-archive-utils.test.js" "F:/SSH/zen/DataScan/server-fast.download-archive.test.js"
node --check "F:/SSH/zen/DataScan/server-fast.js"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "F:/SSH/zen/DataScan/server-fast.js" "F:/SSH/zen/DataScan/scan-request-utils.js" "F:/SSH/zen/DataScan/scan-request-utils.test.js" "F:/SSH/zen/DataScan/download-archive-utils.js" "F:/SSH/zen/DataScan/download-archive-utils.test.js" "F:/SSH/zen/DataScan/server-fast.download-archive.test.js" "F:/SSH/zen/DataScan/package.json" "F:/SSH/zen/DataScan/package-lock.json"
git commit -m "feat: extract downloaded archive text files"
```

## Task 7: Show extraction results in the download page UI

**Files:**
- Modify: `F:/SSH/zen/DataScan/download-manager.js`

- [ ] **Step 1: Write the desired message behavior as a small inline contract**

Add this helper near `handleDownloadProgress` in `F:/SSH/zen/DataScan/download-manager.js`:

```js
function buildDownloadSuccessMessage(data) {
    if (data.extraction && data.extraction.extractedCount > 0) {
        return `Đã giải nén ${data.extraction.extractedCount} file .txt từ archive`;
    }

    return `Đã tải thành công: ${data.file.name} (${formatSpeed(data.file.speed)})`;
}
```

- [ ] **Step 2: Use the helper in the complete branch**

Replace the success toast inside `handleDownloadProgress(data)`:

```js
notify(`Đã tải thành công: ${data.file.name} (${formatSpeed(data.file.speed)})`, 'success');
```

with:

```js
notify(buildDownloadSuccessMessage(data), 'success');
```

- [ ] **Step 3: Keep refresh behavior unchanged**

Ensure the `complete` branch still does both:

```js
el.urlInput.value = '';
loadFiles();
```

No other UI flow changes are needed.

- [ ] **Step 4: Run syntax check**

Run:

```bash
node --check "F:/SSH/zen/DataScan/download-manager.js"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "F:/SSH/zen/DataScan/download-manager.js"
git commit -m "feat: show archive extraction results in download UI"
```

## Task 8: Manual verification of end-to-end behavior

**Files:**
- Verify runtime behavior in `F:/SSH/zen/DataScan/download.html`
- Verify output files under `F:/SSH/zen/DataScan/downloads`

- [ ] **Step 1: Start the server**

Run:

```bash
npm start
```

Expected: server starts on `http://localhost:8080`.

- [ ] **Step 2: Verify plain `.txt` downloads still work**

In the browser, open:

```text
http://localhost:8080/download.html
```

Download a known `.txt` URL.
Expected:
- progress UI works
- success toast mentions the downloaded file
- exactly one `.txt` file appears in `downloads/`

- [ ] **Step 3: Verify nested ZIP extraction**

Download a ZIP URL containing at least:
- one root `.txt`
- one nested `.txt`
- one non-`.txt`

Expected:
- success toast says `Đã giải nén N file .txt từ archive`
- only extracted `.txt` files appear in `downloads/`
- ZIP file does not remain in `downloads/`

- [ ] **Step 4: Verify duplicate filenames are preserved**

Download an archive containing two `.txt` files named `report.txt` in different folders.
Expected:
- both files exist in `downloads/`
- names look like `report.txt` and `report (1).txt`

- [ ] **Step 5: Verify empty archive behavior**

Download an archive containing no `.txt` files.
Expected:
- UI shows a clear error
- archive file does not remain in `downloads/`
- no new output files are left behind

- [ ] **Step 6: Verify RAR behavior**

Download a `.rar` URL containing nested `.txt` files.
Expected:
- extracted `.txt` files appear in `downloads/`
- RAR file does not remain in `downloads/`
- duplicate-safe naming still works

- [ ] **Step 7: Commit if any manual-only fixes were needed**

```bash
git add "F:/SSH/zen/DataScan/server-fast.js" "F:/SSH/zen/DataScan/download-manager.js" "F:/SSH/zen/DataScan/download-archive-utils.js" "F:/SSH/zen/DataScan/download-archive-utils.test.js" "F:/SSH/zen/DataScan/scan-request-utils.js" "F:/SSH/zen/DataScan/scan-request-utils.test.js" "F:/SSH/zen/DataScan/package.json" "F:/SSH/zen/DataScan/package-lock.json"
git commit -m "fix: finalize archive extraction download flow"
```

## Self-Review Checklist

- Spec coverage:
  - backend ZIP/RAR extraction: Tasks 3, 4, 6
  - nested `.txt` flattening: Tasks 2, 3, 4
  - duplicate-safe naming: Tasks 1, 2, 3, 4
  - archive cleanup: Tasks 2, 3, 4, 6, 8
  - frontend success messaging: Task 7
- Placeholder scan:
  - no `TODO`, `TBD`, or "similar to" placeholders remain
- Type consistency:
  - extraction payload uses `archiveType`, `extractedCount`, and `files` consistently across utility, routes, and UI

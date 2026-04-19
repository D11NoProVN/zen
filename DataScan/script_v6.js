// ZenScan v1.0 — Main Engine
document.addEventListener('DOMContentLoaded', () => {
    // ─── DOM Elements ───
    const $ = id => document.getElementById(id);
    const el = {
        fileInput:      $('fileInput'),
        dropZone:       $('dropZone'),
        fileList:       $('fileList'),
        keyword:        $('keyword'),
        excludeKeyword: $('excludeKeyword'),
        stripUrl:       $('stripUrl'),
        dedupToggle:    $('dedupToggle'),
        processBtn:     $('processBtn'),
        stopBtn:        $('stopBtn'),
        clearBtn:       $('clearBtn'),
        downloadBtn:    $('downloadBtn'),
        splitDownloadBtn: $('splitDownloadBtn'),
        copyBtn:        $('copyBtn'),
        totalLines:     $('totalLines'),
        filteredLines:  $('filteredLines'),
        scanSpeed:      $('scanSpeed'),
        dataVolume:     $('dataVolume'),
        consoleOutput:  $('consoleOutput'),
        consoleSearch:  $('consoleSearch'),
        clearConsoleBtn:$('clearConsoleBtn'),
        domainAnalytics:$('domainAnalytics'),
        keywordTags:    $('keywordTags'),
        sessionHistory: $('sessionHistory'),
        statusDot:      $('statusDot'),
        statusText:     $('statusText'),
        progressBar:    $('progressBar'),
        savedBadge:     $('savedBadge'),
        toastContainer: $('toastContainer'),
        loadFromDownloadsBtn: $('loadFromDownloadsBtn'),
    };

    // ─── State ───
    let state = {
        worker: null,
        files: [],           // Array of File objects
        totalFileSize: 0,
        totalCount: 0,
        foundCount: 0,
        bytesRead: 0,
        lastTotal: 0,
        startTime: 0,
        blobChunks: [],
        perKeywordChunks: {},  // { keyword: [Blob, ...] }
        perKeywordCounts: {},  // { keyword: number }
        isProcessing: false,
        speedTimer: null,
    };

    // ─── Keyword Persistence (localStorage) ───
    const STORAGE_KEY = 'zenscan_keywords';
    const SESSION_KEY = 'zenscan_sessions';

    function loadKeywords() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            el.keyword.value = saved;
            flashSavedBadge();
        }
    }

    function saveKeywords() {
        const val = el.keyword.value.trim();
        if (val) {
            localStorage.setItem(STORAGE_KEY, val);
            flashSavedBadge();
        }
    }

    function flashSavedBadge() {
        el.savedBadge.classList.add('visible');
        setTimeout(() => el.savedBadge.classList.remove('visible'), 2000);
    }

    let saveDebounce;
    el.keyword.addEventListener('input', () => {
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(saveKeywords, 800);
    });

    loadKeywords();

    // ─── Load from Downloads ───
    el.loadFromDownloadsBtn.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/files');
            const data = await res.json();

            if (!data.success) {
                notify('Lỗi tải danh sách: ' + data.error, 'error');
                return;
            }

            if (data.files.length === 0) {
                notify('Chưa có file nào trong Downloads!', 'error');
                return;
            }

            // Show selection modal
            showDownloadsModal(data.files);
        } catch (err) {
            notify('Lỗi kết nối server: ' + err.message, 'error');
        }
    });

    function showDownloadsModal(files) {
        // Create modal
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.85);
            backdrop-filter: blur(8px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            animation: fadeIn 0.2s;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: var(--radius-xl);
            padding: 1.5rem;
            max-width: 600px;
            width: 90%;
            max-height: 70vh;
            overflow-y: auto;
        `;

        content.innerHTML = `
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary); font-size: 1.2rem;">
                <i class="fas fa-folder-open"></i> Chọn file từ Downloads
            </h3>
            <div id="modalFileList" style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem;">
                ${files.map((f, i) => `
                    <label style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: var(--radius-md); cursor: pointer; transition: all 0.2s;" class="file-select-item">
                        <input type="checkbox" value="${i}" style="width: 18px; height: 18px; cursor: pointer;">
                        <div style="flex: 1;">
                            <div style="color: var(--text-primary); font-size: 0.85rem; font-weight: 600; margin-bottom: 0.25rem;">${escapeHtml(f.name)}</div>
                            <div style="color: var(--text-dim); font-size: 0.7rem; font-family: var(--font-mono);">
                                ${formatBytes(f.size)} • ${new Date(f.modified).toLocaleString('vi-VN')}
                            </div>
                        </div>
                    </label>
                `).join('')}
            </div>
            <div style="display: flex; gap: 0.5rem;">
                <button id="modalLoadBtn" class="btn btn-primary" style="flex: 1;">
                    <i class="fas fa-check"></i> Tải file đã chọn
                </button>
                <button id="modalCancelBtn" class="btn btn-ghost">
                    <i class="fas fa-xmark"></i> Hủy
                </button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        // Hover effect
        content.querySelectorAll('.file-select-item').forEach(item => {
            item.addEventListener('mouseenter', () => {
                item.style.borderColor = 'var(--accent)';
                item.style.background = 'rgba(108, 92, 231, 0.1)';
            });
            item.addEventListener('mouseleave', () => {
                item.style.borderColor = 'var(--border)';
                item.style.background = 'rgba(0,0,0,0.3)';
            });
        });

        // Load selected files
        document.getElementById('modalLoadBtn').addEventListener('click', async () => {
            const selected = Array.from(content.querySelectorAll('input[type="checkbox"]:checked'))
                .map(cb => files[parseInt(cb.value)]);

            if (selected.length === 0) {
                notify('Chưa chọn file nào!', 'error');
                return;
            }

            modal.remove();
            await loadFilesFromServer(selected);
        });

        document.getElementById('modalCancelBtn').addEventListener('click', () => {
            modal.remove();
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    async function loadFilesFromServer(fileInfos) {
        const loadedFiles = [];

        for (const info of fileInfos) {
            try {
                const res = await fetch(`/api/files/${encodeURIComponent(info.name)}/content`);

                if (!res.ok) {
                    notify(`Lỗi tải ${info.name}: ${res.statusText}`, 'error');
                    continue;
                }

                // Get as blob to avoid string size limit
                const blob = await res.blob();
                const file = new File([blob], info.name, { type: 'text/plain' });
                loadedFiles.push(file);
            } catch (err) {
                notify(`Lỗi tải ${info.name}: ${err.message}`, 'error');
            }
        }

        if (loadedFiles.length > 0) {
            addFiles(loadedFiles);
            notify(`Đã tải ${loadedFiles.length} file từ Downloads!`, 'success');
        }
    }

    // ─── Parse Keywords ───
    function parseKeywords() {
        const stripUrl = el.stripUrl.checked;
        return el.keyword.value
            .split('\n')
            .map(k => k.trim())
            .filter(k => k.length > 0)
            .map(k => stripUrl ? stripUrlFromKeyword(k) : k.toLowerCase());
    }

    function stripUrlFromKeyword(kw) {
        // Strip http(s):// and trailing slashes
        return kw.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    }

    // ─── Multi-file & Folder Drop ───
    // Prevent browser default drag behavior on the whole page
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => e.preventDefault());

    el.dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        e.stopPropagation();
        el.dropZone.classList.add('dragover');
    });
    el.dropZone.addEventListener('dragleave', e => {
        e.preventDefault();
        el.dropZone.classList.remove('dragover');
    });
    el.dropZone.addEventListener('drop', async e => {
        e.preventDefault();
        e.stopPropagation();
        el.dropZone.classList.remove('dragover');

        const items = e.dataTransfer.items;
        const newFiles = [];

        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry?.() || items[i].getAsEntry?.();
            if (entry) {
                const files = await readEntry(entry);
                newFiles.push(...files);
            } else {
                const file = items[i].getAsFile();
                if (file && file.name.endsWith('.txt')) newFiles.push(file);
            }
        }

        addFiles(newFiles);
    });

    async function readEntry(entry) {
        const results = [];
        if (entry.isFile) {
            const file = await new Promise(resolve => entry.file(resolve));
            if (file.name.endsWith('.txt')) results.push(file);
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            let entries = await new Promise(resolve => reader.readEntries(resolve));
            for (const sub of entries) {
                results.push(...(await readEntry(sub)));
            }
        }
        return results;
    }

    // File input change (works with both multi-file and directory selection)
    el.fileInput.addEventListener('change', e => {
        const newFiles = Array.from(e.target.files).filter(f => f.name.endsWith('.txt'));
        addFiles(newFiles);
        // Reset input so same files can be selected again
        el.fileInput.value = '';
    });

    function addFiles(newFiles) {
        if (newFiles.length === 0) {
            notify('Không tìm thấy file .txt nào!', 'error');
            return;
        }
        // Append, avoiding duplicates by name+size
        const existing = new Set(state.files.map(f => f.name + f.size));
        for (const f of newFiles) {
            if (!existing.has(f.name + f.size)) {
                state.files.push(f);
            }
        }
        state.totalFileSize = state.files.reduce((s, f) => s + f.size, 0);
        el.dataVolume.innerText = formatBytes(state.totalFileSize);
        el.processBtn.disabled = false;
        renderFileList();
        notify(`Đã nạp ${newFiles.length} file (.txt)`, 'success');
    }

    function removeFile(index) {
        state.files.splice(index, 1);
        state.totalFileSize = state.files.reduce((s, f) => s + f.size, 0);
        el.dataVolume.innerText = state.files.length ? formatBytes(state.totalFileSize) : '0 MB';
        if (state.files.length === 0) el.processBtn.disabled = true;
        renderFileList();
    }

    function renderFileList() {
        el.fileList.innerHTML = '';
        state.files.forEach((f, i) => {
            const tag = document.createElement('div');
            tag.className = 'file-tag';
            tag.innerHTML = `
                <i class="fas fa-file-lines"></i>
                <span>${f.name}</span>
                <span class="file-size">${formatBytes(f.size)}</span>
                <span class="file-remove" data-index="${i}"><i class="fas fa-xmark"></i></span>
            `;
            el.fileList.appendChild(tag);
        });
        // Attach remove handlers
        el.fileList.querySelectorAll('.file-remove').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                removeFile(parseInt(btn.dataset.index));
            });
        });
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    // ─── Process ───
    function startProcess() {
        const keywords = parseKeywords();
        const excludeKeywords = el.excludeKeyword.value.trim();
        const stripUrl = el.stripUrl.checked;
        const dedup = el.dedupToggle.checked;

        if (state.files.length === 0 || state.isProcessing) return;
        if (keywords.length === 0) return notify('Chưa nhập keyword!', 'error');

        // Save keywords
        saveKeywords();

        // Reset
        state.isProcessing = true;
        state.totalCount = 0;
        state.foundCount = 0;
        state.bytesRead = 0;
        state.lastTotal = 0;
        state.blobChunks = [];
        state.perKeywordChunks = {};
        state.perKeywordCounts = {};
        state.startTime = Date.now();

        keywords.forEach(kw => {
            state.perKeywordChunks[kw] = [];
            state.perKeywordCounts[kw] = 0;
        });

        el.totalLines.innerText = '0';
        el.filteredLines.innerText = '0';
        el.scanSpeed.innerText = '0';
        el.progressBar.style.width = '0%';
        el.consoleOutput.innerHTML = '<div class="log-line">─── ZenScan v1.0 STREAM START ───</div>';
        el.domainAnalytics.innerHTML = '<div class="analytics-empty">Analyzing...</div>';
        renderKeywordTags(keywords);

        el.statusDot.classList.add('active');
        el.statusText.innerText = 'SCANNING...';
        el.processBtn.classList.add('hidden');
        el.stopBtn.classList.remove('hidden');

        // Create worker
        state.worker = new Worker('worker_v6.js?v=' + Date.now());

        state.speedTimer = setInterval(() => {
            const delta = state.totalCount - state.lastTotal;
            el.scanSpeed.innerText = delta.toLocaleString();
            state.lastTotal = state.totalCount;

            const progress = state.totalFileSize > 0
                ? (state.bytesRead / state.totalFileSize) * 100
                : 0;
            el.progressBar.style.width = `${Math.min(progress, 100)}%`;
        }, 1000);

        // Send all files + keywords to worker
        state.worker.postMessage({
            files: state.files,
            keywords,
            excludeKeywords,
            stripUrl,
            dedup,
        });

        state.worker.onmessage = e => {
            const data = e.data;

            if (data.type === 'progress' || data.type === 'complete') {
                state.totalCount = data.total;
                state.foundCount = data.filtered;
                state.bytesRead = data.bytes;

                el.totalLines.innerText = state.totalCount.toLocaleString();
                el.filteredLines.innerText = state.foundCount.toLocaleString();

                // Store blobs globally
                if (data.results && data.results.length > 0) {
                    state.blobChunks.push(new Blob([data.results + '\n'], { type: 'text/plain' }));
                }

                // Store per-keyword blobs
                if (data.perKeyword) {
                    for (const [kw, lines] of Object.entries(data.perKeyword)) {
                        if (lines.length > 0) {
                            if (!state.perKeywordChunks[kw]) state.perKeywordChunks[kw] = [];
                            state.perKeywordChunks[kw].push(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }));
                        }
                    }
                }

                // Update per-keyword counts
                if (data.perKeywordCounts) {
                    for (const [kw, count] of Object.entries(data.perKeywordCounts)) {
                        state.perKeywordCounts[kw] = count;
                    }
                    updateKeywordTagCounts();
                }

                if (data.preview && data.preview.length > 0) {
                    renderPreview(data.preview);
                }

                if (data.topDomains) {
                    renderAnalytics(data.topDomains);
                }

                if (data.type === 'complete') endProcess(true);

            } else if (data.type === 'error') {
                notify('Lỗi: ' + data.message, 'error');
                endProcess(false);
            }
        };
    }

    // ─── Preview ───
    function renderPreview(lines) {
        const frag = document.createDocumentFragment();
        const searchTerm = el.consoleSearch.value.toLowerCase();
        lines.forEach(line => {
            if (searchTerm && !line.toLowerCase().includes(searchTerm)) return;
            const d = document.createElement('div');
            d.className = 'log-line';
            d.textContent = line;
            frag.appendChild(d);
        });
        el.consoleOutput.appendChild(frag);
        el.consoleOutput.scrollTop = el.consoleOutput.scrollHeight;
        // Keep buffer size reasonable
        while (el.consoleOutput.childNodes.length > 300) {
            el.consoleOutput.removeChild(el.consoleOutput.firstChild);
        }
    }

    // Console search filter
    el.consoleSearch.addEventListener('input', () => {
        const term = el.consoleSearch.value.toLowerCase();
        const lines = el.consoleOutput.querySelectorAll('.log-line:not(.empty)');
        lines.forEach(line => {
            line.style.display = (!term || line.textContent.toLowerCase().includes(term)) ? '' : 'none';
        });
    });

    el.clearConsoleBtn.addEventListener('click', () => {
        el.consoleOutput.innerHTML = '<div class="log-line empty">Console cleared</div>';
    });

    // ─── Analytics ───
    function renderAnalytics(domains) {
        el.domainAnalytics.innerHTML = '';
        if (!domains || domains.length === 0) {
            el.domainAnalytics.innerHTML = '<div class="analytics-empty">Chưa có dữ liệu</div>';
            return;
        }
        domains.forEach(([name, count]) => {
            const row = document.createElement('div');
            row.className = 'analytics-row';
            row.innerHTML = `<span class="an-name">${escapeHtml(name)}</span><span class="an-count">${count.toLocaleString()}</span>`;
            el.domainAnalytics.appendChild(row);
        });
    }

    // ─── Keyword Tags ───
    function renderKeywordTags(keywords) {
        el.keywordTags.innerHTML = '';
        if (keywords.length === 0) {
            el.keywordTags.innerHTML = '<div class="analytics-empty">Chưa có keyword nào</div>';
            return;
        }
        keywords.forEach(kw => {
            const tag = document.createElement('span');
            tag.className = 'kw-tag';
            tag.dataset.kw = kw;
            tag.innerHTML = `${escapeHtml(kw)} <span class="kw-count" data-kw-count="${kw}">0</span>`;
            tag.title = `Click to download results for "${kw}"`;
            tag.addEventListener('click', () => downloadPerKeyword(kw));
            el.keywordTags.appendChild(tag);
        });
    }

    function updateKeywordTagCounts() {
        for (const [kw, count] of Object.entries(state.perKeywordCounts)) {
            const badge = el.keywordTags.querySelector(`[data-kw-count="${CSS.escape(kw)}"]`);
            if (badge) badge.textContent = count.toLocaleString();
        }
    }

    // ─── End Process ───
    function endProcess(done) {
        state.isProcessing = false;
        clearInterval(state.speedTimer);
        if (state.worker) state.worker.terminate();

        el.statusDot.classList.remove('active');
        el.statusText.innerText = done ? 'COMPLETED' : 'STOPPED';
        el.processBtn.classList.remove('hidden');
        el.stopBtn.classList.add('hidden');
        el.scanSpeed.innerText = '0';
        if (done) el.progressBar.style.width = '100%';

        if (done) {
            const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
            notify(`Hoàn tất! ${state.foundCount.toLocaleString()} kết quả trong ${elapsed}s`, 'success');
            saveSession();
        }
    }

    // ─── Downloads ───
    // Download all
    el.downloadBtn.addEventListener('click', () => {
        if (state.blobChunks.length === 0) return notify('Không có dữ liệu để tải!', 'error');
        const ts = Date.now();
        downloadBlob(state.blobChunks, `zenscan-all-${ts}.txt`);
        notify('Đã tải file tổng hợp!', 'success');
    });

    // Download per keyword (as ZIP)
    el.splitDownloadBtn.addEventListener('click', async () => {
        const kwKeys = Object.keys(state.perKeywordChunks).filter(k => state.perKeywordChunks[k].length > 0);
        if (kwKeys.length === 0) return notify('Không có dữ liệu để tải!', 'error');

        notify('Đang tạo ZIP file...', 'info');

        try {
            const zip = new JSZip();
            const ts = Date.now();

            for (const kw of kwKeys) {
                const blob = new Blob(state.perKeywordChunks[kw], { type: 'text/plain' });
                const safeName = kw.replace(/[^a-z0-9.-]/gi, '_');
                const fileName = `data-${safeName}-${ts}.txt`;
                zip.file(fileName, blob);
            }

            const content = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url;
            a.download = `zenscan-keywords-${ts}.zip`;
            a.click();
            URL.revokeObjectURL(url);
            notify(`Đã tải ZIP với ${kwKeys.length} file!`, 'success');
        } catch (err) {
            // Fallback: download individually
            notify('JSZip không khả dụng, tải từng file...', 'info');
            const ts = Date.now();
            for (let i = 0; i < kwKeys.length; i++) {
                const kw = kwKeys[i];
                const safeName = kw.replace(/[^a-z0-9.-]/gi, '_');
                setTimeout(() => {
                    downloadBlob(state.perKeywordChunks[kw], `data-${safeName}-${ts}.txt`);
                }, i * 400);
            }
        }
    });

    // Download single keyword results
    function downloadPerKeyword(kw) {
        const chunks = state.perKeywordChunks[kw];
        if (!chunks || chunks.length === 0) return notify(`Chưa có dữ liệu cho "${kw}"`, 'error');
        const safeName = kw.replace(/[^a-z0-9.-]/gi, '_');
        downloadBlob(chunks, `data-${safeName}-${Date.now()}.txt`);
        notify(`Đã tải kết quả cho "${kw}"`, 'success');
    }

    function downloadBlob(blobArray, filename) {
        const finalBlob = new Blob(blobArray, { type: 'text/plain' });
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ─── Copy to clipboard ───
    el.copyBtn.addEventListener('click', async () => {
        if (state.blobChunks.length === 0) return notify('Không có dữ liệu để copy!', 'error');

        try {
            const blob = new Blob(state.blobChunks, { type: 'text/plain' });
            const text = await blob.text();
            await navigator.clipboard.writeText(text);
            notify(`Đã copy ${state.foundCount.toLocaleString()} dòng!`, 'success');
        } catch (err) {
            notify('Không thể copy: ' + err.message, 'error');
        }
    });

    // ─── Stop / Reset ───
    el.stopBtn.addEventListener('click', () => {
        endProcess(false);
        notify('Đã dừng scan!', 'error');
    });

    el.processBtn.addEventListener('click', startProcess);
    el.clearBtn.addEventListener('click', resetApp);

    function resetApp() {
        if (state.isProcessing) endProcess(false);

        state.files = [];
        state.totalFileSize = 0;
        state.totalCount = 0;
        state.foundCount = 0;
        state.bytesRead = 0;
        state.lastTotal = 0;
        state.blobChunks = [];
        state.perKeywordChunks = {};
        state.perKeywordCounts = {};

        el.fileInput.value = '';
        el.fileList.innerHTML = '';
        // Keep keywords (saved in localStorage)
        el.excludeKeyword.value = '';
        el.totalLines.innerText = '0';
        el.filteredLines.innerText = '0';
        el.scanSpeed.innerText = '0';
        el.dataVolume.innerText = '0 MB';
        el.progressBar.style.width = '0%';
        el.consoleOutput.innerHTML = '<div class="log-line empty">Chọn file và nhập keyword để bắt đầu...</div>';
        el.domainAnalytics.innerHTML = '<div class="analytics-empty">Chưa có dữ liệu</div>';
        el.keywordTags.innerHTML = '<div class="analytics-empty">Chưa có keyword nào</div>';
        el.consoleSearch.value = '';

        el.statusDot.classList.remove('active');
        el.statusText.innerText = 'READY';
        el.processBtn.disabled = true;
        el.processBtn.classList.remove('hidden');
        el.stopBtn.classList.add('hidden');

        notify('Đã reset! Keywords vẫn được lưu.', 'info');
    }

    // ─── Session History ───
    function saveSession() {
        const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
        sessions.unshift({
            time: new Date().toLocaleString('vi-VN'),
            keywords: parseKeywords().length,
            results: state.foundCount,
            files: state.files.length,
        });
        // Keep last 10
        if (sessions.length > 10) sessions.length = 10;
        localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
        renderSessions();
    }

    function renderSessions() {
        const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
        el.sessionHistory.innerHTML = '';
        if (sessions.length === 0) {
            el.sessionHistory.innerHTML = '<div class="analytics-empty">Chưa có phiên nào</div>';
            return;
        }
        sessions.slice(0, 5).forEach(s => {
            const item = document.createElement('div');
            item.className = 'session-item';
            item.innerHTML = `
                <span class="session-time">${s.time}</span>
                <span class="session-count">${s.results?.toLocaleString() || 0} kết quả</span>
            `;
            el.sessionHistory.appendChild(item);
        });
    }
    renderSessions();

    // ─── Toast System ───
    function notify(msg, type = 'info') {
        const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${escapeHtml(msg)}`;
        el.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('exit');
            setTimeout(() => toast.remove(), 300);
        }, 3500);

        // Keep max 4 toasts
        while (el.toastContainer.childNodes.length > 4) {
            el.toastContainer.removeChild(el.toastContainer.firstChild);
        }
    }

    // ─── Utility ───
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
});
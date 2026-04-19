# Download Archive Extraction Design

## Context
The current `/download` flow in `download.html` and `download-manager.js` downloads a remote file through backend routes in `server-fast.js` and stores the result in `downloads/`. Today the flow assumes the final downloaded artifact is itself the file the user wants to keep. The new requirement is to treat downloaded `.zip` and `.rar` files as containers: automatically extract every `.txt` file from anywhere inside the archive, save only those extracted `.txt` files into `downloads/`, keep all duplicates by auto-renaming, and remove the original archive afterward.

## Goal
When a user downloads a URL from `/download`:
- `.txt` downloads should continue to work exactly as they do now.
- `.zip` and `.rar` downloads should be extracted automatically on the backend.
- All `.txt` files inside the archive, including nested folders, should be imported into `downloads/`.
- Duplicate `.txt` names should be preserved by auto-renaming rather than overwriting.
- The original archive should not remain in `downloads/` after processing.

## Recommended Approach
Integrate archive extraction directly into the existing backend download flow in `server-fast.js`, immediately after the file download finishes and before the route sends its final success payload. Keep the UI flow in `download-manager.js` mostly unchanged and extend the backend response payload so the page can display a more helpful success message when an archive was extracted.

This keeps the user interaction simple, avoids adding a second manual extraction step, and concentrates the extraction/security logic in one server-side place.

## Architecture

### 1. Download route behavior
Update both backend download endpoints in `server-fast.js`:
- `POST /api/download`
- `POST /api/download-stream`

After the file is fully written to disk:
1. Detect whether the downloaded file is a plain `.txt`, `.zip`, or `.rar` by filename extension.
2. If it is `.txt`, preserve current behavior.
3. If it is `.zip` or `.rar`, invoke a dedicated archive-extraction utility.
4. Use the utility result to build the final JSON/SSE complete payload.

### 2. Archive extraction utility
Add a focused backend helper module responsible only for archive extraction. It should:
- accept the downloaded archive path and `DOWNLOAD_DIR`
- inspect all archive entries, including nested directories
- filter to `.txt` files only
- flatten output into `downloads/`
- sanitize output names to safe basenames only
- auto-rename duplicates using the project’s existing unique-name pattern
- delete the original archive after successful processing
- clean up partially created `.txt` files if extraction fails mid-process

This utility should not know about HTTP or SSE; it should only return structured extraction results or throw a controlled error.

### 3. Filename handling
For extracted files:
- only `.txt` entries are eligible
- paths inside archives must never be trusted as output paths
- only safe basenames should be written into `downloads/`
- duplicate names must be preserved using unique suffixes such as `name (1).txt`

This should reuse existing safe-path and unique-name patterns already present in `scan-request-utils.js` where practical.

## User-visible behavior

### Successful plain-text download
The result remains the same as today:
- one downloaded `.txt` file appears in `downloads/`
- success UI remains unchanged

### Successful archive download
The backend should report extraction details such as:
- whether extraction occurred
- archive type (`zip` or `rar`)
- how many `.txt` files were extracted
- the final saved filenames

The `/download` page should continue refreshing the file list and should show a success message such as:
- `Đã giải nén 12 file .txt từ archive`

The list should show only extracted `.txt` files and not the original archive.

### Archive contains no `.txt`
Recommended behavior:
- delete the downloaded archive
- return a user-facing error stating that the archive contained no `.txt` files

This matches the requirement that only extracted `.txt` files should remain.

## Error handling and safety
- Reject path traversal by never writing archive entry paths directly to disk.
- Skip directories and non-`.txt` entries.
- If extraction fails after some files were written, remove only the files created by that extraction attempt.
- If archive parsing fails, return a clear extraction error and avoid leaving the archive behind as retained output.
- Keep route-level error responses aligned with current `/api/download` and `/api/download-stream` patterns.

## Dependencies
The implementation will require backend archive-reading support for both `.zip` and `.rar`.

Design constraints:
- choose libraries that support local archive inspection from disk on Node.js
- avoid changing the frontend contract more than necessary
- keep extraction logic server-side only

## Files expected to change
- `F:/SSH/zen/DataScan/server-fast.js`
- `F:/SSH/zen/DataScan/download-manager.js`
- `F:/SSH/zen/DataScan/scan-request-utils.js` (reuse/extend safe filename helpers if needed)
- a new backend archive utility module if needed for focused extraction logic
- targeted tests for archive extraction and route behavior

## Testing strategy

### Automated tests
1. Extraction utility tests
   - extracts `.txt` files from `.zip`
   - extracts `.txt` files from nested paths
   - preserves duplicates by auto-renaming
   - ignores non-`.txt` files
   - fails cleanly when no `.txt` files exist
   - rejects dangerous entry names safely

2. Route-level tests
   - `.txt` downloads keep current behavior
   - archive downloads return extraction metadata
   - archive downloads do not leave the original archive in `downloads/`

### Manual verification
- Download a direct `.txt` URL and confirm current behavior still works.
- Download a `.zip` containing multiple nested `.txt` files and confirm all are extracted.
- Download a `.rar` containing nested `.txt` files and confirm all are extracted.
- Verify duplicate names become distinct saved filenames.
- Verify an archive with no `.txt` shows a clear error and leaves no archive behind.
- Verify the `/download` page refresh shows only extracted `.txt` outputs.

## Scope boundaries
Included:
- automatic backend extraction for downloaded `.zip` and `.rar`
- flattening all nested `.txt` files into `downloads/`
- duplicate-safe naming
- archive cleanup

Not included:
- manual extract buttons
- preserving folder hierarchy from archives
- importing non-`.txt` file types
- changing the stream scan UI beyond consuming the resulting extracted files

## Final recommendation
Implement extraction inside the existing backend download flow, keep the frontend simple, and isolate archive parsing into a dedicated utility so the behavior is secure, testable, and easy to maintain.
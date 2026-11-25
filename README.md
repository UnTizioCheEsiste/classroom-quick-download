# Classroom Quick Download

A Chrome / Brave / Edge extension (Manifest V3) that makes downloading Google Classroom attachments fast: one click per file, or whole posts and streams as a single ZIP.

*Available in English and Italian (follows your browser language).*

## Features

- **Download icon next to every attachment** — one click, no preview, no new tab.
- **Download all** — on an assignment, material or announcement page with two or more attachments.
- **Selection mode** — click the extension icon → *Selection mode*:
  - every post gets a *Select post* checkbox;
  - a bottom panel lets you select all / none, filter by type (PDF, Word, Google Slides, archives…) and by file name, then download;
  - collapsed stream posts (materials, assignments) are opened in an invisible frame to read their attachments — the post bar shows *Reading attachments…* until done;
  - `Esc` or × to leave.
- **Download organisation** (popup or panel, all on by default):
  - *Single ZIP* — one `<course> - <date>.zip` file, so you only save once; off = separate files.
  - *One folder per post* — subfolders named after each post (inside the ZIP or in Downloads).
  - *Classroom/&lt;course&gt;/* — everything goes to `Downloads/Classroom/<course>/`.
- **Google files format** — Docs as PDF or Word, Slides as PDF or PowerPoint, Sheets as Excel or PDF.

| Attachment | Downloaded as |
|---|---|
| Drive files (PDF, ZIP, images, Word, PowerPoint, …) | original file |
| Google Docs | PDF or DOCX |
| Google Slides | PDF or PPTX |
| Google Sheets | XLSX or PDF |
| Google Drawings | PDF |

Folders, Forms, YouTube and external links are ignored.

## Install

### From the release ZIP (any Chromium browser)

1. Download `classroom-quick-download-<version>.zip` from the [Releases](../../releases) page and unzip it.
2. Open `chrome://extensions` (`brave://extensions`, `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder.
5. Reload Classroom.

To update: replace the folder with the new version, click ↻ on the extension, then reload Classroom.

### From source

Clone the repository and load the folder itself with **Load unpacked**.

## Privacy

Everything runs locally in your browser. The extension talks only to Google (Classroom, Drive, Docs) to download the files you ask for, using the session you're already signed in with. No analytics, no tracking, no external servers.

## Notes

- With several Google accounts, the account in the Classroom URL (`/u/1/`, …) is used.
- Selection mode only sees posts loaded on the page: scroll to the bottom of the stream to include older ones.
- Drive file types are guessed from the name and the label on the attachment card; unknown ones go under *Other*.
- If "Ask where to save each file" is on in your browser, separate downloads open one dialog per file: use the ZIP option, or turn that setting off.
- The ZIP is built in memory by a hidden extension page (`offscreen.html`), 6 files at a time. Videos, audio and files over 100 MB are kept out of it: they're saved as normal downloads (in parallel, straight to disk) in the same folders.
- If a teacher disabled downloading for a file, Drive blocks it and it's reported as failed.

## Development

```bash
node scripts/build.mjs
```

builds `dist/classroom-quick-download-<version>.zip` with just the runtime files (for releases and the Chrome Web Store — see [STORE_LISTING.md](STORE_LISTING.md)).

```bash
node test/zip-test.mjs test-output.zip
```

checks the ZIP writer, and

```bash
node test/drive-test.mjs
```

checks how Drive's "can't scan this file for viruses" page (large files such as videos) is bypassed, and

```bash
node test/offscreen-test.mjs
```

checks which files go in the ZIP and which are downloaded separately.

Mock Classroom pages for testing `content.js` outside Chrome:

```bash
python -m http.server 8765
```

then open `http://localhost:8765/test/mock-stream.html`, or `http://localhost:8765/test/u/1/c/TUNPQ/` for a stream with collapsed posts (their pages live in `test/u/1/c/TUNPQ/m|a/…/details/`). Settings can be forced from the URL, e.g. `?zip=false&postFolders=false`.

Classroom's DOM changes from time to time. The content script has a diagnostic dump — in the Classroom tab's console:

```js
document.dispatchEvent(new Event("cqd-debug")); console.log(document.documentElement.dataset.cqdDebug)
```

## License

[MIT](LICENSE)

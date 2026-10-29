# Chrome Web Store listing

Copy-paste material for the Chrome Web Store developer dashboard.
Upload `dist/classroom-quick-download-<version>.zip` (built with `node scripts/build.mjs`).

## Name

Classroom Quick Download

> Google's branding rules allow "for Google Classroom" style names; if the review
> objects to the name, use **Quick Download for Google Classroom**.

## Summary (max 132 characters)

Download Google Classroom attachments in one click — one file at a time, or whole posts and streams as a single ZIP.

## Description

Stop opening every attachment in a new tab just to download it.

Classroom Quick Download adds a small download icon next to every attachment on Google Classroom, plus tools to grab many files at once:

• One-click download — a tiny icon next to each PDF, ZIP, image, Office file or Google Doc.
• Download all — on an assignment or material page, get every attachment with one button.
• Selection mode — click the extension icon on a course stream: a checkbox appears on every post. Select some or all, filter by file type (PDF, Slides, archives…) or by name, and download.
• Single ZIP — bulk downloads become one ZIP file, so you only save once. Optional subfolders per post.
• Google Docs, Slides and Sheets are exported automatically (PDF, Word, PowerPoint or Excel — your choice).
• Works with multiple Google accounts and in Chrome, Brave, Edge and other Chromium browsers.
• Available in English and Italian.

Privacy: everything runs in your browser. The extension sends no data anywhere except to Google itself, to download the files you ask for, using the Google session you're already signed in with. No analytics, no tracking, no external servers.

## Category

Productivity (or Education)

## Single purpose

Download Google Classroom attachments quickly, individually or in bulk.

## Permission justifications

- **downloads** — save the attachments the user chooses to download, and place them in the folders the user enabled (Classroom/<course>/<post>).
- **storage** — remember the user's options (export formats, ZIP, folders).
- **offscreen** — build the ZIP file in memory; a service worker cannot create the Blob URL needed to save it.
- **Host permission: drive.google.com, drive.usercontent.google.com, docs.google.com, \*.googleusercontent.com** — fetch the attachment files (and Google Docs exports) to pack them into the ZIP. Requests go only to these Google hosts and only for files the user selected.
- **Content script on classroom.google.com** — add the download icons, the "Download all" button and selection mode to Classroom pages.
- **Remote code** — none. All code is included in the package.

## Data usage disclosure

The extension does not collect or transmit any user data. Tick "I do not sell or transfer user data to third parties…" and the related certifications. No privacy policy URL is strictly required when no data is collected, but you can link the README's Privacy section.

## Screenshots (1280×800 or 640×400)

Suggested shots, taken on a real course:
1. Attachment cards with the small download icons.
2. An assignment page with "Download all".
3. The stream in selection mode with the bottom panel and type filters.
4. The popup with the options.

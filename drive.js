// Google Drive's "can't scan this file for viruses" page.
// For large files (videos, big archives) drive.usercontent.google.com answers
// with an HTML page instead of the file. Its "Download anyway" button is a form
// with hidden fields (id, export, confirm, uuid…): submitting it gives the file.
// Shared by the service worker (no DOMParser there, hence the regexes) and the
// offscreen document.

const DRIVE_DOWNLOAD = /^https:\/\/drive\.usercontent\.google\.com\/download/;

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** URL of the "Download anyway" button in the warning page HTML, or null. */
function driveConfirmUrl(html, baseUrl) {
  const form = html.match(/<form\b[^>]*\bid=["']download-form["'][^>]*>([\s\S]*?)<\/form>/i);
  if (form) {
    const action = form[0].match(/\baction=["']([^"']+)["']/i)?.[1];
    if (action) {
      const url = new URL(decodeEntities(action), baseUrl);
      for (const [input] of form[1].matchAll(/<input\b[^>]*>/gi)) {
        const name = input.match(/\bname=["']([^"']*)["']/i)?.[1];
        if (!name) continue; // the submit button has no name
        const value = input.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
        url.searchParams.set(decodeEntities(name), decodeEntities(value));
      }
      return url.href;
    }
  }
  // Older version of the page: a plain link with a confirm token.
  const link = html.match(/\bhref=["']([^"']*[?&](?:amp;)?confirm=[^"']*)["']/i);
  return link ? new URL(decodeEntities(link[1]), baseUrl).href : null;
}

/**
 * Returns the URL to actually download: the same one, or — when Drive answers
 * with the virus-scan warning — the "Download anyway" URL. Only the response
 * headers are read for real files; the body download is aborted right away.
 */
async function bypassDriveWarning(url) {
  if (!DRIVE_DOWNLOAD.test(url)) return url;
  const ctrl = new AbortController();
  try {
    const res = await fetch(url, { credentials: "include", signal: ctrl.signal });
    if (!/text\/html/i.test(res.headers.get("content-type") || "")) return url;
    return driveConfirmUrl(await res.text(), res.url) || url;
  } catch {
    return url; // network trouble: let the normal download report it
  } finally {
    ctrl.abort();
  }
}

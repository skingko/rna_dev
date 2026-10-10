/**
 * Static HTML preview document. The iframe is `sandbox=""` (opaque origin: no
 * scripts, forms, popups, top navigation or same-origin access) and the
 * document additionally carries a CSP meta that forbids every network fetch,
 * so a previewed page can neither run code nor phone home. Inline styles and
 * data:/blob: images still render, which is what a static read needs.
 */
export const PREVIEW_CSP = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'"

/** The sandbox attribute value: empty grants nothing. */
export const HTML_SANDBOX = ''

/** Insert the CSP meta as the first element of <head> (creating one if needed) without changing the doctype. */
export function sandboxedHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer">`
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length)
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html)
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${meta}</head>` + html.slice(htmlTag.index + htmlTag[0].length)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return doctype[0] + `<head>${meta}</head>` + html.slice(doctype[0].length)
  return `<head>${meta}</head>${html}`
}

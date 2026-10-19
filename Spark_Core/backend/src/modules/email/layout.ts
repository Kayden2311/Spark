export interface EmailLayoutInput {
  /** Inbox preview text, hidden in the body. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footerNote: string;
  /**
   * Absolute URL of the recipient's email settings, linked from the footer. Omit it when the recipient may
   * have no account (for example an invitation).
   */
  settingsUrl?: string;
}

const INK = "#17233d";
const NAVY = "#09265a";
const BLUE = "#2563eb";
const MUTED = "#5b6478";
const LINE = "#e3e8f0";
const CANVAS = "#f4f6fb";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);
}

/** Only absolute http(s) links may appear in an email; anything else is a template error. */
function linkUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Email links must use http or https");
  return url.href;
}

/** Renders the shared Spark email frame. Every interpolated value is HTML-escaped. */
export function renderEmail(input: EmailLayoutInput): { html: string; text: string } {
  const settingsUrl = input.settingsUrl === undefined ? undefined : linkUrl(input.settingsUrl);
  const action = input.action ? { label: input.action.label, url: linkUrl(input.action.url) } : undefined;
  const paragraphs = input.paragraphs
    .map((paragraph) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${INK};">${escapeHtml(paragraph)}</p>`)
    .join("");
  const button = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>
<td style="border-radius:8px;background:${BLUE};"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:16px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(action.label)}</a></td>
</tr></table>
<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${MUTED};">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(action.url)}" style="color:${BLUE};word-break:break-all;">${escapeHtml(action.url)}</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.heading)}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};font-family:${FONT};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;overflow:hidden;">
<tr><td style="background:${NAVY};padding:18px 28px;font-family:${FONT};font-size:20px;font-weight:700;letter-spacing:0.2px;color:#ffffff;">Spark</td></tr>
<tr><td style="padding:28px 28px 12px;font-family:${FONT};">
<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;color:${INK};">${escapeHtml(input.heading)}</h1>
${paragraphs}${button}
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid ${LINE};font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">
${escapeHtml(input.footerNote)}${settingsUrl ? `<br>Manage email settings: <a href="${escapeHtml(settingsUrl)}" style="color:${MUTED};">${escapeHtml(settingsUrl)}</a>` : ""}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    input.heading,
    ...input.paragraphs,
    ...(action ? [`${action.label}: ${action.url}`] : []),
    `--\n${input.footerNote}${settingsUrl ? `\nManage email settings: ${settingsUrl}` : ""}`,
  ].join("\n\n");

  return { html, text: `${text}\n` };
}

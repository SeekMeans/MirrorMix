import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const MARKDOWN_FILE = /\.(?:md|markdown)$/i;

/** The first "# heading" of a Markdown text, as its title. */
export function markdownTitle(text: string): string | undefined {
  const heading = text.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return heading ? heading.slice(0, 200) : undefined;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STYLE = `
:root { color-scheme: light dark; --ink:#15222b; --muted:#586874; --line:#dfe7eb; --code:#eef3f5; --page:#ffffff; --accent:#0b6e6a; }
@media (prefers-color-scheme: dark) { :root { --ink:#dbe6eb; --muted:#93a5b0; --line:#2b3d47; --code:#1d2e36; --page:#121e24; --accent:#5cc4b8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.7 "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 40px 24px 80px; }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 0.6em; }
h1 { font-size: 2em; margin-top: 0.2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
h2 { font-size: 1.45em; padding-bottom: 0.25em; border-bottom: 1px solid var(--line); }
p, ul, ol, table, pre, blockquote { margin: 0.8em 0; }
a { color: var(--accent); }
code { font: 0.9em "Cascadia Mono", Consolas, monospace; background: var(--code); padding: 0.15em 0.4em; border-radius: 4px; }
pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; line-height: 1.5; }
pre code { background: none; padding: 0; }
blockquote { margin-left: 0; padding: 0.2em 1em; border-left: 4px solid var(--line); color: var(--muted); }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 6px 12px; }
th { background: var(--code); }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
@media (max-width: 600px) { main { padding: 24px 16px 60px; } body { font-size: 15px; } }
`;

/**
 * A Markdown file as a page to read in the browser. Raw HTML in the file is shown as text, not run. Relative
 * pictures and links resolve against the file's own folder, since the page is served at the file's path.
 */
export function markdownPage(text: string, fileName: string): string {
  const body = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text));
  const title = markdownTitle(text) ?? fileName;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

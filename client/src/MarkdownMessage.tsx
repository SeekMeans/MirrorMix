import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { commandOf, requestRun } from "./runCommand";
import { fileOfLink, looksLikeFile, requestOpenFile } from "./openFile";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * A fenced block, with a run button when it holds shell commands. Its code is drawn here rather than through the
 * `code` override, so that override only ever sees inline code.
 */
function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const code = node?.children?.find((child) => child.type === "element" && child.tagName === "code");
  if (!code) return <pre>{children}</pre>;
  const classes = Array.isArray(code.properties?.className) ? (code.properties.className as string[]) : [];
  const language = classes.find((name) => name.startsWith("language-"))?.slice("language-".length) ?? "";
  const text = textOf(code);
  const command = commandOf(language, text);
  const pre = (
    <pre>
      <code className={classes.join(" ") || undefined}>{text.replace(/\n$/, "")}</code>
    </pre>
  );
  if (!command) return pre;
  return (
    <div className="code-block">
      {pre}
      <button
        type="button"
        className="code-run"
        aria-label="在命令行里运行"
        title={`在右上角的命令行里运行\n${command}`}
        onClick={() => requestRun(command)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

/** Parsing markdown is the costly part of a message, so it only happens again when the text changes. */
export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            // A link to a file of the project opens it in the file browser instead of leaving the page.
            const file = fileOfLink(href);
            if (file) {
              return (
                <a
                  href={href}
                  className="file-link"
                  title={`在资源管理器里打开 ${file}`}
                  onClick={(event) => {
                    event.preventDefault();
                    requestOpenFile(file);
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
          code: ({ node, children, className }) => {
            const value = node ? textOf(node as HastNode) : "";
            if (!looksLikeFile(value)) return <code className={className}>{children}</code>;
            return (
              <code
                className={className ? `${className} file-code` : "file-code"}
                role="link"
                tabIndex={0}
                title={`在资源管理器里打开 ${value}`}
                onClick={(event) => {
                  // Inside a link, the link opens it.
                  if (!event.currentTarget.closest("a")) requestOpenFile(value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") requestOpenFile(value);
                }}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

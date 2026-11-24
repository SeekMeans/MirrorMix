import { useEffect, useState } from "react";
import { apiRequest, type ToolId } from "./api";
import { toolName } from "./text";
import { ToolIcon } from "./ToolIcon";

import { currentLanguage, tr, uiLocale } from "./i18n";
interface ToolDay {
  messages: number;
  conversations: number;
  started: number;
  busyMs: number;
  tokens: number;
}

interface DayConversation {
  tool: ToolId;
  id: string;
  title: string;
  place: string;
  messages: number;
  lastAt: number;
}

interface TodayStats {
  byTool: Record<ToolId, ToolDay>;
  top: DayConversation[];
  since: number;
}

/** Each tool's own colour in the strip; the monochrome brands use the page's ink. */
const TOOL_COLOR: Record<ToolId, string> = {
  claude: "#d97757",
  codex: "var(--ink)",
  cursor: "var(--faint)",
  deepseek: "#4d6bfe",
};

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms > 0 ? tr("不到 1 分钟", "<1 min") : tr("0 分钟", "0 min");
  if (minutes < 60) return tr(`${minutes} 分钟`, `${minutes} min`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? tr(`${hours} 小时 ${rest} 分`, `${hours} h ${rest} min`) : tr(`${hours} 小时`, `${hours} h`);
}

/** The same span in a narrow cell: whole minutes under an hour, then hours to one decimal (4.5 小时). */
function shortDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return duration(ms);
  const hours = Math.round((minutes / 60) * 10) / 10;
  return tr(`${hours} 小时`, `${hours} h`);
}

function tokens(count: number): string {
  if (currentLanguage() === "en") {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 10_000) return `${(count / 1_000).toFixed(0)}K`;
    return count.toLocaleString("en-US");
  }
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)} 亿`;
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 1_000_000 ? 0 : 1)} 万`;
  return count.toLocaleString(uiLocale());
}

function clock(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The empty workbench: today's conversations at a glance. Messages sent, how many conversations they went to and how
 * many began today, how long the AI spent replying and what it wrote, split by tool; then the busiest conversations,
 * each one click from opening. Counted from midnight on this computer; refreshed every minute and on coming back.
 */
export function TodayStats({
  tools,
  onOpen,
  compact = false,
}: {
  tools: ToolId[];
  onOpen: (tool: ToolId, id: string) => void;
  /** The phone's 工作台: a card above the live sessions, with the three busiest conversations. */
  compact?: boolean;
}) {
  const [stats, setStats] = useState<TodayStats | null>(null);

  useEffect(() => {
    let gone = false;
    const load = () =>
      apiRequest<TodayStats>("/api/stats/today").then(
        (value) => !gone && setStats(value),
        () => undefined,
      );
    void load();
    const timer = window.setInterval(load, 60_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      gone = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!stats?.byTool || tools.length === 0) return null;
  const rows = tools.map((tool) => ({ tool, day: stats.byTool[tool] ?? { messages: 0, conversations: 0, started: 0, busyMs: 0, tokens: 0 } }));
  const sum = (key: keyof ToolDay) => rows.reduce((total, row) => total + row.day[key], 0);
  const total = sum("messages");
  const top = (stats.top ?? []).filter((item) => tools.includes(item.tool)).slice(0, compact ? 3 : 5);
  const date = new Date(stats.since).toLocaleDateString(uiLocale(), { month: "long", day: "numeric", weekday: "short" });

  return (
    <section className={compact ? "today is-card" : "today"} aria-label={tr("今天的对话", "Today's conversations")}>
      <header className="today-head">
        <span>{tr("今天", "Today")}</span>
        <time dateTime={new Date(stats.since).toISOString()}>{date}</time>
      </header>

      <p className="today-total">
        <strong>{total.toLocaleString(uiLocale())}</strong>
        <span>{tr("条消息", "messages")}</span>
      </p>

      {total > 0 ? (
        <dl className="today-figures">
          <div>
            <dt>{tr("对话", "Chats")}</dt>
            <dd>{sum("conversations")}</dd>
          </div>
          <div>
            <dt>{tr("今天新开", "New today")}</dt>
            <dd>{sum("started")}</dd>
          </div>
          <div>
            <dt>{tr("AI 回复用时", "AI reply time")}</dt>
            <dd>{compact ? shortDuration(sum("busyMs")) : duration(sum("busyMs"))}</dd>
          </div>
          {sum("tokens") > 0 && (
            <div>
              <dt>{tr("输出 tokens", "Output tokens")}</dt>
              <dd>{tokens(sum("tokens"))}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="today-quiet">{tr("今天还没有发出消息。", "No messages sent today yet.")}</p>
      )}

      <div className="today-strip" aria-hidden="true">
        {total > 0 ? (
          rows
            .filter((row) => row.day.messages > 0)
            .map((row) => <span key={row.tool} style={{ flexGrow: row.day.messages, background: TOOL_COLOR[row.tool] }} />)
        ) : (
          <span className="today-strip-empty" />
        )}
      </div>

      <table className="today-tools">
        <thead>
          <tr>
            <th scope="col">{tr("工具", "Tool")}</th>
            <th scope="col">{tr("消息", "Messages")}</th>
            <th scope="col">{tr("对话", "Chats")}</th>
            <th scope="col">{tr("回复用时", "Reply time")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ tool, day }) => (
            <tr key={tool} className={day.messages ? "" : "is-zero"}>
              <th scope="row">
                <span className="today-tool-name">
                  <span className="today-tool-icon" style={{ color: day.messages ? TOOL_COLOR[tool] : undefined }}>
                    <ToolIcon tool={tool} size={15} />
                  </span>
                  {toolName[tool]}
                </span>
              </th>
              <td>{day.messages}</td>
              <td>{day.conversations}</td>
              <td>{day.messages ? duration(day.busyMs) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {top.length > 0 && (
        <div className="today-top">
          <h2>{tr("今天聊得最多", "Most active today")}</h2>
          <ol>
            {top.map((item) => (
              <li key={`${item.tool}:${item.id}`}>
                <button type="button" onClick={() => onOpen(item.tool, item.id)} title={tr(`打开 ${item.title}`, `Open ${item.title}`)}>
                  <span className="today-tool-icon" style={{ color: TOOL_COLOR[item.tool] }}>
                    <ToolIcon tool={item.tool} size={15} />
                  </span>
                  <span className="today-top-title">{item.title}</span>
                  {item.place && <span className="today-top-place">{item.place}</span>}
                  <span className="today-top-count">
                    {tr(`${item.messages} 条`, `${item.messages}`)}
                    <small>{clock(item.lastAt)}</small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

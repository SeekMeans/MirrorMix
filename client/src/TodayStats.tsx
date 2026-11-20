import { useEffect, useState } from "react";
import { apiRequest, type ToolId } from "./api";
import { toolName } from "./text";
import { ToolIcon } from "./ToolIcon";

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
  if (minutes < 1) return ms > 0 ? "不到 1 分钟" : "0 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/** The same span in a narrow cell: whole minutes under an hour, then hours to one decimal (4.5 小时). */
function shortDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return duration(ms);
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} 小时`;
}

function tokens(count: number): string {
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)} 亿`;
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 1_000_000 ? 0 : 1)} 万`;
  return count.toLocaleString("zh-CN");
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
  const date = new Date(stats.since).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });

  return (
    <section className={compact ? "today is-card" : "today"} aria-label="今天的对话">
      <header className="today-head">
        <span>今天</span>
        <time dateTime={new Date(stats.since).toISOString()}>{date}</time>
      </header>

      <p className="today-total">
        <strong>{total.toLocaleString("zh-CN")}</strong>
        <span>条消息</span>
      </p>

      {total > 0 ? (
        <dl className="today-figures">
          <div>
            <dt>对话</dt>
            <dd>{sum("conversations")}</dd>
          </div>
          <div>
            <dt>今天新开</dt>
            <dd>{sum("started")}</dd>
          </div>
          <div>
            <dt>AI 回复用时</dt>
            <dd>{compact ? shortDuration(sum("busyMs")) : duration(sum("busyMs"))}</dd>
          </div>
          {sum("tokens") > 0 && (
            <div>
              <dt>输出 tokens</dt>
              <dd>{tokens(sum("tokens"))}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="today-quiet">今天还没有发出消息。</p>
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
            <th scope="col">工具</th>
            <th scope="col">消息</th>
            <th scope="col">对话</th>
            <th scope="col">回复用时</th>
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
          <h2>今天聊得最多</h2>
          <ol>
            {top.map((item) => (
              <li key={`${item.tool}:${item.id}`}>
                <button type="button" onClick={() => onOpen(item.tool, item.id)} title={`打开 ${item.title}`}>
                  <span className="today-tool-icon" style={{ color: TOOL_COLOR[item.tool] }}>
                    <ToolIcon tool={item.tool} size={15} />
                  </span>
                  <span className="today-top-title">{item.title}</span>
                  {item.place && <span className="today-top-place">{item.place}</span>}
                  <span className="today-top-count">
                    {item.messages} 条<small>{clock(item.lastAt)}</small>
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

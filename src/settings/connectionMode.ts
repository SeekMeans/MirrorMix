import { readFileSync } from "node:fs";

export type ConnectionMode = "legacy" | "desktop";

/** Machine-local opt-in. Pulling the repository alone preserves the original transport paths. */
export function resolveConnectionMode(file: string, env: NodeJS.ProcessEnv = process.env): ConnectionMode {
  let value: unknown = env.AIMISS_CONNECTION_MODE;
  if (value === undefined) {
    try {
      value = (JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { mode?: unknown }).mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "legacy";
      throw new Error(`无法读取本机通信配置：${file}`, { cause: error });
    }
  }
  if (value === "legacy" || value === "desktop") return value;
  throw new Error("通信模式必须是 legacy 或 desktop，请检查 AIMISS_CONNECTION_MODE 或本机 connection-mode.json");
}

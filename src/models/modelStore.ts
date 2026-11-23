import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SecretBox } from "../settings/secrets";

/**
 * Models added in 设置 → 模型管理: any service that speaks the OpenAI chat-completions format (DeepSeek, 通义千问,
 * Kimi, 智谱, OpenAI, a local Ollama…). The API key is sealed at rest and never sent back to the page.
 */
export interface StoredModel {
  id: string;
  name: string;
  /** Which preset it was made from, only for the page to show; the call is the same for all. */
  provider: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  keySealed?: string;
  createdAt: string;
}

/** What the page sees: the key only as whether there is one and its last four characters. */
export type ModelView = Omit<StoredModel, "keySealed"> & { hasKey: boolean; keyTail: string };

export class ModelError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelStore {
  list(): ModelView[];
  save(value: unknown, id?: string): ModelView;
  remove(id: string): void;
  /** Sends the messages and returns the reply's text. */
  chat(id: string, messages: ChatMessage[], options?: { signal?: AbortSignal; timeoutMs?: number; json?: boolean }): Promise<string>;
}

type Fetch = typeof fetch;

const text = (value: unknown, limit: number) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

export function createModelStore(file: string, box: SecretBox, fetchImpl: Fetch = fetch): ModelStore {
  const read = (): StoredModel[] => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: StoredModel[] };
      return Array.isArray(parsed.models) ? parsed.models : [];
    } catch {
      return [];
    }
  };
  const write = (models: StoredModel[]) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ models }, null, 2));
    renameSync(temp, file);
  };
  const keyOf = (model: StoredModel) => (model.keySealed ? box.unseal(model.keySealed) : "");
  const view = (model: StoredModel): ModelView => {
    const { keySealed, ...rest } = model;
    const key = keySealed ? keyOf(model) : "";
    return { ...rest, hasKey: Boolean(key), keyTail: key.slice(-4) };
  };

  const list = () => read().map(view);

  const save = (value: unknown, id?: string): ModelView => {
    const raw = (value ?? {}) as Record<string, unknown>;
    const models = read();
    const existing = id ? models.find((model) => model.id === id) : undefined;
    if (id && !existing) throw new ModelError(404, "not_found");
    const name = text(raw.name, 60);
    const baseUrl = text(raw.baseUrl, 500).replace(/\/+$/, "");
    const model = text(raw.model, 200);
    if (!name) throw new ModelError(400, "name_required");
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new ModelError(400, "bad_url");
    if (!model) throw new ModelError(400, "model_required");
    if (models.some((item) => item.name === name && item.id !== existing?.id)) throw new ModelError(409, "name_taken");
    // An empty key on edit keeps the saved one; `clearKey` takes it away (a local model needs none).
    const key = text(raw.apiKey, 1_000);
    const keySealed = raw.clearKey === true ? undefined : key ? box.seal(key) : existing?.keySealed;
    const temperature = typeof raw.temperature === "number" && raw.temperature >= 0 && raw.temperature <= 2 ? raw.temperature : undefined;
    const next: StoredModel = {
      id: existing?.id ?? randomUUID().replace(/-/g, "").slice(0, 12),
      name,
      provider: text(raw.provider, 40) || "custom",
      baseUrl,
      model,
      ...(temperature === undefined ? {} : { temperature }),
      ...(keySealed ? { keySealed } : {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    write(existing ? models.map((item) => (item.id === existing.id ? next : item)) : [...models, next]);
    return view(next);
  };

  const remove = (id: string) => {
    const models = read();
    if (!models.some((model) => model.id === id)) throw new ModelError(404, "not_found");
    write(models.filter((model) => model.id !== id));
  };

  const chat: ModelStore["chat"] = async (id, messages, options = {}) => {
    const model = read().find((item) => item.id === id || item.name === id);
    if (!model) throw new ModelError(404, "model_not_found");
    const key = keyOf(model);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 5 * 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: model.model,
          messages,
          stream: false,
          ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
          ...(options.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new Error("已停止");
      if (timeout.aborted) throw new Error("模型没有在规定时间内回复");
      throw new Error(`连不上 ${new URL(model.baseUrl).host}：${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string } | string;
    } | null;
    if (!response.ok) {
      const said = typeof body?.error === "string" ? body.error : body?.error?.message;
      throw new Error(`模型返回 ${response.status}${said ? `：${said.slice(0, 300)}` : ""}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("模型的回复里没有文字");
    return content.trim();
  };

  return { list, save, remove, chat };
}

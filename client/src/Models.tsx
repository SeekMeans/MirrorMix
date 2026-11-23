import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ModelView, type Workflow } from "./api";
import { BackIcon, EditIcon, FlowIcon, PlusIcon, Spinner, TrashIcon } from "./icons";
import { flatten } from "./workflowSteps";
import { Select } from "./Select";

/** Services that speak the OpenAI chat format; choosing one fills in its address and a common model name. */
export const MODEL_PRESETS: { id: string; name: string; mark: string; baseUrl: string; model: string; keyless?: boolean }[] = [
  { id: "deepseek", name: "DeepSeek", mark: "D", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "qwen", name: "通义千问", mark: "通", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "kimi", name: "Kimi", mark: "K", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "zhipu", name: "智谱 GLM", mark: "智", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { id: "openai", name: "OpenAI", mark: "O", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "ollama", name: "Ollama（本机）", mark: "L", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5", keyless: true },
  { id: "custom", name: "自定义（OpenAI 兼容）", mark: "", baseUrl: "", model: "" },
];
const presetOf = (id: string) => MODEL_PRESETS.find((preset) => preset.id === id);
const presetName = (id: string) => presetOf(id)?.name ?? "自定义";

const ERRORS: Record<string, string> = {
  name_required: "请填写名称",
  bad_url: "接口地址要以 http:// 或 https:// 开头",
  model_required: "请填写模型名",
  name_taken: "已经有同名的模型了",
  not_found: "这个模型已经不在了",
};

/** The host the calls go to, which is what tells two models apart at a glance. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

function dateOf(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? "" : `${when.getFullYear()} 年 ${when.getMonth() + 1} 月 ${when.getDate()} 日`;
}

/** The last connection test of each model, kept in this browser so the lights survive leaving the page. */
interface Check {
  busy?: boolean;
  ok?: boolean;
  ms?: number;
  reply?: string;
  message?: string;
  at?: number;
}
const CHECKS_KEY = "mirrormix.model-checks";
function readChecks(): Record<string, Check> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHECKS_KEY) ?? "{}") as Record<string, Check>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveChecks(checks: Record<string, Check>) {
  try {
    const settled = Object.fromEntries(Object.entries(checks).filter(([, check]) => !check.busy));
    localStorage.setItem(CHECKS_KEY, JSON.stringify(settled));
  } catch {
    // Private windows and blocked storage: the lights just start grey next time.
  }
}

function ago(at: number | undefined): string {
  if (!at) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
}

type Lamp = "idle" | "busy" | "ok" | "bad";
const lampOf = (check: Check | undefined): Lamp => (!check ? "idle" : check.busy ? "busy" : check.ok ? "ok" : "bad");
const LAMP_WORD: Record<Lamp, string> = { idle: "未测试", busy: "正在连接", ok: "已连通", bad: "连不上" };

function ModelMark({ model, large = false }: { model: Pick<ModelView, "provider" | "name">; large?: boolean }) {
  const mark = presetOf(model.provider)?.mark || model.name.trim().slice(0, 1).toUpperCase() || "?";
  return (
    <span className={`model-mark is-${model.provider}${large ? " is-large" : ""}`} aria-hidden="true">
      {mark}
    </span>
  );
}

interface Form {
  id?: string;
  provider: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: string;
  hasKey: boolean;
  keyTail: string;
  clearKey: boolean;
}

const blank = (): Form => {
  const preset = MODEL_PRESETS[0];
  return { provider: preset.id, name: preset.name, baseUrl: preset.baseUrl, model: preset.model, apiKey: "", temperature: "", hasKey: false, keyTail: "", clearKey: false };
};

const formOf = (model: ModelView): Form => ({
  id: model.id,
  provider: model.provider,
  name: model.name,
  baseUrl: model.baseUrl,
  model: model.model,
  apiKey: "",
  temperature: model.temperature === undefined ? "" : String(model.temperature),
  hasKey: model.hasKey,
  keyTail: model.keyTail,
  clearKey: false,
});

/** The workflows with a model step that calls this model, by id or by name. */
function usersOf(model: ModelView, flows: Workflow[] | null): Workflow[] {
  return (flows ?? []).filter((flow) =>
    flatten(flow.steps).some((step) => step.kind === "model" && (step.modelId === model.id || step.modelId === model.name)),
  );
}

/** 设置 → 模型管理: the models 工作流 can ask directly, by API. A list of cards; a card opens its model. */
export function ModelManager() {
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [flows, setFlows] = useState<Workflow[] | null>(null);
  /** The model open in detail, or null for the list. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checks, setChecks] = useState<Record<string, Check>>(readChecks);

  const load = useCallback(async () => {
    try {
      setModels((await api.models()).models);
    } catch {
      setError("读取模型列表失败，刷新页面再试一次");
    }
  }, []);
  useEffect(() => {
    void load();
    api
      .workflows()
      .then((result) => setFlows(result.workflows))
      .catch(() => setFlows([]));
  }, [load]);

  const putCheck = (id: string, check: Check) =>
    setChecks((current) => {
      const next = { ...current, [id]: check };
      saveChecks(next);
      return next;
    });

  const test = async (model: ModelView) => {
    putCheck(model.id, { busy: true });
    try {
      const result = await api.testModel(model.id);
      putCheck(model.id, result.ok ? { ok: true, ms: result.ms, reply: result.reply, at: Date.now() } : { ok: false, message: result.message, at: Date.now() });
    } catch {
      putCheck(model.id, { ok: false, message: "测试请求没有发到 MirrorMix，检查一下网络", at: Date.now() });
    }
  };

  const open = models?.find((model) => model.id === openId) ?? null;
  const users = useMemo(() => (open ? usersOf(open, flows) : []), [open, flows]);

  const choosePreset = (id: string) => {
    const preset = presetOf(id);
    if (!form || !preset) return;
    const named = !form.name || MODEL_PRESETS.some((item) => item.name === form.name);
    setForm({ ...form, provider: id, baseUrl: preset.baseUrl || form.baseUrl, model: preset.model || form.model, name: named ? preset.name : form.name });
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      const temperature = form.temperature.trim() === "" ? undefined : Number(form.temperature);
      const saved = await api.saveModel(
        { provider: form.provider, name: form.name, baseUrl: form.baseUrl, model: form.model, apiKey: form.apiKey, clearKey: form.clearKey, temperature },
        form.id,
      );
      setForm(null);
      setOpenId(saved.id);
      await load();
      // Saved, then tried straight away: the detail shows whether the service answers with this address and key.
      void test(saved);
    } catch (failure) {
      setError(ERRORS[(failure as { code?: string }).code ?? ""] ?? "保存失败，再试一次");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (model: ModelView) => {
    const using = usersOf(model, flows);
    const warn = using.length ? `\n${using.map((flow) => `“${flow.name}”`).join("、")}用到了它，删除后这些步骤会运行失败。` : "";
    if (!window.confirm(`删除模型“${model.name}”？${warn}`)) return;
    try {
      await api.deleteModel(model.id);
      setOpenId(null);
      setChecks((current) => {
        const { [model.id]: _gone, ...rest } = current;
        saveChecks(rest);
        return rest;
      });
      await load();
    } catch (failure) {
      setError(ERRORS[(failure as { code?: string }).code ?? ""] ?? "删除失败，再试一次");
    }
  };

  const banner = error && <p className="banner is-warning">{error}</p>;

  // Adding, or editing the open model.
  if (form) {
    const keyless = presetOf(form.provider)?.keyless;
    return (
      <div className="models">
        {banner}
        <button type="button" className="model-back" onClick={() => setForm(null)}>
          <BackIcon />
          {form.id ? form.name || "返回" : "全部模型"}
        </button>
        <div className="model-form">
          <h3>{form.id ? "编辑模型" : "添加模型"}</h3>
          <label className="flow-field">
            <span>服务商</span>
            <Select
              ariaLabel="服务商"
              value={form.provider}
              onChange={choosePreset}
              options={MODEL_PRESETS.map((preset) => ({
                value: preset.id,
                label: preset.name,
                hint: preset.baseUrl ? hostOf(preset.baseUrl) : "任何 OpenAI 兼容的接口",
                icon: <ModelMark model={{ provider: preset.id, name: preset.name }} />,
              }))}
            />
          </label>
          <div className="flow-field-row">
            <label className="flow-field">
              <span>名称</span>
              <input value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label className="flow-field">
              <span>模型名</span>
              <input value={form.model} placeholder="deepseek-chat" onChange={(event) => setForm({ ...form, model: event.target.value })} />
            </label>
          </div>
          <label className="flow-field">
            <span>接口地址</span>
            <input value={form.baseUrl} placeholder="https://…/v1" onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
          </label>
          <label className="flow-field">
            <span>API Key</span>
            <input
              type="password"
              autoComplete="off"
              value={form.apiKey}
              placeholder={form.hasKey && !form.clearKey ? `已保存 ••••${form.keyTail}，留空不改` : keyless ? "本机模型不需要" : "sk-…"}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            />
            {form.hasKey && (
              <label className="flow-check">
                <input type="checkbox" checked={form.clearKey} onChange={(event) => setForm({ ...form, clearKey: event.target.checked })} />
                去掉已保存的密钥
              </label>
            )}
            <em className="flow-hint">密钥用 Windows 加密保存在这台电脑上，不会再显示出来。</em>
          </label>
          <label className="flow-field is-short">
            <span>温度（可不填）</span>
            <input type="number" min={0} max={2} step={0.1} value={form.temperature} placeholder="默认" onChange={(event) => setForm({ ...form, temperature: event.target.value })} />
          </label>
          <div className="model-form-actions">
            <button type="button" className="quiet-button" onClick={() => setForm(null)}>
              取消
            </button>
            <button type="button" className="quiet-button is-primary" disabled={busy} onClick={() => void save()}>
              {busy ? <Spinner /> : null}
              保存并测试连接
            </button>
          </div>
        </div>
      </div>
    );
  }

  // One model.
  if (open) {
    const check = checks[open.id];
    const lamp = lampOf(check);
    return (
      <div className="models">
        {banner}
        <button type="button" className="model-back" onClick={() => setOpenId(null)}>
          <BackIcon />
          全部模型
        </button>
        <header className="model-detail-head">
          <ModelMark model={open} large />
          <div className="model-detail-title">
            <h3>{open.name}</h3>
            <span>{presetName(open.provider)}</span>
          </div>
          <span className="model-detail-tools">
            <button type="button" className="quiet-button" onClick={() => setForm(formOf(open))}>
              <EditIcon />
              编辑
            </button>
            <button type="button" className="quiet-button is-delete" onClick={() => void remove(open)}>
              <TrashIcon />
              删除
            </button>
          </span>
        </header>

        <section className={`model-line is-${lamp}`} aria-live="polite">
          <div className="model-line-path">
            <span className="model-line-end">MirrorMix</span>
            <span className="model-line-wire" aria-hidden="true" />
            <span className="model-line-end">{hostOf(open.baseUrl)}</span>
          </div>
          <div className="model-line-state">
            <span className={`model-lamp is-${lamp}`} aria-hidden="true" />
            <strong>{LAMP_WORD[lamp]}</strong>
            {lamp === "ok" && check?.ms !== undefined && <span>用时 {seconds(check.ms)}</span>}
            {(lamp === "ok" || lamp === "bad") && <span className="model-line-when">{ago(check?.at)}</span>}
            <button type="button" className="quiet-button is-primary" disabled={lamp === "busy"} onClick={() => void test(open)}>
              {lamp === "busy" ? <Spinner /> : null}
              {lamp === "idle" ? "测试连接" : lamp === "busy" ? "正在连接" : "再测一次"}
            </button>
          </div>
          {lamp === "ok" && check?.reply && <blockquote className="model-line-reply">{check.reply}</blockquote>}
          {lamp === "bad" && <p className="model-line-error">{check?.message}</p>}
          {lamp === "idle" && <p className="model-line-note">发一句话给模型，看它能不能用这个地址和密钥回答。</p>}
        </section>

        <dl className="model-facts">
          <div>
            <dt>模型名</dt>
            <dd>
              <code>{open.model}</code>
            </dd>
          </div>
          <div>
            <dt>接口地址</dt>
            <dd>
              <code>{open.baseUrl}</code>
            </dd>
          </div>
          <div>
            <dt>API Key</dt>
            <dd>{open.hasKey ? `已保存，结尾是 ${open.keyTail}` : presetOf(open.provider)?.keyless ? "本机模型，不需要" : "还没填"}</dd>
          </div>
          <div>
            <dt>温度</dt>
            <dd>{open.temperature ?? "服务默认"}</dd>
          </div>
          {dateOf(open.createdAt) && (
            <div>
              <dt>添加时间</dt>
              <dd>{dateOf(open.createdAt)}</dd>
            </div>
          )}
        </dl>

        <section className="model-users">
          <h4>用到它的工作流</h4>
          {flows === null ? (
            <p className="model-users-none">正在读取…</p>
          ) : users.length ? (
            <ul>
              {users.map((flow) => (
                <li key={flow.id}>
                  <FlowIcon size={15} />
                  {flow.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="model-users-none">还没有工作流用它。在工作流里加一个“模型”步骤，就能选到它。</p>
          )}
        </section>
      </div>
    );
  }

  // Every model.
  return (
    <div className="models">
      {banner}
      {models === null ? (
        <p className="blank">正在读取…</p>
      ) : (
        <ul className="model-cards">
          {models.map((model) => {
            const check = checks[model.id];
            const lamp = lampOf(check);
            return (
              <li key={model.id}>
                <button type="button" className="model-card" onClick={() => setOpenId(model.id)} aria-label={`${model.name}，${LAMP_WORD[lamp]}，打开详情`}>
                  <span className="model-card-top">
                    <ModelMark model={model} />
                    <span className="model-card-name">
                      <strong>{model.name}</strong>
                      <span>{presetName(model.provider)}</span>
                    </span>
                  </span>
                  <code className="model-card-model">{model.model}</code>
                  <span className="model-card-foot">
                    <span className="model-card-host">{hostOf(model.baseUrl)}</span>
                    <span className={`model-card-state is-${lamp}`}>
                      <span className={`model-lamp is-${lamp}`} aria-hidden="true" />
                      {lamp === "ok" && check?.ms !== undefined ? seconds(check.ms) : LAMP_WORD[lamp]}
                    </span>
                  </span>
                  {!model.hasKey && !presetOf(model.provider)?.keyless && <span className="model-card-flag">还没填 API Key</span>}
                </button>
              </li>
            );
          })}
          <li>
            <button type="button" className="model-card is-new" onClick={() => setForm(blank())}>
              <PlusIcon />
              <strong>添加模型</strong>
              <span>{models.length ? "DeepSeek、通义千问、Kimi，或任何 OpenAI 兼容的接口" : "添加后，工作流里的“模型”步骤就能直接调用它"}</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

/** One program a project runs while being worked on: its frontend dev server, its backend… */
export interface ProjectService {
  /** Shown on its terminal tab, e.g. "前端" or "后端". */
  name: string;
  /** Folder under the project root it starts in; "" for the root itself. */
  dir: string;
  /** Typed into its tab, e.g. "npm run dev". */
  command: string;
}

export interface ServiceView extends ProjectService {
  /** Its terminal tab, while one is open. */
  tid?: string;
  /** Something started from its tab is still running. */
  running: boolean;
}

export interface ServiceList {
  root: string;
  services: ServiceView[];
}

export type ServiceAction = "start" | "stop" | "restart";

export const MAX_SERVICES = 6;

export interface Shortcut {
  group: string;
  name: string;
  command: string;
}

export interface ShortcutLibrary {
  commands: Shortcut[];
  revision: string;
  file: string;
}

export const COMMIT_MESSAGE_TOKEN = "{{message}}";

export const DEFAULT_SHORTCUTS: Shortcut[] = [
  { group: "git命令包", name: "提交并推送", command: 'git add . && git commit -m "{{message}}" && git pull && git push' },
  { group: "git命令包", name: "查看状态", command: "git status" },
  { group: "git命令包", name: "查看改动统计", command: "git diff --stat" },
];

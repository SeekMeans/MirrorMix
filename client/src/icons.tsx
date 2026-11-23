import type { ReactNode } from "react";

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PlusIcon = () => <Icon><path d="M8 3.5v9M3.5 8h9" /></Icon>;
/** A shield with a question mark: a host whose key has not been confirmed. */
export const ShieldQuestionIcon = () => (
  <Icon size={14}>
    <path d="M8 1.8 13 3.6v4c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6v-4Z" />
    <path d="M6.6 6.4a1.5 1.5 0 1 1 2.1 1.4c-.5.2-.7.6-.7 1.1v.2M8 11h.01" />
  </Icon>
);
/** Two stacked server units: the SSH plugin. */
export const ServerIcon = () => (
  <Icon>
    <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" />
    <rect x="2.5" y="9" width="11" height="4.5" rx="1.2" />
    <path d="M5 4.75h.01M5 11.25h.01M8 4.75h3M8 11.25h3" />
  </Icon>
);
export const HomeIcon = () => (
  <Icon size={22}>
    <path d="M2.5 7.2 8 2.8l5.5 4.4" />
    <path d="M4 6.2v6.3a.8.8 0 0 0 .8.8h6.4a.8.8 0 0 0 .8-.8V6.2" />
    <path d="M6.6 13.3V9.9h2.8v3.4" />
  </Icon>
);
/** A pushpin, for sessions pinned in MirrorMix. Filled once pinned. */
export const PushpinIcon = ({ size = 22, filled = false }: { size?: number; filled?: boolean }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.6 2.2 13.8 6.4l-1.4.6-2.3 2.3.3 3-1 1-2.5-2.5L3.4 14.3M6.9 10.8 5.2 9.1M4.4 6.1l1-1 3 .3 2.3-2.3.9-1.4" fill={filled ? "currentColor" : "none"} />
  </svg>
);
/** A desk of four panels: 工作台, where every tool's live sessions are laid out. */
export const WorkbenchIcon = () => (
  <Icon size={22}>
    <rect x="2.4" y="2.4" width="5" height="6.2" rx="1.2" />
    <rect x="8.6" y="2.4" width="5" height="3.6" rx="1.2" />
    <rect x="8.6" y="7.2" width="5" height="6.4" rx="1.2" />
    <rect x="2.4" y="9.8" width="5" height="3.8" rx="1.2" />
  </Icon>
);
export const ChevronIcon = () => <Icon size={12}><path d="m5.5 3.5 4.5 4.5-4.5 4.5" /></Icon>;
export const CloseIcon = () => <Icon><path d="m4 4 8 8M12 4l-8 8" /></Icon>;
export const MenuIcon = () => <Icon size={18}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></Icon>;
export const DownIcon = () => <Icon><path d="M8 3v9.5M4 8.8l4 4 4-4" /></Icon>;
export const SendIcon = () => <Icon><path d="M8 13V3.5M4 7.2l4-4 4 4" /></Icon>;
/** 工作流: three blocks joined top to bottom, the middle one branching. */
export const FlowIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="5.4" y="1.8" width="5.2" height="3.2" rx="1" />
    <rect x="1.8" y="11" width="5.2" height="3.2" rx="1" />
    <rect x="9" y="11" width="5.2" height="3.2" rx="1" />
    <path d="M8 5v2.8M4.4 11V9.4a1.6 1.6 0 0 1 1.6-1.6h4a1.6 1.6 0 0 1 1.6 1.6V11" />
  </Icon>
);
/** 模型: a chip. */
export const ModelIcon = () => (
  <Icon>
    <rect x="4" y="4" width="8" height="8" rx="1.6" />
    <path d="M6.5 6.5h3v3h-3zM6 1.8V4M10 1.8V4M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2" />
  </Icon>
);
export const PlayIcon = () => (
  <Icon>
    <path d="M5 3.4v9.2a.5.5 0 0 0 .76.43l7.3-4.6a.5.5 0 0 0 0-.86l-7.3-4.6A.5.5 0 0 0 5 3.4z" />
  </Icon>
);
export const StopIcon = () => (
  <Icon>
    <rect x="4" y="4" width="8" height="8" rx="1.4" />
  </Icon>
);
export const DragIcon = () => (
  <Icon>
    <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth="2.2" />
  </Icon>
);
export const PuzzleIcon = () => (
  <Icon>
    <path d="M6.2 2.6a1.5 1.5 0 0 1 3 0v1H12a.8.8 0 0 1 .8.8v2.4h-.9a1.5 1.5 0 0 0 0 3h.9v2.4a.8.8 0 0 1-.8.8H9.6v-.9a1.5 1.5 0 0 0-3 0v.9H4a.8.8 0 0 1-.8-.8V9.8h.9a1.5 1.5 0 0 0 0-3h-.9V4.4a.8.8 0 0 1 .8-.8h2.2z" />
  </Icon>
);
export const StoreIcon = () => (
  <Icon>
    <path d="M2.4 6.2 3.4 2.8h9.2l1 3.4M2.4 6.2c0 1 .8 1.6 1.7 1.6s1.7-.6 1.7-1.6c0 1 .8 1.6 1.7 1.6s1.7-.6 1.7-1.6c0 1 .8 1.6 1.7 1.6s1.7-.6 1.7-1.6M2.4 6.2h11.2M3.4 7.8v5.4h9.2V7.8M6.6 13.2v-3h2.8v3" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.6" />
    <path d="m10.4 10.4 3.4 3.4" />
  </Icon>
);
export const CollapseIcon = () => (
  <Icon>
    <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6" />
    <path d="M5.2 8h5.6" />
  </Icon>
);
export const UpIcon = () => <Icon><path d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5" /></Icon>;
export const RefreshIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
    <path d="M13 2.8v2.6h-2.6" />
  </Icon>
);
export const FolderIcon = () => (
  <Icon>
    <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
  </Icon>
);
/** A picture: a frame with a sun and a hill. */
export const ImageIcon = () => (
  <Icon>
    <rect x="2" y="2.8" width="12" height="10.4" rx="1.6" />
    <circle cx="5.6" cy="6.2" r="1.1" />
    <path d="m2.6 11.6 3.3-3.1 2.4 2.1 2.2-1.9 3 2.7" />
  </Icon>
);
export const FileIcon = () => (
  <Icon>
    <path d="M4 1.8h5l3.2 3.2v8c0 .7-.5 1.2-1.2 1.2H4c-.7 0-1.2-.5-1.2-1.2V3c0-.7.5-1.2 1.2-1.2z" />
    <path d="M9 1.8V5h3.2" />
  </Icon>
);
export const HelpIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.2 6.3a1.9 1.9 0 0 1 3.7.5c0 1.3-1.9 1.6-1.9 2.8M8 11.4v.1" />
  </Icon>
);
export const ConsoleIcon = () => (
  <Icon>
    <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="1.4" />
    <path d="M4 6.2 6.3 8 4 9.8M7.6 10.2h4.2" />
  </Icon>
);
export const ComputerIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="8" rx="1.2" />
    <path d="M6 13.4h4M8 11v2.4" />
  </Icon>
);
export const LeaveIcon = () => (
  <Icon>
    <path d="M6.4 2.4H3.6a1.2 1.2 0 0 0-1.2 1.2v8.8a1.2 1.2 0 0 0 1.2 1.2h2.8" />
    <path d="M6.6 8h7.2M11.2 5.2 14 8l-2.8 2.8" />
  </Icon>
);
export const GearIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.8v1.7M8 12.500v1.700M1.800 8h1.700M12.500 8h1.700M3.600 3.600l1.200 1.200M11.200 11.200l1.200 1.200M3.600 12.400l1.200-1.200M11.200 4.800l1.200-1.200" />
  </Icon>
);
/** Half a disc: light or dark. */
export const ContrastIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 2.4v11.2a5.6 5.6 0 0 0 0-11.2Z" fill="currentColor" stroke="none" />
  </Icon>
);
export const SlidersIcon = () => (
  <Icon>
    <path d="M2.500 5h6M11.500 5h2M2.500 11h2M7.500 11h6" />
    <circle cx="10" cy="5" r="1.500" />
    <circle cx="6" cy="11" r="1.500" />
  </Icon>
);
export const BackIcon = () => <Icon size={20}><path d="M10 3.5 5.5 8l4.5 4.5" /></Icon>;
/** Two speech outlines: the list of conversations. */
export const ChatsIcon = () => (
  <Icon size={20}>
    <path d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h5.6c.9 0 1.6.7 1.6 1.6v3.3c0 .9-.7 1.6-1.6 1.6H6L3.8 10.8V9.1h.3c-.9 0-1.6-.7-1.6-1.6Z" />
    <path d="M11.3 6h.6c.9 0 1.6.7 1.6 1.6v3.1c0 .9-.7 1.6-1.6 1.6h-.2v1.6l-2.1-1.6H7.8c-.7 0-1.3-.5-1.5-1.1" />
  </Icon>
);
export const GlobeIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M2.6 8h10.8M8 2.4c1.6 1.6 2.3 3.5 2.3 5.6S9.6 12 8 13.6M8 2.4C6.4 4 5.7 5.9 5.7 8s.7 4 2.3 5.6" />
  </Icon>
);
export const DownloadIcon = () => <Icon><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13h10" /></Icon>;
export const EyeIcon = () => (
  <Icon>
    <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Icon>
);
export const EyeOffIcon = () => (
  <Icon>
    <path d="M6.3 4.1A6 6 0 0 1 8 3.8c4 0 6.2 4.2 6.2 4.2a10.6 10.6 0 0 1-1.7 2.3M10 11.7a5.6 5.6 0 0 1-2 .5C4 12.2 1.8 8 1.8 8a10.8 10.8 0 0 1 2.4-2.9" />
    <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8M2.5 2.5l11 11" />
  </Icon>
);
export const EditIcon = () => (
  <Icon>
    <path d="M10.6 3.2 12.8 5.4 6 12.2 3.4 12.6 3.8 10z" />
    <path d="m9.4 4.4 2.2 2.2" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5" />
    <path d="M4.5 4.5 5.2 13h5.6l.7-8.5M7 7v4M9 7v4" />
  </Icon>
);
export const ClockIcon = () => <Icon><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></Icon>;
/**
 * Three bars rising and falling in turn: a reply is still being written. Stands in for the word “运行中”,
 * which stays as its accessible name and tooltip. `still` keeps the bars at rest when nothing is running.
 */
export function BusyIcon({ still = false, label = "运行中" }: { still?: boolean; label?: string }) {
  return (
    <span className={still ? "busy is-still" : "busy"} role="img" aria-label={label} title={label}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** The same green bolt the AI tools put beside a reply you have not opened yet. */
export function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path fill="currentColor" d="M10.2 1.5 14.5 5.8l-1.3.5-2.2 2.2.4 3.1-1 1-2.6-2.6-3.7 3.7-.8-.8 3.7-3.7L4.4 6.6l1-1 3.1.4 2.2-2.2.5-1.3Z" />
    </svg>
  );
}

export function BoltIcon() {
  return (
    <svg className="session-bolt" viewBox="0 0 16 16" width="13" height="13" aria-label="有新回复" role="img">
      <title>有新回复</title>
      <path fill="currentColor" d="M9.3 1.1 3.1 9h3.7L6 14.9 13 6.7H9.2L9.3 1.1Z" />
    </svg>
  );
}

/** Two lines that meet and carry on as one: the two tools, patched through a single desk. */
export function Mark() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M3 6h5.5c3 0 4 2 5 6s2 6 5 6H21" stroke="currentColor" />
      <path d="M3 18h5.5c1.6 0 2.6-.6 3.4-1.8" stroke="var(--signal)" />
      <path d="M15.1 7.8C15.9 6.6 16.9 6 18.500 6H21" stroke="var(--signal)" />
    </svg>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

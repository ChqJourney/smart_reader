import React from "react";

export type IconName =
  | "open"
  | "close"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "chevron-down"
  | "settings"
  | "page-prev"
  | "page-next"
  | "zoom-in"
  | "zoom-out"
  | "translate"
  | "explain"
  | "stash"
  | "dictionary"
  | "minus"
  | "chat"
  | "single-page"
  | "continuous-page"
  | "hide-left"
  | "hide-right"
  | "pdf"
  | "ai"
  | "edit"
  | "panel-left"
  | "panel-right"
  | "panel-collapse-left"
  | "panel-expand-left"
  | "panel-collapse-right"
  | "panel-expand-right"
  | "fit-to-width"
  | "search"
  | "bookmark"
  | "clock"
  | "pin"
  | "table-of-contents"
  | "minimize"
  | "maximize"
  | "restore"
  | "copy"
  | "comment";

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  open: (
    <>
      <path
        d="M2 6h4l2 2h8a2 2 0 0 1 2 2v6H4V6h-.01z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M2 6V4a1 1 0 0 1 1-1h5.59a1 1 0 0 1 .7.29l1.42 1.42a1 1 0 0 0 .7.29H14a1 1 0 0 1 1 1v1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  close: (
    <>
      <path
        d="M5 5l10 10M15 5L5 15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  "chevron-left": (
    <path
      d="M11 4L5 10l6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "chevron-right": (
    <path
      d="M5 4l6 6-6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "chevron-up": (
    <path
      d="M4 11l6-6 6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "chevron-down": (
    <path
      d="M4 7l6 6 6-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  settings: (
    <>
      <circle
        cx="10"
        cy="10"
        r="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M18 10L15.39 11.07L14.57 13.06L15.66 15.66L13.06 14.57L11.07 15.39L10 18L8.93 15.39L6.94 14.57L4.34 15.66L5.43 13.06L4.61 11.07L2 10L4.61 8.93L5.43 6.94L4.34 4.34L6.94 5.43L8.93 4.61L10 2L11.07 4.61L13.06 5.43L15.66 4.34L14.57 6.94L15.39 8.93Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </>
  ),
  "page-prev": (
    <path
      d="M9 4l-6 6 6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "page-next": (
    <path
      d="M7 4l6 6-6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "zoom-in": (
    <>
      <circle
        cx="8.5"
        cy="8.5"
        r="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M13 13l4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M8.5 6v5M6 8.5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  "zoom-out": (
    <>
      <circle
        cx="8.5"
        cy="8.5"
        r="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M13 13l4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M6 8.5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  translate: (
    <>
      <path
        d="M2 5h16M7 5l-1.5 9M13 5l1.5 4.5h3M13 16.5h4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  explain: (
    <>
      <path
        d="M10 2a5 5 0 0 0-5 5c0 2 1.5 3.5 2.5 5h5c1-1.5 2.5-3 2.5-5a5 5 0 0 0-5-5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M8 15h4M8 17h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  stash: (
    <>
      <path
        d="M5 3h10v14l-5-3-5 3V3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M8 8h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  dictionary: (
    <>
      <path
        d="M3 4a2 2 0 0 1 2-2h5v16H5a2 2 0 0 1-2-2V4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M10 2h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5V2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M6 6h2M6 10h2M13 6h2M13 10h2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  minus: (
    <path
      d="M4 10h12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),
  chat: (
    <>
      <path
        d="M4 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "single-page": (
    <>
      <rect
        x="4"
        y="3"
        width="12"
        height="14"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </>
  ),
  "continuous-page": (
    <>
      <rect
        x="4"
        y="2"
        width="12"
        height="6"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="4"
        y="10"
        width="12"
        height="6"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </>
  ),
  "hide-left": (
    <path
      d="M14 4l-6 6 6 6M4 4v12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "hide-right": (
    <path
      d="M6 4l6 6-6 6M16 4v12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  pdf: (
    <>
      <path
        d="M4 2h8l6 6v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M12 2v6h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  ai: (
    <>
      <path
        d="M10 2l2 4h4l-3 3 1 4-4-2-4 2 1-4-3-3h4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </>
  ),
  edit: (
    <>
      <path
        d="M14 3l3 3-9 9H5v-3l9-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "panel-left": (
    <>
      <rect
        x="3"
        y="3"
        width="14"
        height="14"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M7 3v14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  "panel-right": (
    <>
      <rect
        x="3"
        y="3"
        width="14"
        height="14"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M13 3v14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  "panel-collapse-left": (
    <>
      <path
        d="M3 6h8M3 10h8M3 14h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M15 6l-4 4 4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "panel-expand-left": (
    <>
      <path
        d="M3 6h8M3 10h8M3 14h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M11 6l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "panel-collapse-right": (
    <>
      <path
        d="M5 6l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 6h8M9 10h8M9 14h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  "panel-expand-right": (
    <>
      <path
        d="M9 6l-4 4 4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 6h8M9 10h8M9 14h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  "fit-to-width": (
    <>
      <rect
        x="2"
        y="5"
        width="16"
        height="10"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M6 8l-3 2 3 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 8l3 2-3 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  search: (
    <>
      <circle
        cx="9"
        cy="9"
        r="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M13 13l4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  bookmark: (
    <>
      <path
        d="M5 2h10a1 1 0 0 1 1 1v15l-6-3-6 3V3a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  clock: (
    <>
      <circle
        cx="10"
        cy="10"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M10 5.5V10l3 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  pin: (
    <>
      <path
        d="M6.5 2.5h7L12.5 9l2.5 3h-4l-.8 5.5L9.4 12h-4L8 9 6.5 2.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </>
  ),
  "table-of-contents": (
    <>
      <path
        d="M7 6h9M7 10h9M7 14h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="4.5" cy="6" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="10" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="14" r="1.2" fill="currentColor" />
    </>
  ),
  minimize: (
    <path
      d="M5 14h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),
  maximize: (
    <rect
      x="4"
      y="4"
      width="12"
      height="12"
      rx="1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    />
  ),
  restore: (
    <>
      <rect
        x="7"
        y="4"
        width="9"
        height="9"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M4 13V7a1 1 0 0 1 1-1h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </>
  ),
  copy: (
    <>
      <rect
        x="7"
        y="7"
        width="9"
        height="9"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M4 12V4a1 1 0 0 1 1-1h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  comment: (
    <>
      <path
        d="M4 4h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H8l-4 3v-3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </>
  ),
};

export default function Icon({ name, size = 16, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`icon ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

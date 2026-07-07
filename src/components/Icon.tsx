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
  | "minus"
  | "chat"
  | "single-page"
  | "continuous-page"
  | "hide-left"
  | "hide-right"
  | "pdf"
  | "ai"
  | "panel-left"
  | "panel-right";

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  open: (
    <>
      <path d="M2 6h4l2 2h8a2 2 0 0 1 2 2v6H4V6h-.01z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M2 6V4a1 1 0 0 1 1-1h5.59a1 1 0 0 1 .7.29l1.42 1.42a1 1 0 0 0 .7.29H14a1 1 0 0 1 1 1v1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  close: (
    <>
      <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  "chevron-left": (
    <path d="M11 4L5 10l6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  "chevron-right": (
    <path d="M5 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  "chevron-up": (
    <path d="M4 11l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  "chevron-down": (
    <path d="M4 7l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 2 L12.1 4.5 L14.7 5.3 L16.6 7.2 L18 10 L16.6 12.8 L14.7 14.7 L12.1 15.5 L10 18 L7.9 15.5 L5.3 14.7 L3.4 12.8 L2 10 L3.4 7.2 L5.3 5.3 L7.9 4.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </>
  ),
  "page-prev": (
    <path d="M9 4l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  "page-next": (
    <path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  "zoom-in": (
    <>
      <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 13l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8.5 6v5M6 8.5h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 13l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 8.5h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  translate: (
    <>
      <path d="M2 5h16M7 5l-1.5 9M13 5l1.5 4.5h3M13 16.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  explain: (
    <>
      <path d="M10 2a5 5 0 0 0-5 5c0 2 1.5 3.5 2.5 5h5c1-1.5 2.5-3 2.5-5a5 5 0 0 0-5-5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 15h4M8 17h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  minus: (
    <path d="M4 10h12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  ),
  chat: (
    <>
      <path d="M4 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  "single-page": (
    <>
      <rect x="4" y="3" width="12" height="14" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  "continuous-page": (
    <>
      <rect x="4" y="2" width="12" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="4" y="10" width="12" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  "hide-left": (
    <path d="M14 4l-6 6 6 6M4 4v12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  "hide-right": (
    <path d="M6 4l6 6-6 6M16 4v12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  pdf: (
    <>
      <path d="M4 2h8l6 6v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 2v6h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  ai: (
    <>
      <path d="M10 2l2 4h4l-3 3 1 4-4-2-4 2 1-4-3-3h4z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </>
  ),
  "panel-left": (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3v14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  "panel-right": (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 3v14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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

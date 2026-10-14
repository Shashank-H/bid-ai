import type { CSSProperties } from 'react';

const paths = {
  compose: 'M12 20H4V4h8 M16 3l5 5-9 9-6 1 1-6z M14 5l5 5',
  panel: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M9 3v18',
  chat: 'M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M20 12a8 8 0 0 0-14-5 M4 12a8 8 0 0 0 14 5',
  logout: 'M9 3H4v18h5 M9 12h12 M17 8l4 4-4 4',
  send: 'M12 20V4 M5 11l7-7 7 7',
  stop: 'M6 6h12v12H6z',
  chart: 'M4 3v17h17 M8 16v-5 M13 16V7 M18 16V4',
  compare: 'M3 7h18 M17 3l4 4-4 4 M21 17H3 M7 13l-4 4 4 4',
  settings: 'M4 7h16 M4 17h16 M9 4v6 M15 14v6',
  history: 'M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2',
  database: 'M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6 M4 12c0 4 16 4 16 0',
  check: 'M5 12l4 4L19 6',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v6 M12 16h.01',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  evidence: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, style }: { name: IconName; style?: CSSProperties }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}>
    <path d={paths[name]} />
  </svg>;
}

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

export function EvidenceIndicator({
  title,
  anchorIds,
  children,
}: {
  title: string;
  anchorIds: string[];
  children: ReactNode;
}) {
  const popupId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressFocus = useRef(false);
  const [open, setOpen] = useState(false);

  function keepOpen() {
    clearTimeout(timer.current);
  }

  function close() {
    keepOpen();
    popup.current?.hidePopover();
  }

  function dismissAndFocus() {
    suppressFocus.current = true;
    close();
    trigger.current?.focus({ preventScroll: true });
    queueMicrotask(() => {
      suppressFocus.current = false;
    });
  }

  function show() {
    keepOpen();
    const panel = popup.current;
    const button = trigger.current;
    if (!panel || !button) return;

    panel.showPopover();
    const anchor = button.getBoundingClientRect();
    const height = panel.getBoundingClientRect().height;
    const width = panel.getBoundingClientRect().width;
    const below = window.innerHeight - anchor.bottom;
    const top =
      below >= height + 8 || below >= anchor.top ? anchor.bottom + 6 : anchor.top - height - 6;

    panel.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
  }

  function queueHover() {
    keepOpen();
    timer.current = setTimeout(() => {
      if (trigger.current?.matches(':hover')) show();
    }, 450);
  }

  function leave() {
    keepOpen();
    timer.current = setTimeout(() => {
      if (!popup.current?.contains(document.activeElement)) close();
    }, 180);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;

    const dismiss = () => popup.current?.hidePopover();
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      dismiss();
    };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);

    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  return (
    <article
      className="evidence-card"
      id={anchorIds[0]}
      onMouseLeave={leave}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          dismissAndFocus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      {anchorIds.slice(1).map((id) => (
        <span key={id} id={id} />
      ))}
      <button
        ref={trigger}
        className="secondary evidence-indicator"
        aria-expanded={open}
        aria-controls={popupId}
        aria-haspopup="dialog"
        onMouseEnter={queueHover}
        onFocus={(event) => {
          if (!suppressFocus.current && event.currentTarget.matches(':focus-visible')) show();
        }}
        onClick={show}
      >
        <Icon name="evidence" />
        <span>{title}</span>
      </button>
      <div
        ref={popup}
        id={popupId}
        popover="auto"
        role="dialog"
        aria-label={title}
        className="evidence-popover"
        onMouseEnter={keepOpen}
        onMouseLeave={leave}
        onToggle={(event) => setOpen(event.newState === 'open')}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('.show-evidence')) close();
        }}
      >
        <button
          className="text-button evidence-dismiss"
          aria-label="Close evidence"
          onClick={dismissAndFocus}
        >
          ×
        </button>
        {children}
      </div>
    </article>
  );
}

'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';

interface SessionPopoverProps {
  sessionId: string;
  project: string;          // encoded project name
  projectPath?: string;     // original filesystem path (needed for boot)
  label?: React.ReactNode;  // custom display content; defaults to truncated sessionId
  firstPrompt?: string;
  messageCount?: number;
  gitBranch?: string;
}

export function SessionPopover({
  sessionId,
  project,
  projectPath,
  label,
  firstPrompt,
  messageCount,
  gitBranch,
}: SessionPopoverProps) {
  const [open, setOpen] = useState(false);
  const [yolo, setYolo] = useState(false);
  const [bootResult, setBootResult] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function boot(resume: boolean) {
    if (!projectPath) return;
    setBooting(true);
    setBootResult(null);
    try {
      const res = await fetch('/api/boot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          projectName: project,
          sessionId: resume ? sessionId : undefined,
          yolo,
        }),
      });
      const result = await res.json();
      if (result.success) {
        setBootResult(result.command);
      } else {
        setBootResult(`Error: ${result.error}`);
      }
    } catch (err) {
      setBootResult(`Error: ${String(err)}`);
    }
    setBooting(false);
  }

  return (
    <div className="relative inline-block" ref={popRef}>
      <button
        onClick={() => { setOpen(!open); setBootResult(null); }}
        className="text-base text-[var(--color-accent)] hover:underline cursor-pointer"
      >
        {label ?? sessionId.slice(0, 8)}
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-80 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3 space-y-2 shadow-lg">
          {/* Session ID */}
          <div className="text-base font-mono text-[var(--color-muted)] break-all select-all">
            {sessionId}
          </div>

          {/* Metadata */}
          {firstPrompt && (
            <div className="text-base text-[var(--color-foreground)] italic truncate">
              &quot;{firstPrompt}&quot;
            </div>
          )}
          <div className="grid grid-flow-col auto-cols-max gap-3 text-base text-[var(--color-muted)]">
            {messageCount != null && <span>{messageCount} msgs</span>}
            {gitBranch && <span>{gitBranch}</span>}
          </div>

          {/* Actions */}
          <div className="border-t border-[var(--color-border)] pt-2 space-y-2">
            <Link
              href={`/projects/${encodeURIComponent(project)}/${sessionId}`}
              className="block text-base text-[var(--color-accent)] hover:underline"
            >
              View session
            </Link>

            {projectPath && (
              <>
                <div className="grid grid-flow-col auto-cols-max gap-2 items-center">
                  <button
                    onClick={() => boot(true)}
                    disabled={booting}
                    className="px-2 py-1 text-base font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded hover:opacity-90 disabled:opacity-50"
                  >
                    Resume in tmux
                  </button>
                  <button
                    onClick={() => boot(false)}
                    disabled={booting}
                    className="px-2 py-1 text-base bg-[var(--color-surface-hover)] text-[var(--color-foreground)] rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50"
                  >
                    New session
                  </button>
                  <label className="grid grid-flow-col auto-cols-max items-center gap-1 text-base text-[var(--color-muted)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={yolo}
                      onChange={(e) => setYolo(e.target.checked)}
                      className="accent-[var(--color-error)]"
                    />
                    Yolo
                  </label>
                </div>
                {bootResult && (
                  <div className={`text-base font-mono break-all ${bootResult.startsWith('Error') ? 'text-[var(--color-error)]' : 'text-[var(--color-accent)]'}`}>
                    {bootResult}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

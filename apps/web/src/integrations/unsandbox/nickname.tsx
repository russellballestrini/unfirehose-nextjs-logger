'use client';

import { useState, type ReactNode } from 'react';

/**
 * Naming a container, wherever one is listed: our node page's Services and
 * Sessions tabs and the unsandbox section of /tmux. One editor is open at a
 * time; Enter or leaving the field saves, Escape drops the edit.
 */

export interface NicknameEditor {
  editingNick: { sessionId: string; value: string } | null;
  setEditingNick: (next: { sessionId: string; value: string } | null) => void;
  saveNickname: (sessionId: string, nickname: string, serviceName?: string) => Promise<void>;
}

export function useNicknameEditor(mutateNicknames: () => unknown): NicknameEditor {
  const [editingNick, setEditingNick] = useState<{ sessionId: string; value: string } | null>(null);

  const saveNickname = async (sessionId: string, nickname: string, serviceName = '') => {
    await fetch('/api/sessions/nickname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, nickname, host: 'unsandbox', service_name: serviceName }),
    });
    setEditingNick(null);
    mutateNicknames();
  };

  return { editingNick, setEditingNick, saveNickname };
}

/**
 * The nickname line of a container card: a button showing the name, or the
 * input editing it. `children` sits under the input while editing — /tmux
 * puts its service-name field there. With `serviceLine`, a saved service
 * name shows under the button, `serviceLine` adding to its classes.
 */
export function NicknameField({ id, nick, serviceName, editor, hint = 'text-violet-400/40', serviceLine, children }: {
  id: string;
  nick: { nickname?: string; service_name?: string } | undefined;
  serviceName: string;
  editor: NicknameEditor;
  /** The colour of the "add nickname" prompt when there is none yet. */
  hint?: string;
  serviceLine?: string;
  children?: ReactNode;
}) {
  const { editingNick, setEditingNick, saveNickname } = editor;
  if (editingNick?.sessionId !== id) {
    return (
      <>
        <button onClick={() => setEditingNick({ sessionId: id, value: nick?.nickname ?? '' })}
          className="w-full text-left text-sm font-bold hover:text-violet-300 transition-colors truncate">
          {nick?.nickname || <span className={`${hint} font-normal text-xs`}>✎ add nickname</span>}
        </button>
        {serviceLine !== undefined && nick?.service_name && (
          <p className={`text-xs text-violet-400/70 font-mono truncate${serviceLine}`}>⬡ {nick.service_name}</p>
        )}
      </>
    );
  }
  const input = (
    <input
      autoFocus
      value={editingNick?.value ?? ''}
      onChange={e => setEditingNick({ sessionId: id, value: e.target.value })}
      onKeyDown={e => {
        const v = editingNick?.value ?? '';
        if (e.key === 'Enter') saveNickname(id, v, serviceName);
        if (e.key === 'Escape') setEditingNick(null);
      }}
      onBlur={() => saveNickname(id, editingNick?.value ?? '', serviceName)}
      placeholder="nickname…"
      className="w-full text-sm px-2 py-1 rounded border border-violet-500/50 bg-[var(--color-background)] font-bold outline-none"
    />
  );
  return children ? <div className="space-y-1">{input}{children}</div> : input;
}

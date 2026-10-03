import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api';
import { relativeTime } from '../../format';
import { useToast } from '../../toast';
import type { CaseSummary } from '../../types';
import { Icon } from '../Icon';
import { ConfirmDialog } from '../ui';

interface Props {
  conversations: CaseSummary[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRenamed: (summary: CaseSummary) => void;
  onDeleted: (id: string) => void;
}

function groupLabel(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((start - at) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return 'Older';
}

function ItemMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="item-menu" ref={ref}>
      <button
        className="icon-btn icon-btn-sm"
        aria-label="Conversation options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <Icon name="dots" size={18} />
      </button>
      {open && (
        <div className="menu menu-sm" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            <Icon name="edit" size={16} /> Rename
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Icon name="trash" size={16} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function HistoryPanel({ conversations, activeId, loading, error, onRetry, onNew, onSelect, onRenamed, onDeleted }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<CaseSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const filtered = query.trim()
    ? conversations.filter((item) => `${item.title} ${item.last_message ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    : conversations;
  const groups = new Map<string, CaseSummary[]>();
  for (const item of filtered) {
    const label = groupLabel(item.updated_at);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }

  const saveRename = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!renaming || !title) return;
    setSaving(true);
    try {
      onRenamed(await api.renameConversation(renaming, title));
      setRenaming(null);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.deleteConversation(deleting.case_id);
      onDeleted(deleting.case_id);
      toast('Conversation deleted', 'success');
      setDeleting(null);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <aside className="history" aria-label="Chat history">
      <button className="btn btn-primary btn-block new-chat" onClick={onNew}>
        <Icon name="plus" size={18} /> New Chat
      </button>
      {conversations.length > 4 && (
        <input className="input input-sm" type="search" placeholder="Search chats" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search chats" />
      )}
      <div className="history-scroll">
        {error ? (
          <div className="history-empty">
            <p className="small">{error}</p>
            <button className="btn btn-sm" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : loading && conversations.length === 0 ? (
          <p className="history-empty muted small">Loading your chats...</p>
        ) : filtered.length === 0 ? (
          <p className="history-empty muted small">{query ? 'No chats match your search.' : 'No chats yet. Start one to see it here.'}</p>
        ) : (
          [...groups.entries()].map(([label, items]) => (
            <div key={label} className="history-group">
              <h4>{label}</h4>
              <ul>
                {items.map((item) => (
                  <li key={item.case_id} className={`history-item ${item.case_id === activeId ? 'active' : ''}`}>
                    {renaming === item.case_id ? (
                      <form className="rename-form" onSubmit={saveRename}>
                        <input
                          className="input input-sm"
                          value={draft}
                          maxLength={80}
                          autoFocus
                          disabled={saving}
                          aria-label="Conversation name"
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => event.key === 'Escape' && setRenaming(null)}
                        />
                        <button className="icon-btn icon-btn-sm" type="submit" aria-label="Save name" disabled={saving || !draft.trim()}>
                          <Icon name="check" size={16} />
                        </button>
                        <button className="icon-btn icon-btn-sm" type="button" aria-label="Cancel rename" onClick={() => setRenaming(null)}>
                          <Icon name="close" size={16} />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button className="history-link" onClick={() => onSelect(item.case_id)} aria-current={item.case_id === activeId ? 'true' : undefined}>
                          <span className="history-title">{item.title}</span>
                          <small className="muted">{relativeTime(item.updated_at)}</small>
                        </button>
                        <ItemMenu
                          onRename={() => {
                            setDraft(item.title);
                            setRenaming(item.case_id);
                          }}
                          onDelete={() => setDeleting(item)}
                        />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
      {deleting && (
        <ConfirmDialog
          title="Delete this conversation?"
          body={`"${deleting.title}" and its messages will be removed. This can't be undone.`}
          confirmLabel="Delete"
          danger
          busy={deleteBusy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </aside>
  );
}

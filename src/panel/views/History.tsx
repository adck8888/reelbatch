import { useEffect, useMemo, useState } from 'preact/hooks';
import type { HistoryItem } from '../../shared/types';
import { clearHistory, deleteHistory, listHistory } from '../../shared/idb';
import { t } from '../i18n';
import { pro, run, tab } from '../store';
import { Button, Icon, ProBadge, Thumb, call, copyText } from '../ui';
import { addPromptsFromHistory } from './Queue';

type View = 'grid' | 'story';

export function HistoryView() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('grid');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const runKey = `${run.value.runId}:${Object.values(run.value.rows).reduce((s, r) => s + r.results.length, 0)}`;

  const load = async () => setItems(await listHistory(2000, query));
  useEffect(() => {
    const id = setTimeout(load, 200);
    return () => clearTimeout(id);
  }, [query, runKey]);

  const runs = useMemo(() => {
    const m = new Map<string, HistoryItem[]>();
    for (const it of items) m.set(it.runId, [...(m.get(it.runId) ?? []), it]);
    return [...m.entries()].map(([id, list]) => ({ id, list: list.slice().sort((a, b) => a.n - b.n || a.createdAt - b.createdAt) }));
  }, [items]);

  const toggle = (id: string) => {
    const s = new Set(sel);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSel(s);
  };

  return (
    <div class="history-view">
      <div class="toolbar">
        <div class="search">
          <Icon name="search" size={14} />
          <input type="search" value={query} placeholder={t('Search prompts')} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        <div class="seg small">
          <button type="button" class={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title={t('Gallery')}>
            <Icon name="grid" size={14} />
          </button>
          <button type="button" class={view === 'story' ? 'on' : ''} onClick={() => setView('story')} title={t('Storyboard (by run)')}>
            <Icon name="list" size={14} />
          </button>
        </div>
      </div>

      {sel.size > 0 && (
        <div class="list-head">
          <span>{t('{n} selected', { n: sel.size })}</span>
          <span class="grow" />
          <Button small onClick={() => addPromptsFromHistory(items.filter((i) => sel.has(i.id)).map((i) => i.prompt))}>
            {t('Run again')}
          </Button>
          <Button small variant="ghost" icon="trash" onClick={async () => {
            if (!confirm(t('Delete {n} items from history? Downloaded files stay on disk.', { n: sel.size }))) return;
            await deleteHistory([...sel]);
            setSel(new Set());
            await load();
          }}>
            {t('Delete')}
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <div class="empty">
          <span class="empty-icon">
            <Icon name={query ? 'search' : 'image'} size={26} />
          </span>
          <h3>{query ? t('Nothing matches') : t('No results yet')}</h3>
          <p class="muted">{query ? t('Try another word from the prompt.') : t('Finished images and videos appear here')}</p>
          {!query && (
            <Button small icon="list" onClick={() => (tab.value = 'queue')}>
              {t('Go to the queue')}
            </Button>
          )}
        </div>
      ) : view === 'grid' ? (
        <div class="gallery">
          {items.map((it) => (
            <Tile key={it.id} it={it} on={sel.has(it.id)} onToggle={() => toggle(it.id)} />
          ))}
        </div>
      ) : (
        runs.map((r) => (
          <section class="story" key={r.id}>
            <header>
              <b>{r.list[0].queueName}</b>
              <span class="muted">{new Date(r.list[0].createdAt).toLocaleString()} · {t('{n} files', { n: r.list.length })}</span>
              <span class="grow" />
              <Button small variant="ghost" icon="copy" title={t('Copy prompts in order')} onClick={() => copyText([...new Set(r.list.map((i) => i.prompt))].join('\n\n'))} />
              <Button small variant="ghost" icon="download" disabled={!pro.value} title={t('Download the run as ZIP')} onClick={() => call({ type: 'export:zip', runId: r.id }, t('ZIP saved to Downloads'))}>
                ZIP {!pro.value && <ProBadge />}
              </Button>
            </header>
            <div class="story-strip">
              {r.list.map((it) => (
                <Tile key={it.id} it={it} on={sel.has(it.id)} onToggle={() => toggle(it.id)} showN />
              ))}
            </div>
          </section>
        ))
      )}

      {items.length > 0 && (
        <div class="footer-actions">
          <Button small variant="ghost" icon="trash" onClick={async () => {
            if (!confirm(t('Clear the whole history? Downloaded files stay on disk.'))) return;
            await clearHistory();
            await load();
          }}>
            {t('Clear history')}
          </Button>
        </div>
      )}
    </div>
  );
}

function Tile({ it, on, onToggle, showN }: { it: HistoryItem; on: boolean; onToggle: () => void; showN?: boolean }) {
  const open = () => {
    if (it.url) void chrome.tabs.create({ url: it.url });
  };
  return (
    <figure class={`tile ${on ? 'on' : ''}`} title={it.prompt}>
      <div class="tile-media" onClick={open}>
        <Thumb id={it.thumbId} size={120} />
        {it.kind === 'video' && <span class="kind"><Icon name="video" size={12} /></span>}
        {showN && <span class="num">{it.n}</span>}
      </div>
      <input type="checkbox" class="tile-check" checked={on} onChange={onToggle} aria-label={t('Select')} />
      <figcaption>
        <span class="tile-prompt">{it.prompt}</span>
        <span class="muted">{it.model}</span>
        <span class="tile-actions">
          <button type="button" title={t('Copy prompt')} onClick={() => copyText(it.prompt)}>
            <Icon name="copy" size={12} />
          </button>
          <button type="button" title={t('Run again')} onClick={() => addPromptsFromHistory([it.prompt])}>
            <Icon name="refresh" size={12} />
          </button>
        </span>
      </figcaption>
    </figure>
  );
}

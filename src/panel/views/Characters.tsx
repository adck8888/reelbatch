import { useState } from 'preact/hooks';
import type { Character } from '../../shared/types';
import { deleteAsset } from '../../shared/idb';
import { uid } from '../../shared/util';
import { t } from '../i18n';
import { characters, pro, saveCharacters } from '../store';
import { Button, Field, Icon, Modal, ProBadge, Thumb, copyText, imagesFromDrop, pickImages } from '../ui';

export function CharactersView() {
  const list = characters.value;
  const [edit, setEdit] = useState<Character | null>(null);

  return (
    <div class="characters-view">
      <div class="toolbar">
        <p class="muted intro">
          {t('Write @Name in any prompt. Reelbatch attaches the character’s reference images and adds the description, so the same person, product or mascot looks the same in every shot.')}
        </p>
        {!pro.value && <ProBadge />}
        <span class="grow" />
        <Button small variant="primary" icon="plus" onClick={() => setEdit({ id: uid(), name: '', description: '', refs: [], createdAt: Date.now() })}>
          {t('New character')}
        </Button>
      </div>
      {list.length === 0 ? (
        <div class="empty">
          <span class="empty-icon">
            <Icon name="user" size={26} />
          </span>
          <h3>{t('No characters yet')}</h3>
          <p class="muted">{t('Add a person, product or mascot once with a few photos, then write @Name in any prompt.')}</p>
        </div>
      ) : (
        <ul class="char-list">
          {list.map((c) => (
            <li key={c.id} class="char" onClick={() => setEdit(c)}>
              <div class="char-thumbs">
                {c.refs.slice(0, 3).map((id) => <Thumb key={id} id={id} size={48} />)}
                {!c.refs.length && <Thumb size={48} />}
              </div>
              <div class="char-text">
                <b>@{c.name}</b>
                <span class="muted">{c.description || t('No description')}</span>
              </div>
              <Button small variant="ghost" icon="copy" title={t('Copy @mention')} onClick={(e: MouseEvent) => (e.stopPropagation(), copyText(`@${c.name}`))} />
            </li>
          ))}
        </ul>
      )}
      {edit && <CharacterEditor initial={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function CharacterEditor({ initial, onClose }: { initial: Character; onClose: () => void }) {
  const [c, setC] = useState(initial);
  const exists = characters.value.some((x) => x.id === c.id);
  const clash = characters.value.some((x) => x.id !== c.id && x.name.toLowerCase() === c.name.trim().toLowerCase());
  const valid = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(c.name.trim()) && !clash;

  const save = async () => {
    const next = { ...c, name: c.name.trim() };
    await saveCharacters(exists ? characters.value.map((x) => (x.id === c.id ? next : x)) : [...characters.value, next]);
    onClose();
  };
  const remove = async () => {
    if (!confirm(t('Delete @{name}?', { name: c.name }))) return;
    await saveCharacters(characters.value.filter((x) => x.id !== c.id));
    for (const id of c.refs) await deleteAsset(id).catch(() => {});
    onClose();
  };

  return (
    <Modal
      title={exists ? `@${initial.name}` : t('New character')}
      onClose={onClose}
      footer={
        <>
          {exists && (
            <Button variant="danger" icon="trash" onClick={remove}>
              {t('Delete')}
            </Button>
          )}
          <span class="grow" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!valid} onClick={save}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <Field label={t('Name')} hint={clash ? t('Another character already has this name') : t('One word: letters, digits, _ . -  e.g. Mia, RedCar, Logo_v2')}>
        <input type="text" value={c.name} placeholder="Mia" onInput={(e) => setC({ ...c, name: (e.target as HTMLInputElement).value.replace(/\s+/g, '_') })} />
      </Field>
      <Field label={t('Description')} hint={t('Added to the prompt the first time the character is mentioned')}>
        <textarea rows={3} value={c.description} placeholder={t('a 30-year-old woman with short red hair, green raincoat, freckles')} onInput={(e) => setC({ ...c, description: (e.target as HTMLTextAreaElement).value })} />
      </Field>
      <span class="label">{t('Reference images')}</span>
      <div
        class="refs"
        onDragOver={(e) => e.preventDefault()}
        onDrop={async (e) => {
          e.preventDefault();
          const ids = await imagesFromDrop(e);
          setC({ ...c, refs: [...c.refs, ...ids].slice(0, 10) });
        }}
      >
        {c.refs.map((id) => (
          <Thumb key={id} id={id} size={64} onRemove={() => setC({ ...c, refs: c.refs.filter((x) => x !== id) })} />
        ))}
        {c.refs.length < 10 && (
          <button type="button" class="thumb add" style={{ width: '64px', height: '64px' }} onClick={async () => setC({ ...c, refs: [...c.refs, ...(await pickImages())].slice(0, 10) })}>
            <Icon name="plus" />
          </button>
        )}
      </div>
      <p class="hint">{t('1–3 clear images work best. Video models accept up to 3 references per prompt.')}</p>
    </Modal>
  );
}

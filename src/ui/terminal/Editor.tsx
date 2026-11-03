import { useEffect, useRef, useState } from 'react';
import type { EditRequest } from '../../sim/shell/types';

interface Props {
  request: EditRequest;
  /** Called after a successful save (the file changed). */
  onSaved: () => void;
  onClose: () => void;
}

/**
 * The simple editor behind `nano FILE` (and vi/vim). Ctrl+S / Ctrl+O saves,
 * Ctrl+X exits — the nano shortcuts most tutorials teach.
 */
export function Editor({ request, onSaved, onClose }: Props) {
  const [text, setText] = useState(request.content);
  const [saved, setSaved] = useState(request.content);
  const [status, setStatus] = useState<string | null>(
    request.editor === 'nano' ? null : `devquest opens its simple editor for ${request.editor} — no modes, just type`,
  );
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== saved;

  useEffect(() => area.current?.focus(), []);

  const save = () => {
    const err = request.save(text);
    if (err) {
      setStatus(err);
      return false;
    }
    setSaved(text);
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    setStatus(`[ Wrote ${lines} line${lines === 1 ? '' : 's'} ]`);
    onSaved();
    return true;
  };

  const exit = () => {
    if (dirty && !window.confirm('Save modified buffer? (Cancel discards your changes)')) {
      onClose();
      return;
    }
    if (dirty && !save()) return;
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && (e.key === 's' || e.key === 'o')) {
      e.preventDefault();
      save();
    } else if (e.ctrlKey && e.key === 'x') {
      e.preventDefault();
      exit();
    } else if (e.key === 'Tab') {
      // Insert spaces instead of leaving the editor (YAML and Dockerfiles need indentation).
      e.preventDefault();
      const el = e.currentTarget as HTMLTextAreaElement;
      const { selectionStart: a, selectionEnd: b } = el;
      const next = text.slice(0, a) + '  ' + text.slice(b);
      setText(next);
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
    }
  };

  return (
    <div className="editor" role="dialog" aria-label={`Editing ${request.display}`}>
      <div className="editor-title">
        <span>GNU nano (devquest)</span>
        <span className="editor-file">
          {request.display}
          {dirty ? ' (modified)' : ''}
        </span>
      </div>
      <textarea
        ref={area}
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        aria-label="File contents"
      />
      {status && <div className="editor-status">{status}</div>}
      <div className="editor-keys">
        <button onClick={save}>
          <kbd>^S</kbd> Save
        </button>
        <button onClick={exit}>
          <kbd>^X</kbd> Exit
        </button>
      </div>
    </div>
  );
}

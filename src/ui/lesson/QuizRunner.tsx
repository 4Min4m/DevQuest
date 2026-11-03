import { useEffect, useMemo, useReducer, useState } from 'react';
import { QuizSession, Response, shuffled } from '../../game/quiz';
import type { Question } from '../../game/types';
import { Markdown } from '../Markdown';

interface Props {
  session: QuizSession;
  /** Called right after an answer is graded (wrong answers cost a heart). */
  onAnswered: (correct: boolean) => void;
  /** Called when every question has been answered correctly. */
  onPassed: () => void;
}

/** Knowledge-check runner shown in place of the terminal for quiz missions. */
export function QuizRunner({ session, onAnswered, onPassed }: Props) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const q = session.current;
  const total = session.questions.length;

  if (session.status === 'passed') {
    return (
      <div className="quiz-card">
        <h2>✔ All {total} questions answered</h2>
        <p className="muted">See the lesson panel for your reward and what's next.</p>
      </div>
    );
  }
  if (session.status === 'failed' && !session.answered) {
    return (
      <div className="quiz-card">
        <h2>💔 Out of hearts</h2>
        <p className="muted">Review the theory on the left, then retry the knowledge check.</p>
      </div>
    );
  }
  if (!q) return null;

  return (
    <div className="quiz-card">
      <div className="quiz-progress">
        <span>
          {session.solved}/{total} correct
        </span>
        <span className="bar" aria-hidden>
          <span style={{ width: `${(session.solved / total) * 100}%` }} />
        </span>
      </div>
      <QuestionView
        // A new key each time a question is presented (not when it's answered) resets the selection.
        key={`${session.currentIndex}-${session.submissions - (session.answered ? 1 : 0)}`}
        question={q}
        seed={session.seed * 31 + session.currentIndex}
        answered={session.answered}
        onSubmit={(r) => {
          const result = session.answer(r);
          onAnswered(result.correct);
          rerender();
        }}
        onContinue={() => {
          if (session.next()) onPassed();
          rerender();
        }}
      />
    </div>
  );
}

interface QuestionProps {
  question: Question;
  seed: number;
  answered: QuizSession['answered'];
  onSubmit: (r: Response) => void;
  onContinue: () => void;
}

function QuestionView({ question: q, seed, answered, onSubmit, onContinue }: QuestionProps) {
  const options = useMemo(() => ('options' in q ? shuffled(q.options, seed) : []), [q, seed]);
  const [single, setSingle] = useState<number | null>(null);
  const [multi, setMulti] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [order, setOrder] = useState<number[]>(() => (q.kind === 'order' ? shuffled(q.items, seed).map((x) => x.index) : []));

  const response = (): Response | null => {
    switch (q.kind) {
      case 'single':
        return single;
      case 'multi':
        return multi.length ? multi : null;
      case 'number':
      case 'text':
        return text.trim() ? text : null;
      case 'order':
        return order;
    }
  };
  const ready = response() !== null;
  const submit = () => {
    const r = response();
    if (r !== null && !answered) onSubmit(r);
  };

  // Keyboard: 1-9 picks an option, Enter submits / continues.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && e.key !== 'Enter') return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (answered) onContinue();
        else submit();
        return;
      }
      const n = Number(e.key);
      if (!answered && n >= 1 && n <= options.length) {
        const orig = options[n - 1].index;
        if (q.kind === 'single') setSingle(orig);
        if (q.kind === 'multi') setMulti((m) => (m.includes(orig) ? m.filter((x) => x !== orig) : [...m, orig]));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const optionClass = (orig: number, chosen: boolean) => {
    if (!answered) return chosen ? 'selected' : '';
    const correct = q.kind === 'single' ? orig === q.answer : q.kind === 'multi' ? q.answers.includes(orig) : false;
    if (correct) return 'right';
    return chosen ? 'wrong' : '';
  };

  return (
    <>
      <div className="quiz-prompt">
        <Markdown text={q.prompt} />
      </div>
      {q.kind === 'multi' && <p className="muted">Select all that apply.</p>}

      {(q.kind === 'single' || q.kind === 'multi') && (
        <ul className="quiz-options">
          {options.map(({ item, index }, pos) => {
            const chosen = q.kind === 'single' ? single === index : multi.includes(index);
            return (
              <li key={index}>
                <button
                  className={`quiz-option ${optionClass(index, chosen)}`}
                  disabled={!!answered}
                  aria-pressed={chosen}
                  onClick={() =>
                    q.kind === 'single' ? setSingle(index) : setMulti((m) => (m.includes(index) ? m.filter((x) => x !== index) : [...m, index]))
                  }
                >
                  <span className="key">{pos + 1}</span>
                  <Markdown text={item} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {(q.kind === 'number' || q.kind === 'text') && (
        <input
          className="quiz-input"
          autoFocus
          value={text}
          disabled={!!answered}
          inputMode={q.kind === 'number' ? 'decimal' : 'text'}
          placeholder={q.kind === 'number' ? `Number${q.unit ? ` (${q.unit})` : ''}` : 'Your answer'}
          aria-label="Your answer"
          onChange={(e) => setText(e.target.value)}
        />
      )}

      {q.kind === 'order' && (
        <ol className="quiz-options">
          {order.map((orig, pos) => (
            <li key={orig} className="order-row">
              <span className={`quiz-option ${answered ? (orig === pos ? 'right' : 'wrong') : ''}`}>
                <span className="key">{pos + 1}</span>
                <Markdown text={q.items[orig]} />
              </span>
              {!answered && (
                <>
                  <button
                    className="move"
                    aria-label="Move up"
                    disabled={pos === 0}
                    onClick={() => setOrder((o) => swap(o, pos, pos - 1))}
                  >
                    ↑
                  </button>
                  <button
                    className="move"
                    aria-label="Move down"
                    disabled={pos === order.length - 1}
                    onClick={() => setOrder((o) => swap(o, pos, pos + 1))}
                  >
                    ↓
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      {answered && (
        <div className={`quiz-feedback ${answered.correct ? 'right' : 'wrong'}`} role="status">
          <strong>{answered.correct ? '✓ Correct' : '✗ Not quite (−1 ♥)'}</strong>
          {!answered.correct && (
            <p>
              Correct answer: <strong>{answered.correctAnswer}</strong>. This question will come back at the end.
            </p>
          )}
          {answered.explain && <Markdown text={answered.explain} />}
        </div>
      )}

      <div className="actions">
        {answered ? (
          <button className="primary" onClick={onContinue} autoFocus>
            Continue ↵
          </button>
        ) : (
          <button className="primary" onClick={submit} disabled={!ready}>
            Check ↵
          </button>
        )}
      </div>
    </>
  );
}

function swap(arr: number[], a: number, b: number): number[] {
  const copy = [...arr];
  [copy[a], copy[b]] = [copy[b], copy[a]];
  return copy;
}

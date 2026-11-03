import { marked } from 'marked';
import { useMemo } from 'react';

marked.use({ gfm: true, breaks: false });

/**
 * Renders lesson markdown. Content is bundled with the app (never user input),
 * so the HTML is trusted.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => marked.parse(text, { async: false }) as string, [text]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

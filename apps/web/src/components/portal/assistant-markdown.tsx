import type { ReactNode } from "react";

// A small Markdown subset for assistant replies (audit phase 4). It builds React elements only;
// it never sets HTML, so model text cannot inject markup. Supported: paragraphs, "#" headings,
// "-"/"*" and "1." lists, fenced code, **bold**, `code` and [text](https://...) links.
// Anything else stays plain text.

type Block =
  | Readonly<{ kind: "heading"; level: number; text: string }>
  | Readonly<{ kind: "list"; ordered: boolean; items: string[] }>
  | Readonly<{ kind: "code"; text: string }>
  | Readonly<{ kind: "paragraph"; text: string }>;

const HEADING = /^(#{1,3})\s+(.+)$/u;
const BULLET = /^\s*[-*]\s+(.+)$/u;
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/u;
const FENCE = /^```/u;
const INLINE =
  /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu;

const listItem = (line: string, ordered: boolean): string | null =>
  (ordered ? NUMBERED : BULLET).exec(line)?.[1] ?? null;

export const parseMarkdownBlocks = (source: string): Block[] => {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] as string)) {
        code.push(lines[index] as string);
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length,
        text: heading[2] as string,
      });
      continue;
    }
    const ordered = listItem(line, true) !== null;
    if (ordered || listItem(line, false) !== null) {
      flush();
      const items: string[] = [];
      while (index < lines.length) {
        const item = listItem(lines[index] as string, ordered);
        if (item === null) break;
        items.push(item);
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
};

const renderInline = (text: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, bold, code, label, href] = match;
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${match.index}`;
    if (typeof bold === "string") nodes.push(<strong key={key}>{bold}</strong>);
    else if (typeof code === "string")
      nodes.push(
        <code className="rounded bg-muted px-1 font-mono text-xs" key={key}>
          {code}
        </code>
      );
    else
      nodes.push(
        <a
          className="underline underline-offset-2"
          href={href}
          key={key}
          rel="noopener noreferrer"
          target="_blank"
        >
          {label}
        </a>
      );
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
};

const HEADING_CLASS = ["font-semibold text-base", "font-semibold text-sm"];

const BlockView = ({ block }: Readonly<{ block: Block }>) => {
  switch (block.kind) {
    case "heading": {
      // Replies sit inside the page outline, so headings render as styled text, not h1-h3.
      return (
        <p
          className={HEADING_CLASS[Math.min(block.level, 2) - 1]}
          data-md-heading={block.level}
        >
          {renderInline(block.text)}
        </p>
      );
    }
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={
            block.ordered
              ? "list-decimal space-y-1 pl-5"
              : "list-disc space-y-1 pl-5"
          }
        >
          {block.items.map((item, index) => (
            <li key={`${index}:${item}`}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "code": {
      return (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
          <code>{block.text}</code>
        </pre>
      );
    }
    default: {
      return <p className="whitespace-pre-wrap">{renderInline(block.text)}</p>;
    }
  }
};

export const AssistantMarkdown = ({ source }: Readonly<{ source: string }>) => (
  <div className="space-y-2 break-words text-sm" data-message-content="">
    {parseMarkdownBlocks(source).map((block, index) => (
      <BlockView block={block} key={`${index}:${block.kind}`} />
    ))}
  </div>
);

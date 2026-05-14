import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils.js";

interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className={cn("relative group rounded-md border border-border overflow-hidden", className)}>
      {language && (
        <div className="flex items-center justify-between px-3 py-1 bg-muted/50 border-b border-border">
          <span className="text-[10px] text-muted-foreground uppercase">{language}</span>
          <button
            onClick={handleCopy}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            {copied ? "✓" : "Copy"}
          </button>
        </div>
      )}
      {!language && (
        <button
          onClick={handleCopy}
          className="absolute top-1 right-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded bg-muted/80"
        >
          {copied ? "✓" : "Copy"}
        </button>
      )}
      <pre className="p-3 overflow-x-auto text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function CollapsibleSection({ title, defaultOpen = false, children, className }: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={cn("border border-border rounded-md overflow-hidden", className)}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-sm font-medium"
      >
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">
          {isOpen ? "▲" : "▼"}
        </span>
      </button>
      {isOpen && (
        <div className="p-4">
          {children}
        </div>
      )}
    </div>
  );
}

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function detectCodeBlocks(text: string): Array<{ type: "code"; language: string; code: string } | { type: "text"; content: string }> {
  const parts: Array<{ type: "code"; language: string; code: string } | { type: "text"; content: string }> = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "code", language: match[1] || "", code: match[2].trimEnd() });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", content: text.slice(lastIndex) });
  }

  return parts;
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      nodes.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={key++}>{match[4]}</em>);
    } else if (match[5]) {
      nodes.push(
        <code key={key++} className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">
          {match[6]}
        </code>
      );
    } else if (match[7]) {
      nodes.push(
        <a
          key={key++}
          href={match[9]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {match[8]}
        </a>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

function renderTextBlock(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let key = 0;
  let inList = false;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    const listItemMatch = line.match(/^[-*]\s+(.+)/);
    const numberedItemMatch = line.match(/^\d+\.\s+(.+)/);

    if (inList && !listItemMatch && !numberedItemMatch) {
      inList = false;
    }

    if (headingMatch) {
      const level = headingMatch[1].length;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const sizeClass = level === 1 ? "text-lg" : level === 2 ? "text-base" : "text-sm";
      nodes.push(
        <Tag key={key++} className={cn("font-semibold mt-3 mb-1", sizeClass)}>
          {renderInlineMarkdown(headingMatch[2])}
        </Tag>
      );
    } else if (listItemMatch) {
      inList = true;
      nodes.push(
        <div key={key++} className="flex items-start gap-2 ml-2">
          <span className="text-muted-foreground mt-0.5">•</span>
          <span className="flex-1">{renderInlineMarkdown(listItemMatch[1])}</span>
        </div>
      );
    } else if (numberedItemMatch) {
      inList = true;
      nodes.push(
        <div key={key++} className="flex items-start gap-2 ml-2">
          <span className="text-muted-foreground text-xs tabular-nums">•</span>
          <span className="flex-1">{renderInlineMarkdown(numberedItemMatch[1])}</span>
        </div>
      );
    } else if (line.trim() === "") {
      nodes.push(<div key={key++} className="h-2" />);
    } else {
      nodes.push(
        <p key={key++} className="text-sm leading-relaxed">
          {renderInlineMarkdown(line)}
        </p>
      );
    }
  }

  return nodes;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const parts = detectCodeBlocks(content);

  return (
    <div className={cn("prose-sm max-w-none", className)}>
      {parts.map((part, index) => {
        if (part.type === "code") {
          return <CodeBlock key={index} code={part.code} language={part.language} />;
        }
        return <div key={index}>{renderTextBlock(part.content)}</div>;
      })}
    </div>
  );
}

export function TruncatedText({
  text,
  maxLines = 3,
  className,
}: {
  text: string;
  maxLines?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  return (
    <div className={className}>
      <div
        className={cn("transition-all duration-200", !expanded && `line-clamp-${maxLines}`)}
        style={!expanded ? { display: "-webkit-box", WebkitLineClamp: maxLines, WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}
      >
        {text}
      </div>
      {text.length > 100 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-primary hover:underline mt-1"
        >
          {expanded ? t("pages:principles.showLess") : t("pages:principles.showMore")}
        </button>
      )}
    </div>
  );
}

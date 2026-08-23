import { memo, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./Button.tsx";

type SupportedLanguage =
  | "html"
  | "tsx"
  | "vue"
  | "react"
  | "nextjs"
  | "angular"
  | "svelte"
  | "django"
  | "rails"
  | "go";

interface CodeBlockProps {
  code: string;
  language?: SupportedLanguage;
  label?: string;
  showLineNumbers?: boolean;
  className?: string;
}

function CodeBlockBase({ code, language = "html", showLineNumbers = false, className = "" }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const lines = useMemo(() => code.split("\n"), [code]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className={`relative group rounded-2xl border border-theme/30 bg-[#0d1117] overflow-hidden ${className}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-white/5">
        <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">{language}</span>
        <Button size="sm" variant="ghost" onClick={handleCopy} className="text-zinc-400 hover:text-white h-7 px-2">
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          <span className="text-[11px]">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <div className="relative p-4 overflow-x-auto">
        <pre className="text-[12px] leading-relaxed font-mono text-zinc-300">
          {showLineNumbers ? (
            <div className="flex">
              <div className="select-none pr-4 text-right text-zinc-600 border-r border-white/10 mr-4">
                {lines.map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <code>{highlighted}</code>
            </div>
          ) : (
            <code>{highlighted}</code>
          )}
        </pre>
      </div>
    </div>
  );
}

export const CodeBlock = memo(CodeBlockBase);

function highlightCode(code: string, language: SupportedLanguage): React.ReactNode {
  if (language === "html" || language === "vue" || language === "svelte" || language === "django" || language === "rails" || language === "go") {
    return highlightHtml(code);
  }
  return highlightTsx(code);
}

function highlightHtml(code: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(<\/?[\w-]+)|(\s+[\w-]+=)|("[^"]*")|(>)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(code)) !== null) {
    if (match.index > last) {
      parts.push(<span key={key++}>{code.slice(last, match.index)}</span>);
    }
    const [, tag, attr, string, bracket] = match;
    if (tag) {
      parts.push(<span key={key++} className="text-pink-400">{tag}</span>);
    } else if (attr) {
      parts.push(<span key={key++} className="text-sky-300">{attr.slice(0, -1)}</span>);
      parts.push(<span key={key++} className="text-zinc-300">=</span>);
    } else if (string) {
      parts.push(<span key={key++} className="text-emerald-400">{string}</span>);
    } else if (bracket) {
      parts.push(<span key={key++} className="text-pink-400">{bracket}</span>);
    }
    last = regex.lastIndex;
  }
  if (last < code.length) {
    parts.push(<span key={key++}>{code.slice(last)}</span>);
  }
  return parts;
}

function highlightTsx(code: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\b(import|from|export|const|return|function|=>)\b)|(\b[A-Z][A-Za-z0-9_]*\b)|("[^"]*")|('[^']*')|(`[^`]*`)|(\/\/.*)|(\{|\})/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(code)) !== null) {
    if (match.index > last) {
      parts.push(<span key={key++}>{code.slice(last, match.index)}</span>);
    }
    const [m, keyword, , component, dString, sString, tString, comment, brace] = match;
    if (keyword) {
      parts.push(<span key={key++} className="text-purple-400">{m}</span>);
    } else if (component) {
      parts.push(<span key={key++} className="text-amber-300">{m}</span>);
    } else if (dString || sString || tString) {
      parts.push(<span key={key++} className="text-emerald-400">{m}</span>);
    } else if (comment) {
      parts.push(<span key={key++} className="text-zinc-500">{m}</span>);
    } else if (brace) {
      parts.push(<span key={key++} className="text-yellow-300">{m}</span>);
    }
    last = regex.lastIndex;
  }
  if (last < code.length) {
    parts.push(<span key={key++}>{code.slice(last)}</span>);
  }
  return parts;
}

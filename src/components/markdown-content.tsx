import type { ReactNode } from "react";
import { type InlineToken, type MarkdownBlock, parseMarkdown } from "@/lib/markdown";

function renderToken(token: InlineToken): ReactNode {
  if (token.kind === "text") return token.value;
  if (token.kind === "code") return <code key={token.key}>{token.value}</code>;
  if (token.kind === "strong")
    return <strong key={token.key}>{renderInline(token.children)}</strong>;
  if (token.kind === "em") return <em key={token.key}>{renderInline(token.children)}</em>;
  if (token.kind === "del") return <del key={token.key}>{renderInline(token.children)}</del>;
  return (
    <a href={token.href} key={token.key} rel="noreferrer" target="_blank">
      {renderInline(token.children)}
    </a>
  );
}

function renderInline(tokens: InlineToken[]): ReactNode[] {
  return tokens.map(renderToken);
}

function renderBlock(block: MarkdownBlock): ReactNode {
  if (block.kind === "heading") {
    if (block.level === 2) return <h2 key={block.key}>{renderInline(block.children)}</h2>;
    if (block.level === 3) return <h3 key={block.key}>{renderInline(block.children)}</h3>;
    return <h4 key={block.key}>{renderInline(block.children)}</h4>;
  }
  if (block.kind === "paragraph") {
    return <p key={block.key}>{renderInline(block.children)}</p>;
  }
  if (block.kind === "code") {
    return (
      <pre key={block.key}>
        <code data-language={block.language ?? undefined}>{block.code}</code>
      </pre>
    );
  }
  if (block.kind === "blockquote") {
    return <blockquote key={block.key}>{renderBlocks(block.blocks)}</blockquote>;
  }
  if (block.kind === "list") {
    const items = block.items.map((item) => <li key={item.key}>{renderInline(item.children)}</li>);
    return block.ordered ? <ol key={block.key}>{items}</ol> : <ul key={block.key}>{items}</ul>;
  }
  if (block.kind === "hr") {
    return <hr key={block.key} />;
  }
  return (
    <div className="table-wrap" key={block.key}>
      <table>
        <thead>
          <tr>
            {block.headers.map((header) => (
              <th key={header.key} scope="col">
                {renderInline(header.children)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell) => (
                <td key={cell.key}>{renderInline(cell.children)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderBlocks(blocks: MarkdownBlock[]): ReactNode[] {
  return blocks.map(renderBlock);
}

export function MarkdownContent({ markdown }: { markdown: string }) {
  return <>{renderBlocks(parseMarkdown(markdown))}</>;
}

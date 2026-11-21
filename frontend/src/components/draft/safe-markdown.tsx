import ReactMarkdown from "react-markdown";

/**
 * Engine-generated Markdown rendered safely: raw HTML is skipped (never executed),
 * links open in a new tab without referrer/opener, images are not loaded.
 */
export function SafeMarkdown({ children, lang }: { children: string; lang?: string | null }) {
  return (
    <div lang={lang ?? undefined} className="prose-draft">
      <ReactMarkdown
        skipHtml
        disallowedElements={["img"]}
        unwrapDisallowed
        components={{
          a: ({ href, children: c }) => {
            const safe = href && /^(https?:|mailto:|#)/i.test(href) ? href : undefined;
            return safe ? (
              <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline">
                {c}
              </a>
            ) : (
              <span>{c}</span>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

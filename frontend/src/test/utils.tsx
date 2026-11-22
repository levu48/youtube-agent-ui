import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";

export function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

/** Minimal fetch mock keyed by "METHOD path" (path without /api/v1 prefix). */
type Reply = { status?: number; json: unknown };
export function mockFetch(routes: Record<string, (body?: unknown) => Reply | Promise<Reply>>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:3000");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`] ?? (path === "/session" ? () => ({ json: { csrf_token: "t" } }) : null);
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: "nf" } }), { status: 404 });
    const r = await handler(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  globalThis.fetch = fn as typeof fetch;
  return calls;
}

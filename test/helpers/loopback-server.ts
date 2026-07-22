import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRoute {
	method?: string;
	path: string;
	status?: number;
	headers?: Record<string, string>;
	body?: string | Buffer | (() => AsyncIterable<Buffer>);
	hangAfterHeaders?: boolean;
	onRequest?: (req: http.IncomingMessage) => void;
}

export async function startLoopbackServer(routes: MockRoute[]) {
	const sockets = new Set<import("node:net").Socket>();
	const server = http.createServer(async (req, res) => {
		const route = routes.find((r) => (r.method ?? "GET") === req.method && r.path === req.url);
		if (!route) {
			res.statusCode = 404;
			res.end("missing");
			return;
		}
		route.onRequest?.(req);
		res.statusCode = route.status ?? 200;
		for (const [k, v] of Object.entries(route.headers ?? {})) {
			res.setHeader(k, v);
		}
		if (route.hangAfterHeaders) {
			res.writeHead(res.statusCode);
			return;
		}
		if (typeof route.body === "function") {
			for await (const chunk of route.body()) {
				res.write(chunk);
			}
			res.end();
			return;
		}
		res.end(route.body ?? "");
	});
	server.on("connection", (s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: async () => {
			for (const s of sockets) s.destroy();
			await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
		},
	};
}

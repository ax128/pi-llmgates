export function npmTarballBasename(packageName: string, version: string): string;
export function buildProbeBody(
	manifest: { name: string; version: string; description?: string; [key: string]: unknown },
	probeVersion: string,
): {
	_id: string;
	name: string;
	description?: string;
	"dist-tags": { latest: string };
	versions: Record<
		string,
		{
			version: string;
			dist: { tarball: string; shasum: string; integrity: string };
			[key: string]: unknown;
		}
	>;
	_attachments: Record<string, { content_type: string; data: string; length: number }>;
};
export function isUnexpectedPublishSuccess(status: number): boolean;

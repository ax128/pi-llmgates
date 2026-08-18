import { describe, expect, it } from "vitest";
import {
	buildProbeBody,
	isUnexpectedPublishSuccess,
	npmTarballBasename,
} from "../scripts/npm-publish-auth-link.mjs";

const manifest = {
	name: "@llmgates_api/pi-llmgates-provider",
	version: "0.9.9",
	description: "probe fixture",
};

describe("npm publish auth-link probe body", () => {
	it("pins versions, dist-tags, and tarball name to the published version, not the pending one", () => {
		const probeVersion = "0.3.1";
		const body = buildProbeBody(manifest, probeVersion);
		const pending = manifest.version;
		const tarball = npmTarballBasename(manifest.name, probeVersion);

		expect(probeVersion).not.toBe(pending);
		expect(body["dist-tags"]).toEqual({ latest: probeVersion });
		expect(Object.keys(body.versions)).toEqual([probeVersion]);
		expect(body.versions[probeVersion]?.version).toBe(probeVersion);
		expect(body.versions[probeVersion]?.version).not.toBe(pending);
		expect(body.versions[pending]).toBeUndefined();
		expect(Object.keys(body._attachments)).toEqual([tarball]);
		expect(body._attachments[tarball]).toEqual({
			content_type: "application/octet-stream",
			data: "",
			length: 0,
		});
		expect(body.versions[probeVersion]?.dist.shasum).toBe("0".repeat(40));
		expect(body.versions[probeVersion]?.dist.integrity.startsWith("sha512-")).toBe(true);
		expect(tarball).not.toContain(pending);
	});

	it("treats 200/201 as an unexpected publish success, not OK", () => {
		expect(isUnexpectedPublishSuccess(200)).toBe(true);
		expect(isUnexpectedPublishSuccess(201)).toBe(true);
		expect(isUnexpectedPublishSuccess(401)).toBe(false);
		expect(isUnexpectedPublishSuccess(409)).toBe(false);
	});
});

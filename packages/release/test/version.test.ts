import { describe, expect, it } from "vitest";
import { bumpVersion, compareVersions, isVersion } from "../src/version.ts";

describe("versions", () => {
	it("accepts semantic versions only", () => {
		expect(isVersion("1.5.0")).toBe(true);
		expect(isVersion("1.5.0-rc.1")).toBe(true);
		expect(isVersion("1.5")).toBe(false);
		expect(isVersion("v1.5.0")).toBe(false);
		expect(isVersion("01.5.0")).toBe(false);
	});

	it("orders versions as semver does", () => {
		const sorted = [
			"1.0.0",
			"1.0.0-rc.10",
			"0.9.0",
			"1.0.0-rc.2",
			"1.0.0-beta",
			"1.1.0",
			"1.0.0-rc.2.1",
		].sort(compareVersions);
		expect(sorted).toEqual([
			"0.9.0",
			"1.0.0-beta",
			"1.0.0-rc.2",
			"1.0.0-rc.2.1",
			"1.0.0-rc.10",
			"1.0.0",
			"1.1.0",
		]);
	});

	it("bumps a release", () => {
		expect(bumpVersion("1.4.0", "patch")).toBe("1.4.1");
		expect(bumpVersion("1.4.2", "minor")).toBe("1.5.0");
		expect(bumpVersion("1.4.2", "major")).toBe("2.0.0");
		expect(bumpVersion("0.2.0", "minor")).toBe("0.3.0");
	});

	it("bumps a prerelease to its own release when that is the bump", () => {
		expect(bumpVersion("1.5.0-rc.1", "minor")).toBe("1.5.0");
		expect(bumpVersion("1.5.0-rc.1", "patch")).toBe("1.5.0");
		expect(bumpVersion("1.5.1-rc.1", "minor")).toBe("1.6.0");
		expect(bumpVersion("2.0.0-rc.1", "major")).toBe("2.0.0");
	});
});

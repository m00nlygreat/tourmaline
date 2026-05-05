import { describe, expect, it } from "vitest";
import { normalizeCanvasMeta } from "../src/meta-store";

describe("normalizeCanvasMeta", () => {
	it("keeps v2 scoped metadata", () => {
		const meta = normalizeCanvasMeta({
			version: 2,
			scopes: {
				"scope:root": {
					zoom: 0.75,
					items: {
						a: { id: "a", x: 1, y: 2, width: 3, height: 4 }
					}
				}
			}
		});

		expect(meta.scopes["scope:root"]?.zoom).toBe(0.75);
		expect(meta.scopes["scope:root"]?.items.a?.x).toBe(1);
	});

	it("migrates legacy flat metadata into the root scope", () => {
		const meta = normalizeCanvasMeta({
			zoom: 1.25,
			items: {
				card: { id: "card", x: 10, y: 20, width: 300, height: 200 }
			}
		});

		expect(meta).toEqual({
			version: 2,
			scopes: {
				"scope:root": {
					zoom: 1.25,
					items: {
						card: { id: "card", x: 10, y: 20, width: 300, height: 200 }
					}
				}
			}
		});
	});
});

import { describe, expect, it } from "vitest";
import { getResolvedSubpathStartLine, parseMarkdownStructure } from "../src/domain";

describe("parseMarkdownStructure", () => {
	it("excludes frontmatter and preserves body line offsets", () => {
		const parsed = parseMarkdownStructure("---\ntitle: Test\n---\n\n# Alpha\nBody");
		const alpha = parsed.scopes["scope:root"]?.sections[0];

		expect(alpha?.title).toBe("Alpha");
		expect(alpha?.startLine).toBe(4);
		expect(alpha?.endLine).toBe(5);
	});

	it("splits shell-less content by nested headings", () => {
		const parsed = parseMarkdownStructure("Intro\n\n## Loose A\nA\n\n## Loose B\nB");
		const root = parsed.scopes["scope:root"];

		expect(root?.sections).toHaveLength(2);
		expect(root?.sections.map((section) => section.title)).toEqual([
			"Loose A",
			"Loose B"
		]);
		expect(root?.orphans[0]?.content.trim()).toBe("Intro");
	});

	it("keeps duplicate heading ids stable by heading path occurrence", () => {
		const parsed = parseMarkdownStructure("# Topic\nA\n\n# Topic\nB");
		const ids = parsed.scopes["scope:root"]?.sections.map((section) => section.id);

		expect(ids).toEqual(["section:Topic", "section:Topic~2"]);
	});

	it("adds the entered scope heading back as a scope-local orphan", () => {
		const parsed = parseMarkdownStructure("# Parent\nIntro\n\n## Child\nText");
		const childScope = parsed.scopes["scope:Parent"];

		expect(childScope?.orphans[0]).toMatchObject({
			id: "orphan:scope:Parent:scope-heading",
			content: "# Parent",
			startLine: 0
		});
	});

	it("creates child scopes for shell-less heading groups", () => {
		const parsed = parseMarkdownStructure("Intro\n\n## Loose\nText\n\n# Shell\nBody");
		const orphan = parsed.scopes["scope:root"]?.orphans.find((node) =>
			node.content.includes("Loose")
		);

		expect(orphan?.childScopeId).toBe("scope:scope:root:orphan:Loose");
		expect(parsed.scopes[orphan?.childScopeId ?? ""]?.title).toBe("Loose");
	});

	it("reads embed subpath line from the resolved result start location", () => {
		const line = getResolvedSubpathStartLine({
			type: "heading",
			start: { line: 12, col: 0, offset: 120 },
			end: null,
			current: {
				heading: "Target",
				level: 2,
				position: {
					start: { line: 99, col: 0, offset: 990 },
					end: { line: 99, col: 9, offset: 999 }
				}
			},
			next: null
		} as never);

		expect(line).toBe(12);
	});
});

export class ItemView {}

export class MarkdownView {
	file: { extension?: string } | null = null;
	editor = null;
}

export class Notice {
	constructor(public message: string) {}
}

export class TFile {
	constructor(
		public path = "",
		public extension = ""
	) {}
}

export const MarkdownRenderer = {
	render: async () => undefined
};

export function getFrontMatterInfo(markdown: string) {
	const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
	if (!match) {
		return {
			exists: false,
			contentStart: 0
		};
	}

	return {
		exists: true,
		contentStart: match[0].length
	};
}

export function getLinkpath(link: string) {
	return link.split("#")[0] ?? link;
}

export function resolveSubpath() {
	return null;
}

export function setIcon() {}

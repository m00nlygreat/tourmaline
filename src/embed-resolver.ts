import { App, getLinkpath, resolveSubpath, TFile } from "obsidian";
import {
	extractLinkSubpath,
	getParentScopeId,
	getResolvedSubpathStartLine,
	parseMarkdownStructure
} from "./domain";
import type { EmbedNode, ParsedDocument, RenderableScopeItem } from "./types";

type EmbedTarget = {
	file: TFile;
	scopeId: string;
	line: number;
};

export class EmbedResolver {
	constructor(private readonly app: App) {}

	async resolveForRenderable(
		currentFile: TFile | null,
		renderable: Exclude<RenderableScopeItem, { kind: "frontmatter" }>
	): Promise<EmbedNode[]> {
		if (!currentFile) {
			return [];
		}

		const fileCache = this.app.metadataCache.getFileCache(currentFile);
		const embeds = fileCache?.embeds ?? [];
		const lineRange = {
			start: renderable.startLine,
			end: renderable.item.endLine
		};
		const matchingEmbeds = embeds
			.filter((embed) => {
				const startLine = embed.position.start.line;
				const endLine = embed.position.end.line;
				return startLine >= lineRange.start && endLine <= lineRange.end;
			})
			.sort(
				(a, b) =>
					a.position.start.line - b.position.start.line ||
					a.position.start.col - b.position.start.col
			);

		const resolvedEmbeds: EmbedNode[] = [];
		for (const [index, embed] of matchingEmbeds.entries()) {
			const target = await this.resolveTarget(currentFile, embed.link);
			resolvedEmbeds.push({
				id: `embed:${renderable.id}:${index}:${embed.position.start.line}`,
				parentId: renderable.id,
				label: embed.displayText?.trim() || embed.original.trim() || embed.link,
				link: embed.link,
				original: embed.original,
				startLine: embed.position.start.line,
				endLine: embed.position.end.line,
				sourceScopeId:
					renderable.kind === "section"
						? getParentScopeId(renderable.item.scopeId) ?? "scope:root"
						: renderable.item.scopeId,
				targetFilePath: target?.file.path ?? null,
				targetScopeId: target?.scopeId ?? null,
				targetLine: target?.line ?? null
			});
		}

		return resolvedEmbeds;
	}

	async resolveTarget(currentFile: TFile | null, link: string): Promise<EmbedTarget | null> {
		if (!currentFile) {
			return null;
		}

		const targetFile = this.app.metadataCache.getFirstLinkpathDest(
			getLinkpath(link),
			currentFile.path
		);
		if (!(targetFile instanceof TFile)) {
			return null;
		}

		const subpath = extractLinkSubpath(link);
		if (!subpath) {
			return {
				file: targetFile,
				scopeId: "scope:root",
				line: 0
			};
		}

		const fileCache = this.app.metadataCache.getFileCache(targetFile);
		const resolvedSubpath = fileCache ? resolveSubpath(fileCache, subpath) : null;
		const targetLine = getResolvedSubpathStartLine(resolvedSubpath);
		const parsed = await this.parseFileStructure(targetFile);
		if (!parsed) {
			return {
				file: targetFile,
				scopeId: "scope:root",
				line: targetLine
			};
		}

		const scopeId = this.findScopeIdForTargetLine(parsed, targetLine);
		return {
			file: targetFile,
			scopeId,
			line: targetLine
		};
	}

	private async parseFileStructure(file: TFile) {
		const source = await this.app.vault.read(file);
		return parseMarkdownStructure(source);
	}

	private findScopeIdForTargetLine(parsed: ParsedDocument, line: number) {
		const matchingSection = Object.values(parsed.scopes)
			.flatMap((scope) => scope.sections)
			.find((section) => section.startLine === line);
		if (matchingSection) {
			return matchingSection.scopeId;
		}

		const matchingScope = Object.values(parsed.scopes).find(
			(scope) => line >= scope.startLine && line <= scope.endLine
		);
		return matchingScope?.id ?? parsed.rootScopeId;
	}
}

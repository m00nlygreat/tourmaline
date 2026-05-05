import { Notice, TFile, Vault } from "obsidian";
import { META_SUFFIX } from "./constants";
import type { CanvasItemState, CanvasMeta } from "./types";

type LegacyCanvasMeta = {
	version?: number;
	zoom?: number;
	items?: Record<string, CanvasItemState>;
};

export function normalizeCanvasMeta(parsed: CanvasMeta | LegacyCanvasMeta): CanvasMeta {
	if ("scopes" in parsed && parsed.scopes) {
		return {
			version: 2,
			scopes: parsed.scopes
		};
	}

	const legacyMeta = parsed as LegacyCanvasMeta;
	return {
		version: 2,
		scopes: {
			"scope:root": {
				zoom: legacyMeta.zoom ?? 1,
				items: legacyMeta.items ?? {}
			}
		}
	};
}

export class CanvasMetaStore {
	constructor(private readonly vault: Vault) {}

	getMetaPath(file: TFile) {
		const parent = file.parent?.path;
		const base = `${file.basename}${META_SUFFIX}`;
		return parent ? `${parent}/${base}` : base;
	}

	getScopeMeta(meta: CanvasMeta, scopeId: string) {
		return (
			meta.scopes[scopeId] ?? {
				zoom: 1,
				items: {}
			}
		);
	}

	async read(file: TFile): Promise<CanvasMeta> {
		const metaPath = this.getMetaPath(file);
		const existing = this.vault.getAbstractFileByPath(metaPath);
		if (!(existing instanceof TFile)) {
			return {
				version: 2,
				scopes: {}
			};
		}

		try {
			const parsed = JSON.parse(await this.vault.read(existing)) as
				| CanvasMeta
				| LegacyCanvasMeta;
			return normalizeCanvasMeta(parsed);
		} catch {
			new Notice("Could not parse Arkidian metadata. Resetting layout.");
			return {
				version: 2,
				scopes: {}
			};
		}
	}

	async write(file: TFile, meta: CanvasMeta) {
		const metaPath = this.getMetaPath(file);
		const existing = this.vault.getAbstractFileByPath(metaPath);
		const payload = JSON.stringify(meta, null, 2);

		if (existing instanceof TFile) {
			await this.vault.modify(existing, payload);
		} else {
			await this.vault.create(metaPath, payload);
		}
	}
}

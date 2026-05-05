import { setIcon } from "obsidian";
import { createInteractiveControl, cssEscape, setInteractiveDisabled } from "./domain";
import type { LayerTreeNode, ParsedScope } from "./types";

export type LayerPanelOptions = {
	getCurrentScopeId(): string;
	getSelectedItemId(): string | null;
	isExpanded(nodeId: string): boolean;
	toggleExpanded(nodeId: string): void;
	enableReordering(row: HTMLElement, node: LayerTreeNode): void;
	selectNode(node: LayerTreeNode): void;
	enterNode(node: LayerTreeNode): void;
	openNode(node: LayerTreeNode): void;
	onRendered(tree: LayerTreeNode[]): void;
};

export class LayerPanel {
	constructor(
		private readonly container: HTMLElement,
		private readonly options: LayerPanelOptions
	) {}

	render(scope: ParsedScope, scopeTitle: string, tree: LayerTreeNode[]) {
		this.container.empty();

		const scopeHeader = this.container.createDiv({
			cls: "arkidian-layer-scope-header"
		});
		scopeHeader.createSpan({
			cls: "arkidian-layer-scope-title",
			text: scopeTitle
		});
		scopeHeader.createSpan({
			cls: "arkidian-layer-scope-meta",
			text: `${tree.length} items`
		});

		if (!tree.length) {
			this.container.createDiv({
				cls: "arkidian-layer-empty",
				text: "No visible layers."
			});
			this.options.onRendered(tree);
			return;
		}

		this.renderNodes(tree, this.container, 0);
		this.options.onRendered(tree);
	}

	revealSelected() {
		const selectedItemId = this.options.getSelectedItemId();
		if (!selectedItemId) {
			return;
		}

		window.requestAnimationFrame(() => {
			const row = this.container.querySelector<HTMLElement>(
				`.arkidian-layer-row[data-layer-node-id="${cssEscape(selectedItemId)}"]`
			);
			row?.scrollIntoView({ block: "nearest" });
		});
	}

	private renderNodes(
		nodes: LayerTreeNode[],
		container: HTMLElement,
		depth: number
	) {
		for (const node of nodes) {
			const item = container.createDiv({ cls: "arkidian-layer-item" });
			const row = item.createDiv({
				cls: "arkidian-layer-row"
			});
			row.dataset.layerNodeId = node.id;
			row.style.setProperty("--arkidian-layer-depth", `${depth}`);
			row.toggleClass("is-current-scope", node.targetScopeId === this.options.getCurrentScopeId());
			row.toggleClass(
				"is-drillable",
				node.kind !== "embed" && Boolean(node.targetScopeId || node.targetFilePath)
			);
			row.toggleClass("is-selected", node.id === this.options.getSelectedItemId());
			this.options.enableReordering(row, node);

			const isExpanded =
				node.children.length > 0 && this.options.isExpanded(node.id);

			const toggle = createInteractiveControl(row, {
				cls: "arkidian-layer-toggle",
				label: isExpanded ? "Collapse layer" : "Expand layer"
			});
			if (node.children.length) {
				setIcon(toggle, isExpanded ? "chevron-down" : "chevron-right");
				toggle.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					this.options.toggleExpanded(node.id);
				});
			} else {
				toggle.addClass("is-placeholder");
				toggle.setText("");
				setInteractiveDisabled(toggle, true);
			}

			const iconEl = row.createSpan({
				cls: "arkidian-layer-glyph"
			});
			setIcon(iconEl, node.icon);

			const labelButton = createInteractiveControl(row, {
				cls: "arkidian-layer-label-button",
				label: node.label
			});
			labelButton.createSpan({
				cls: "arkidian-layer-label",
				text: node.label
			});
			if (node.children.length) {
				labelButton.createSpan({
					cls: "arkidian-layer-children-count",
					text: `${node.children.length}`
				});
			}

			labelButton.addEventListener("click", (event) => {
				this.options.selectNode(node);
				if (event.metaKey || event.ctrlKey) {
					this.options.enterNode(node);
					return;
				}
				if (node.children.length && !isExpanded) {
					this.options.toggleExpanded(node.id);
				}
			});

			labelButton.addEventListener("dblclick", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.options.openNode(node);
			});

			if (node.children.length && isExpanded) {
				const children = item.createDiv({
					cls: "arkidian-layer-children"
				});
				this.renderNodes(node.children, children, depth + 1);
			}
		}
	}
}

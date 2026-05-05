export class SelectionController {
	selectedItemId: string | null = null;
	selectedItemEl: HTMLElement | null = null;

	isSelected(itemId: string) {
		return this.selectedItemId === itemId;
	}

	clear() {
		if (!this.selectedItemId && !this.selectedItemEl) {
			return false;
		}
		this.selectedItemEl?.removeClass("is-selected");
		this.selectedItemId = null;
		this.selectedItemEl = null;
		return true;
	}

	select(itemId: string, element: HTMLElement) {
		const changed = this.selectedItemId !== itemId || this.selectedItemEl !== element;
		if (changed) {
			this.selectedItemEl?.removeClass("is-selected");
		}
		this.selectedItemId = itemId;
		this.selectedItemEl = element;
		element.addClass("is-selected");
		return changed;
	}

	selectMissingElement(itemId: string) {
		this.selectedItemEl?.removeClass("is-selected");
		this.selectedItemId = itemId;
		this.selectedItemEl = null;
	}
}

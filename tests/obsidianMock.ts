/**
 * Minimal but faithful stand-in for the Obsidian API, used by the plugin-layer
 * tests. It implements the parts the plugin touches — Plugin/Modal/Setting
 * lifecycles, the vault adapter, DOM helpers — closely enough to run a real
 * export from `onload()` to written files.
 *
 * `happy-dom` provides the DOM; this module provides Obsidian itself.
 */

import type { App, Command } from "./types";

/* -------------------------------------------------------------------------- */
/*  Vault objects                                                              */
/* -------------------------------------------------------------------------- */

export class TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	stat: { size: number; mtime: number; ctime: number };

	constructor(path: string, size = 0, mtime = 0, ctime = 0) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
		this.basename = this.name.replace(/\.[^.]+$/, "");
		this.extension = this.name.includes(".") ? this.name.split(".").pop()! : "";
		this.stat = { size, mtime, ctime };
	}
}

export class TFolder {
	path: string;
	name: string;
	children: unknown[] = [];
	constructor(path: string) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
	}
}

/* -------------------------------------------------------------------------- */
/*  Element helpers (Obsidian augments HTMLElement)                            */
/* -------------------------------------------------------------------------- */

export interface El {
	createEl(tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): El;
	createDiv(options?: { cls?: string; text?: string }): El;
	createSpan(options?: { cls?: string; text?: string }): El;
	empty(): void;
	addClass(...classes: string[]): void;
	removeClass(...classes: string[]): void;
	toggleClass(cls: string, value: boolean): void;
	setText(text: string): void;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	onClickEvent(callback: () => unknown): void;
	readonly children: HTMLCollection;
	querySelectorAll(selector: string): NodeListOf<Element>;
}

/**
 * Adds Obsidian's element helpers to a DOM element. The assignments go
 * through a loose view because the real typings declare `createEl` with an
 * overload set of their own.
 */
function augment(el: HTMLElement): El {
	const raw = el as unknown as Record<string, unknown>;
	raw.createEl = (tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }) => {
		const child = document.createElement(tag);
		if (options?.cls) child.className = options.cls;
		if (options?.text) child.textContent = options.text;
		for (const [key, value] of Object.entries(options?.attr ?? {})) child.setAttribute(key, value);
		el.appendChild(child);
		return augment(child);
	};
	raw.createDiv = (options?: { cls?: string; text?: string }) => (raw.createEl as El["createEl"])("div", options);
	raw.createSpan = (options?: { cls?: string; text?: string }) => (raw.createEl as El["createEl"])("span", options);
	raw.empty = () => {
		while (el.firstChild) el.removeChild(el.firstChild);
	};
	raw.addClass = (...classes: string[]) => el.classList.add(...classes);
	raw.removeClass = (...classes: string[]) => el.classList.remove(...classes);
	raw.toggleClass = (cls: string, value: boolean) => el.classList.toggle(cls, value);
	raw.setText = (text: string) => {
		el.textContent = text;
	};
	raw.onClickEvent = (callback: () => unknown) => {
		el.addEventListener("click", () => void callback());
	};
	return el as unknown as El;
}

export function createElement(tag = "div"): El {
	return augment(document.createElement(tag));
}

/* -------------------------------------------------------------------------- */
/*  Component / Plugin lifecycle                                               */
/* -------------------------------------------------------------------------- */

export interface RegisteredCommand extends Command {
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean;
}

export class Component {
	loaded = false;
	load(): void {
		this.loaded = true;
	}
	unload(): void {
		this.loaded = false;
	}
	addChild(child: Component): void {
		child.load();
	}
	registerEvent(..._args: unknown[]): void {}
}

export class Notice {
	static messages: string[] = [];
	/** The most recently created notice, for tests that need its element. */
	static last: Notice | null = null;
	noticeEl: El;
	message: string;
	constructor(message: string, _timeout?: number) {
		this.message = message;
		Notice.messages.push(message);
		this.noticeEl = createElement();
		Notice.last = this;
	}
	setMessage(message: string): void {
		this.message = message;
		Notice.messages.push(message);
	}
	hide(): void {}
}

export class Modal {
	readonly contentEl: El;
	readonly modalEl: El;
	app: App;
	open_ = false;
	onOpenCallback?: () => void;
	constructor(app: App) {
		this.app = app;
		this.contentEl = createElement();
		this.modalEl = createElement();
	}
	open(): void {
		this.open_ = true;
		this.onOpen();
	}
	close(): void {
		this.open_ = false;
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

export class PluginSettingTab {
	app: App;
	containerEl: El = createElement();
	constructor(app: App, _plugin: unknown) {
		this.app = app;
	}
	display(): void {}
}

export class Plugin extends Component {
	app: App;
	manifest: { id: string; version: string };
	commands: RegisteredCommand[] = [];
	statusBarItems: El[] = [];
	ribbonIcons: { icon: string; title: string; callback: () => unknown }[] = [];
	data: unknown = null;
	settingTabs: PluginSettingTab[] = [];
	registeredEvents: { type: string; handler: (...args: never[]) => void }[] = [];
	private unloadCallbacks: (() => unknown)[] = [];

	constructor(app: App, manifest: { id: string; version: string }) {
		super();
		this.app = app;
		this.manifest = manifest;
	}

	async loadData(): Promise<unknown> {
		return this.data;
	}
	async saveData(data: unknown): Promise<void> {
		this.data = data;
	}
	addCommand(command: RegisteredCommand): RegisteredCommand {
		this.commands.push(command);
		return command;
	}
	addRibbonIcon(icon: string, title: string, callback: () => unknown): El {
		this.ribbonIcons.push({ icon, title, callback });
		return createElement();
	}
	addStatusBarItem(): El {
		const el = createElement();
		this.statusBarItems.push(el);
		return el;
	}
	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
	}
	registerEvent(event: { type: string; handler: (...args: never[]) => void }): void {
		this.registeredEvents.push(event);
	}
	registerDomEvent(): void {}
	registerInterval(): void {}
	onload(): void {}
	onunload(): void {}
	/** Runs the registered unload callbacks (called by the test harness). */
	async unloadPlugin(): Promise<void> {
		this.onunload();
		for (const callback of this.unloadCallbacks) await callback();
	}
}

/* -------------------------------------------------------------------------- */
/*  Settings UI                                                                */
/* -------------------------------------------------------------------------- */

export class Setting {
	/** Every Setting built during a test, so tests can drive the UI. */
	static instances: Setting[] = [];
	containerEl: El;
	name = "";
	desc = "";
	controls: unknown[] = [];

	constructor(containerEl: El | HTMLElement) {
		this.containerEl = containerEl as El;
		Setting.instances.push(this);
	}

	/** Test helper: first control of the given kind (e.g. ToggleComponent). */
	control<T>(type: new () => T): T | undefined {
		return this.controls.find((control): control is T => control instanceof type);
	}
	setName(name: string): this {
		this.name = name;
		return this;
	}
	setDesc(desc: string): this {
		this.desc = desc;
		return this;
	}
	setHeading(): this {
		return this;
	}
	setClass(): this {
		return this;
	}
	addText(callback: (component: TextComponent) => unknown): this {
		const component = new TextComponent();
		this.controls.push(component);
		callback(component);
		return this;
	}
	addTextArea(callback: (component: TextComponent) => unknown): this {
		return this.addText(callback);
	}
	addToggle(callback: (component: ToggleComponent) => unknown): this {
		const component = new ToggleComponent();
		this.controls.push(component);
		callback(component);
		return this;
	}
	addDropdown(callback: (component: DropdownComponent) => unknown): this {
		const component = new DropdownComponent();
		this.controls.push(component);
		callback(component);
		return this;
	}
	addSlider(callback: (component: SliderComponent) => unknown): this {
		const component = new SliderComponent();
		this.controls.push(component);
		callback(component);
		return this;
	}
	addButton(callback: (component: ButtonComponent) => unknown): this {
		const component = new ButtonComponent();
		this.controls.push(component);
		callback(component);
		return this;
	}
	addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
		const component = new ExtraButtonComponent();
		this.controls.push(component);
		callback(component);
		return this;
	}
}

export class TextComponent {
	inputEl: HTMLInputElement = document.createElement("input") as HTMLInputElement;
	private decorated = augment(this.inputEl);
	value = "";
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	setPlaceholder(value: string): this {
		this.decorated.setAttribute("placeholder", value);
		return this;
	}
	onChange(callback: (value: string) => unknown): this {
		this.inputEl.addEventListener("change", () => void callback(this.value));
		return this;
	}
	/** Test helper: simulate the user typing. */
	async setUserValue(value: string): Promise<void> {
		this.value = value;
		this.inputEl.dispatchEvent(new Event("change"));
	}
}

export class ToggleComponent {
	value = false;
	setValue(value: boolean): this {
		this.value = value;
		return this;
	}
	setTooltip(_tooltip: string): this {
		return this;
	}
	onChange(callback: (value: boolean) => unknown): this {
		this.callback = callback as (value: boolean) => unknown;
		return this;
	}
	callback?: (value: boolean) => unknown;
	async toggleUser(value: boolean): Promise<void> {
		this.value = value;
		await this.callback?.(value);
	}
}

export class DropdownComponent {
	options: Record<string, string> = {};
	value = "";
	addOption(value: string, label: string): this {
		this.options[value] = label;
		return this;
	}
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	onChange(callback: (value: string) => unknown): this {
		this.callback = callback as (value: string) => unknown;
		return this;
	}
	callback?: (value: string) => unknown;
	async selectUser(value: string): Promise<void> {
		this.value = value;
		await this.callback?.(value);
	}
}

export class SliderComponent {
	values: { limits?: [number, number, number]; value: number } = { value: 0 };
	setLimits(min: number, max: number, step: number): this {
		this.values.limits = [min, max, step];
		return this;
	}
	setValue(value: number): this {
		this.values.value = value;
		return this;
	}
	setDynamicTooltip(): this {
		return this;
	}
	onChange(callback: (value: number) => unknown): this {
		this.callback = callback as (value: number) => unknown;
		return this;
	}
	callback?: (value: number) => unknown;
	async slideUser(value: number): Promise<void> {
		this.values.value = value;
		await this.callback?.(value);
	}
}

export class ButtonComponent {
	label = "";
	disabled = false;
	onClickCallback?: () => unknown;
	setButtonText(label: string): this {
		this.label = label;
		return this;
	}
	setTooltip(_tooltip: string): this {
		return this;
	}
	setCta(): this {
		return this;
	}
	setDisabled(value = true): this {
		this.disabled = value;
		return this;
	}
	onClick(callback: () => unknown): this {
		this.onClickCallback = callback;
		return this;
	}
	/** Test helper: click the button. */
	async click(): Promise<void> {
		await this.onClickCallback?.();
	}
}

export class ExtraButtonComponent extends ButtonComponent {
	setIcon(_icon: string): this {
		return this;
	}
}

/* -------------------------------------------------------------------------- */
/*  Misc                                                                       */
/* -------------------------------------------------------------------------- */

export function setIcon(el: HTMLElement, icon: string): void {
	el.setAttribute("data-icon", icon);
}

export const MarkdownRenderer = {
	async render(_app: App, markdown: string, el: HTMLElement): Promise<void> {
		el.textContent = markdown.slice(0, 500);
	},
};

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
	return fn;
}

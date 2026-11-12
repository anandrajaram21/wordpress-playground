import { logger } from '@php-wasm/logger';

/**
 * Each tab is a full WordPress document kept alive in memory, so cap how many can exist.
 */
const MAX_TABS = 8;

interface WordPressTab {
	frame: HTMLIFrameElement;
	title?: string;
}

export interface WordPressTabs {
	/** The visible WordPress frame. Navigation and URL reads apply to this one. */
	activeFrame(): HTMLIFrameElement;
	/** Every WordPress frame, including the hidden ones. */
	frames(): HTMLIFrameElement[];
	/** The tab frame that sent a message, if the message came from one. */
	frameForWindow(
		source: MessageEventSource | null
	): HTMLIFrameElement | undefined;
	/** Called after the user opens, switches to, or closes a tab. */
	onActiveTabChange(listener: () => void): void;
	/** Called on every load of every tab frame, including tabs opened later. */
	onFrameLoad(listener: (frame: HTMLIFrameElement) => void): void;
}

/**
 * Prototype: tabs inside Playground for WordPress links that ask for a new tab.
 *
 * WordPress opens some of its own pages with target="_blank", e.g. the Site Editor's
 * "View site". A real browser tab would show that page without the Playground UI. The
 * MU plugin sends playground-open-tab instead, and this module loads the URL in another
 * iframe next to the first one. All frames share the same PHP runtime, cookies and site.
 *
 * The first tab is the original #wp frame. It cannot be closed: the WebMCP bridge and
 * the postMessage relay are still bound to it. The tab strip stays hidden until a
 * second tab exists, so a Playground that never opens one looks the same as before.
 *
 * @see https://github.com/WordPress/wordpress-playground/issues/2838
 * @see packages/playground/remote/src/lib/playground-mu-plugin/0-playground.php
 */
export function createWordPressTabs(
	primaryFrame: HTMLIFrameElement,
	wordPressOrigin: string
): WordPressTabs {
	const tabs: WordPressTab[] = [{ frame: primaryFrame }];
	let activeTab = tabs[0];
	const activeTabListeners: Array<() => void> = [];
	const frameLoadListeners: Array<(frame: HTMLIFrameElement) => void> = [];

	const tabStrip = document.createElement('div');
	tabStrip.className = 'wp-tabs';
	tabStrip.setAttribute('role', 'tablist');
	tabStrip.setAttribute('aria-label', 'WordPress tabs');
	tabStrip.hidden = true;
	primaryFrame.before(tabStrip);

	// Accept messages only from our own tab frames at the WordPress origin. Checking the
	// origin alone would also accept messages from other Playgrounds on that origin.
	window.addEventListener('message', (event: MessageEvent) => {
		const tab = tabs.find(
			(candidate) => candidate.frame.contentWindow === event.source
		);
		if (!tab || event.origin !== wordPressOrigin) {
			return;
		}
		let data;
		try {
			data =
				typeof event.data === 'string'
					? JSON.parse(event.data)
					: event.data;
		} catch {
			// Ignore non-JSON messages from other WordPress scripts.
			return;
		}
		if (
			data?.type === 'playground-open-tab' &&
			typeof data.url === 'string'
		) {
			openTab(data.url);
		} else if (
			data?.type === 'playground-url-change' &&
			typeof data.title === 'string'
		) {
			// WordPress reports its title with the startup URL of every page.
			tab.title = data.title;
			renderTabStrip();
		}
	});

	return {
		activeFrame: () => activeTab.frame,
		frames: () => tabs.map((tab) => tab.frame),
		frameForWindow: (source) =>
			tabs.find((tab) => tab.frame.contentWindow === source)?.frame,
		onActiveTabChange(listener) {
			activeTabListeners.push(listener);
		},
		onFrameLoad(listener) {
			frameLoadListeners.push(listener);
			tabs.forEach((tab) =>
				tab.frame.addEventListener('load', () => listener(tab.frame))
			);
		},
	};

	function openTab(url: string) {
		let tabUrl: URL;
		try {
			tabUrl = new URL(url);
		} catch {
			return;
		}
		// Only this WordPress origin may be framed. External links open a browser tab.
		if (tabUrl.origin !== wordPressOrigin) {
			return;
		}
		if (tabs.length >= MAX_TABS) {
			logger.warn(
				`Not opening ${url}: Playground supports up to ${MAX_TABS} tabs.`
			);
			return;
		}

		const frame = document.createElement('iframe');
		frame.className = primaryFrame.className;
		frame.title = primaryFrame.title;
		const sandbox = primaryFrame.getAttribute('sandbox');
		if (sandbox !== null) {
			frame.setAttribute('sandbox', sandbox);
		}
		frameLoadListeners.forEach((listener) =>
			frame.addEventListener('load', () => listener(frame))
		);
		frame.src = tabUrl.href;

		const tab: WordPressTab = { frame };
		tabs[tabs.length - 1].frame.after(frame);
		tabs.push(tab);
		activateTab(tab);
	}

	function closeTab(tab: WordPressTab) {
		const index = tabs.indexOf(tab);
		// The first tab hosts the frame the rest of remote.html is bound to.
		if (index <= 0) {
			return;
		}
		tabs.splice(index, 1);
		tab.frame.remove();
		if (tab === activeTab) {
			activateTab(tabs[index] ?? tabs[index - 1]);
		} else {
			renderTabStrip();
		}
	}

	function activateTab(tab: WordPressTab) {
		activeTab = tab;
		tabs.forEach((candidate) => {
			candidate.frame.hidden = candidate !== activeTab;
		});
		renderTabStrip();
		activeTabListeners.forEach((listener) => listener());
	}

	function renderTabStrip() {
		const hasSeveralTabs = tabs.length > 1;
		tabStrip.hidden = !hasSeveralTabs;
		document.body.classList.toggle('has-wp-tabs', hasSeveralTabs);
		tabStrip.replaceChildren(
			...tabs.map((tab, index) => {
				const isActive = tab === activeTab;
				const item = document.createElement('div');
				item.className = 'wp-tab';
				item.classList.toggle('is-active', isActive);

				const label = document.createElement('button');
				label.type = 'button';
				label.className = 'wp-tab__label';
				label.setAttribute('role', 'tab');
				label.setAttribute('aria-selected', String(isActive));
				label.textContent = tab.title || 'WordPress';
				label.title = label.textContent;
				label.addEventListener('click', () => activateTab(tab));
				item.append(label);

				if (index > 0) {
					const close = document.createElement('button');
					close.type = 'button';
					close.className = 'wp-tab__close';
					close.setAttribute(
						'aria-label',
						`Close tab: ${label.textContent}`
					);
					close.textContent = '×';
					close.addEventListener('click', () => closeTab(tab));
					item.append(close);
				}
				return item;
			})
		);
	}
}

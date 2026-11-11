/**
 * Lightweight Synthetic DOM environment for headless testing of Cast Pill & UI components
 * without external jsdom or happy-dom dependencies (adhering to zero-external-dependency rule).
 */

function setSubtreeConnected(el: SyntheticElement, isConnected: boolean): void {
  el.isConnected = isConnected;
  for (const child of el.children) {
    setSubtreeConnected(child, isConnected);
  }
}

export class SyntheticElement extends EventTarget {
  public tagName: string;
  public className = '';
  public id = '';
  public textContent = '';
  public hidden = false;
  public disabled = false;
  public value = '';
  public type = '';
  public style: Record<string, string> = {};
  public isConnected = false;

  public parentElement: SyntheticElement | null = null;
  public readonly children: SyntheticElement[] = [];
  public shadowRoot: SyntheticShadowRoot | null = null;

  private readonly attributes = new Map<string, string>();
  private _content: SyntheticElement | null = null;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
    if (this.tagName === 'TEMPLATE') {
      this._content = new SyntheticElement('FRAGMENT');
    }
  }

  public get classList() {
    return {
      contains: (cls: string): boolean =>
        this.className.split(/\s+/).filter(Boolean).includes(cls),
      add: (...classes: string[]): void => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const c of classes) set.add(c);
        this.className = Array.from(set).join(' ');
        this.attributes.set('class', this.className);
      },
      remove: (...classes: string[]): void => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const c of classes) set.delete(c);
        this.className = Array.from(set).join(' ');
        this.attributes.set('class', this.className);
      },
      toggle: (cls: string, force?: boolean): boolean => {
        const has = this.className.split(/\s+/).filter(Boolean).includes(cls);
        const next = force !== undefined ? force : !has;
        if (next) this.classList.add(cls);
        else this.classList.remove(cls);
        return next;
      },
    };
  }

  public get content(): SyntheticElement {
    if (!this._content) {
      this._content = new SyntheticElement('FRAGMENT');
    }
    return this._content;
  }

  public get innerHTML(): string {
    return this.children
      .map(
        (c) =>
          `<${c.tagName.toLowerCase()}>${c.textContent}</${c.tagName.toLowerCase()}>`,
      )
      .join('');
  }

  public set innerHTML(html: string) {
    const parsed = parseHtmlToSyntheticElements(html);
    if (this.tagName === 'TEMPLATE') {
      this.content.replaceChildren(...parsed);
    } else {
      this.replaceChildren(...parsed);
    }
  }

  public setAttribute(name: string, value: string): void {
    const lower = name.toLowerCase();
    this.attributes.set(lower, value);
    if (lower === 'class') {
      this.className = value;
    } else if (lower === 'id') {
      this.id = value;
    } else if (lower === 'hidden') {
      this.hidden = true;
    } else if (lower === 'disabled') {
      this.disabled = true;
    } else if (lower === 'value') {
      this.value = value;
    } else if (lower === 'type') {
      this.type = value;
    }
  }

  public getAttribute(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower === 'class') {
      return this.className || null;
    }
    if (lower === 'id') {
      return this.id || null;
    }
    return this.attributes.get(lower) ?? null;
  }

  public removeAttribute(name: string): void {
    const lower = name.toLowerCase();
    this.attributes.delete(lower);
    if (lower === 'class') {
      this.className = '';
    } else if (lower === 'id') {
      this.id = '';
    } else if (lower === 'hidden') {
      this.hidden = false;
    } else if (lower === 'disabled') {
      this.disabled = false;
    }
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }

  public append(...nodes: (SyntheticElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.textContent += node;
      } else {
        node.remove();
        node.parentElement = this;
        setSubtreeConnected(node, this.isConnected);
        this.children.push(node);
      }
    }
  }

  public replaceChildren(...nodes: (SyntheticElement | string)[]): void {
    for (const child of this.children) {
      child.parentElement = null;
      child.isConnected = false;
    }
    this.children.length = 0;
    this.textContent = '';
    this.append(...nodes);
  }

  public remove(): void {
    if (this.parentElement !== null) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
    }
    this.isConnected = false;
  }

  public attachShadow(_init: { mode: 'open' | 'closed'; delegatesFocus?: boolean }): SyntheticShadowRoot {
    const shadow = new SyntheticShadowRoot(this);
    this.shadowRoot = shadow;
    return shadow;
  }

  public cloneNode(deep = false): SyntheticElement {
    const clone = new SyntheticElement(this.tagName);
    clone.className = this.className;
    clone.id = this.id;
    clone.textContent = this.textContent;
    clone.hidden = this.hidden;
    clone.disabled = this.disabled;
    clone.value = this.value;
    clone.type = this.type;
    clone.style = { ...this.style };
    for (const [k, v] of this.attributes.entries()) {
      clone.setAttribute(k, v);
    }
    if (this.tagName === 'TEMPLATE' && this._content) {
      clone._content = this._content.cloneNode(true);
    }
    if (deep) {
      for (const child of this.children) {
        clone.append(child.cloneNode(true));
      }
    }
    return clone;
  }

  public querySelector<T extends SyntheticElement = SyntheticElement>(selector: string): T | null {
    return (findFirstMatching(this.children, selector) as T | null) ?? null;
  }

  public querySelectorAll<T extends SyntheticElement = SyntheticElement>(selector: string): T[] {
    return findAllMatching(this.children, selector) as T[];
  }

  public click(): void {
    this.dispatchEvent(new Event('click', { bubbles: true }));
  }
}

export class SyntheticShadowRoot {
  public readonly host: SyntheticElement;
  public readonly children: SyntheticElement[] = [];
  public adoptedStyleSheets: unknown[] = [];

  constructor(host: SyntheticElement) {
    this.host = host;
  }

  public append(...nodes: (SyntheticElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node !== 'string') {
        node.parentElement = this.host;
        setSubtreeConnected(node, this.host.isConnected);
        this.children.push(node);
      }
    }
  }

  public querySelector<T extends SyntheticElement = SyntheticElement>(selector: string): T | null {
    return (findFirstMatching(this.children, selector) as T | null) ?? null;
  }

  public querySelectorAll<T extends SyntheticElement = SyntheticElement>(selector: string): T[] {
    return findAllMatching(this.children, selector) as T[];
  }
}

function parseHtmlToSyntheticElements(html: string): SyntheticElement[] {
  const root = new SyntheticElement('ROOT');
  const stack: SyntheticElement[] = [root];

  const tagRegex =
    /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9:-]+)((?:\s+[^=>\s]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^>\s]+))?)*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;

  const VOID_TAGS = new Set([
    'AREA',
    'BASE',
    'BR',
    'COL',
    'EMBED',
    'HR',
    'IMG',
    'INPUT',
    'LINK',
    'META',
    'PARAM',
    'SOURCE',
    'TRACK',
    'WBR',
    'PATH',
    'CIRCLE',
    'RECT',
    'LINE',
    'POLYGON',
    'POLYLINE',
  ]);

  while ((match = tagRegex.exec(html)) !== null) {
    const [full, isClosing, tagName, rawAttrs, isSelfClosing, text] = match;
    if (full.startsWith('<!--')) {
      continue;
    }
    if (text) {
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        const top = stack[stack.length - 1];
        if (top) {
          top.textContent += text;
        }
      }
      continue;
    }

    if (tagName) {
      const upperTag = tagName.toUpperCase();
      if (isClosing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i]?.tagName === upperTag) {
            stack.length = i;
            break;
          }
        }
      } else {
        const el = new SyntheticElement(upperTag);
        if (rawAttrs) {
          const attrRegex =
            /([a-zA-Z0-9:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
          let attrMatch: RegExpExecArray | null;
          while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
            const attrName = attrMatch[1];
            const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
            if (attrName) {
              el.setAttribute(attrName, attrVal);
            }
          }
        }
        const top = stack[stack.length - 1];
        top?.append(el);

        const selfClosing = isSelfClosing === '/' || VOID_TAGS.has(upperTag);
        if (!selfClosing) {
          stack.push(el);
        }
      }
    }
  }

  return root.children;
}

function matchesSimple(el: SyntheticElement, part: string): boolean {
  if (!part || part === '*') return true;
  let current = part;
  const tagMatch = /^([a-zA-Z0-9]+)/.exec(current);
  if (tagMatch) {
    if (el.tagName !== tagMatch[1]?.toUpperCase()) {
      return false;
    }
    current = current.slice(tagMatch[0].length);
  }
  const classes = current.match(/\.([a-zA-Z0-9_-]+)/g);
  if (classes) {
    const elClasses = el.className.split(/\s+/).filter(Boolean);
    for (const c of classes) {
      if (!elClasses.includes(c.slice(1))) {
        return false;
      }
    }
    current = current.replace(/\.([a-zA-Z0-9_-]+)/g, '');
  }
  const idMatch = current.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    if (el.id !== idMatch[1]) {
      return false;
    }
    current = current.replace(/#([a-zA-Z0-9_-]+)/, '');
  }
  const attrMatches = current.match(/\[([a-zA-Z0-9_-]+)(?:=([^\]]+))?\]/g);
  if (attrMatches) {
    for (const a of attrMatches) {
      const m = /\[([a-zA-Z0-9_-]+)(?:=([^\]]+))?\]/.exec(a);
      if (m) {
        const attrKey = m[1]?.toLowerCase();
        const attrVal = m[2]?.replace(/['"]/g, '');
        if (attrKey) {
          if (!el.hasAttribute(attrKey)) return false;
          if (attrVal !== undefined && el.getAttribute(attrKey) !== attrVal) return false;
        }
      }
    }
  }
  return true;
}

function matchesSelector(el: SyntheticElement, selector: string): boolean {
  const parts = selector.split(',').map((s) => s.trim());
  return parts.some((p) => matchesSimple(el, p));
}

function findFirstMatching(
  nodes: readonly SyntheticElement[],
  selector: string,
): SyntheticElement | null {
  for (const node of nodes) {
    if (matchesSelector(node, selector)) {
      return node;
    }
    const deeper = findFirstMatching(node.children, selector);
    if (deeper !== null) {
      return deeper;
    }
  }
  return null;
}

function findAllMatching(
  nodes: readonly SyntheticElement[],
  selector: string,
): SyntheticElement[] {
  const matched: SyntheticElement[] = [];
  for (const node of nodes) {
    if (matchesSelector(node, selector)) {
      matched.push(node);
    }
    matched.push(...findAllMatching(node.children, selector));
  }
  return matched;
}

export class SyntheticDocument extends EventTarget {
  public documentElement: SyntheticElement;
  public body: SyntheticElement;

  constructor() {
    super();
    this.documentElement = new SyntheticElement('html');
    this.documentElement.isConnected = true;
    this.body = new SyntheticElement('body');
    this.body.isConnected = true;
    this.documentElement.append(this.body);
  }

  public createElement(tag: string): SyntheticElement {
    return new SyntheticElement(tag);
  }

  public querySelector<T extends SyntheticElement = SyntheticElement>(
    sel: string,
  ): T | null {
    if (matchesSelector(this.documentElement, sel)) {
      return this.documentElement as unknown as T;
    }
    return this.documentElement.querySelector<T>(sel);
  }

  public querySelectorAll<T extends SyntheticElement = SyntheticElement>(
    sel: string,
  ): T[] {
    return this.documentElement.querySelectorAll<T>(sel);
  }
}

export interface SyntheticDomScope {
  readonly document: SyntheticDocument;
  teardown(): void;
}

export function setupSyntheticDomEnvironment(): SyntheticDomScope {
  const doc = new SyntheticDocument();

  const originalDoc = (globalThis as any).document;
  const originalRaf = (globalThis as any).requestAnimationFrame;
  const originalMutationObserver = (globalThis as any).MutationObserver;
  const originalCssStyleSheet = (globalThis as any).CSSStyleSheet;

  (globalThis as any).document = doc;
  (globalThis as any).requestAnimationFrame = (cb: () => void) => {
    cb();
    return 1;
  };
  (globalThis as any).cancelAnimationFrame = () => {};
  (globalThis as any).MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  if (typeof (globalThis as any).CSSStyleSheet === 'undefined') {
    (globalThis as any).CSSStyleSheet = class {
      replaceSync() {}
    };
  }

  return {
    document: doc,
    teardown() {
      (globalThis as any).document = originalDoc;
      (globalThis as any).requestAnimationFrame = originalRaf;
      (globalThis as any).MutationObserver = originalMutationObserver;
      (globalThis as any).CSSStyleSheet = originalCssStyleSheet;
    },
  };
}

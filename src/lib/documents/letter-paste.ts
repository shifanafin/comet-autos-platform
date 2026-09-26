/*
 * Cleans formatted text pasted into a letter (from Word, Google Docs or a web
 * page) down to what the letter's own toolbar can make: bold, italic,
 * underline, headings, lists, paragraphs and line breaks.
 *
 * Every attribute, class and style is dropped, and so is anything that isn't
 * text — scripts, images, links, tables' borders, fonts and colours. The
 * source is parsed with DOMParser, which never runs scripts or loads images.
 *
 * Browser only: it uses DOMParser and the document.
 */

/** Tags kept, and what each becomes in the letter. */
const KEEP: Record<string, string> = {
  B: 'strong',
  STRONG: 'strong',
  I: 'em',
  EM: 'em',
  U: 'u',
  P: 'p',
  DIV: 'div',
  BR: 'br',
  UL: 'ul',
  OL: 'ol',
  LI: 'li',
  H1: 'h3',
  H2: 'h3',
  H3: 'h3',
  H4: 'h4',
  H5: 'h4',
  H6: 'h4',
};

/** Elements dropped together with everything inside them. */
const DROP = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'IMG',
  'SVG',
  'MATH',
]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * The tags an element becomes: its own kept tag, plus bold, italic or
 * underline set through its style — which is how Google Docs and many web
 * pages mark them.
 */
function tagsFor(element: Element): string[] {
  const style = element instanceof HTMLElement ? element.style : null;
  const weight = style?.fontWeight ?? '';
  const bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  // Google Docs wraps a whole paste in <b style="font-weight:normal">.
  const notBold = weight === 'normal' || (weight !== '' && Number(weight) < 600);

  const tags: string[] = [];
  const own = KEEP[element.tagName];
  if (own && !(own === 'strong' && notBold)) tags.push(own);
  if (bold && own !== 'strong') tags.push('strong');
  if (style?.fontStyle === 'italic' && own !== 'em') tags.push('em');
  if (style?.textDecorationLine.includes('underline') && own !== 'u') tags.push('u');
  return tags;
}

function copyChildren(from: Node, into: Node, target: Document) {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      into.appendChild(target.createTextNode(child.textContent ?? ''));
      continue;
    }
    // Comments (Word's conditional ones included) and anything else go.
    if (child.nodeType !== ELEMENT_NODE) continue;
    const element = child as Element;
    if (DROP.has(element.tagName)) continue;

    let parent: Node = into;
    for (const tag of tagsFor(element)) parent = parent.appendChild(target.createElement(tag));
    copyChildren(element, parent, target);
  }
}

export function cleanPastedHtml(html: string): string {
  const source = new DOMParser().parseFromString(html, 'text/html');
  const target = document.implementation.createHTMLDocument('');
  copyChildren(source.body, target.body, target);
  return target.body.innerHTML;
}

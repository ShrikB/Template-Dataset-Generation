// Small DOM + display-text helpers shared by the ui/ panels and dialogs.

/** Create an element with an optional class name and text content. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** 'scatter region' -> 'Scatter Region'. */
export function titleCase(text) {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** An entity type's label for a count of `n` - 'person' / 'people'. */
export function countLabel(type, n) {
  return n === 1 ? type.label : type.plural;
}

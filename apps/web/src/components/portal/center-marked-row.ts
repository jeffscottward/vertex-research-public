/**
 * Scrolls `box` so the first element that matches `selector` sits in its middle, without moving
 * the page (the strike tables of the options analytics panel centre their spot row this way).
 */
export const centerMarkedRow = (
  box: HTMLElement | null,
  selector: string
): void => {
  const row = box?.querySelector<HTMLElement>(selector);
  if (box && row)
    box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2);
};

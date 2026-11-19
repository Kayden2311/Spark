/**
 * Where focus should go when a dialog opened from a menu closes. The menu item that opened it is already gone
 * by then, so the menu leaves its trigger button here for the dialog to pick up.
 */
let target: HTMLElement | null = null;

export function rememberFocus(element: HTMLElement | null): void {
  target = element;
}

export function takeFocusTarget(): HTMLElement | null {
  const taken = target;
  target = null;
  return taken;
}

// What: turns a DOM click or submit target into a redacted click-log descriptor (card
// vertex-click-log). It reads only labels (data-click-label, aria-label, aria-labelledby, label
// elements, visible button and link text, title, data-testid). It never reads `value`; text fields,
// text areas, selects and editable regions are never recorded; inside a `data-click-private`
// container (user-entered text on screen) only data-click-label is read.
// Used by: ./install.ts. See: docs/vertex-rebuild/click-log.md.
import {
  CLICK_LOG_ROLES,
  type ClickLogEventInput,
  redactClickRoute,
  redactClickText,
} from "@darkfactory/api";

export type ClickDescriptor = Omit<ClickLogEventInput, "at" | "requestIds">;
type ClickRole = ClickLogEventInput["role"];
type PageLocation = Readonly<{ origin: string; pathname: string }>;

const INTERACTIVE = [
  "a[href]",
  "button",
  "summary",
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="reset"]',
  ...[
    "button",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "option",
    "checkbox",
    "radio",
    "switch",
  ].map((role) => `[role="${role}"]`),
].join(", ");

// Text entry never reaches the log, not even as a click.
const TEXT_ENTRY = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"])',
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
].join(", ");

/** Labels of actions that change state; their events carry the request ids they caused. */
const IMPORTANT_LABELS: readonly RegExp[] = [
  /^stop\b/iu,
  /^send\b/iu,
  /\border\b/iu,
  /^(?:arm|disarm)\b/iu,
  /^(?:approve|reject)\b/iu,
  /^confirm\b/iu,
  /^cancel\b/iu,
  /^pause\b/iu,
  /^submit\b/iu,
  /^(?:buy|sell)\b/iu,
  /liquidat/iu,
];

export const isImportantLabel = (label: string): boolean =>
  IMPORTANT_LABELS.some((pattern) => pattern.test(label));

const isClickRole = (value: string): value is ClickRole =>
  (CLICK_LOG_ROLES as readonly string[]).includes(value);

const roleOf = (element: Element): ClickRole => {
  const role = (element.getAttribute("role") ?? "").replace(
    /^menuitem(?:checkbox|radio)$/u,
    "menuitem"
  );
  if (isClickRole(role)) return role;
  if (element instanceof HTMLAnchorElement) return "link";
  if (element.tagName === "SUMMARY") return "summary";
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") return "checkbox";
    if (element.type === "radio") return "radio";
  }
  return "button";
};

const textOf = (element: Element | null | undefined): string =>
  element?.textContent ?? "";

// Elements that show user-entered text (thread titles, to-do titles, basket names) sit inside a
// `data-click-private` container. There only a `data-click-label` the page author wrote is used.
const PRIVATE_LABEL = "[private]";

// Backstop for a missing data-click-private: visible text longer than a control label (a thread
// title, a note, a paper title) is never stored. Authored labels (data-click-label, aria-label)
// are not limited.
const LONG_TEXT_LABEL = "[text]";
const SHORT_LABEL_CHARACTERS = 40;
const SHORT_LABEL_WORDS = 5;
const isShortLabel = (text: string): boolean => {
  const words = text.trim().split(/\s+/u);
  return (
    words.join(" ").length <= SHORT_LABEL_CHARACTERS &&
    words.length <= SHORT_LABEL_WORDS
  );
};

const labelOf = (element: Element): string => {
  const authored = element.getAttribute("data-click-label");
  if (authored !== null) return authored;
  if (element.closest("[data-click-private]") !== null) return PRIVATE_LABEL;
  const aria = element.getAttribute("aria-label");
  if (aria !== null && aria.trim() !== "") return aria;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/u)
      .map((id) => textOf(element.ownerDocument.getElementById(id)))
      .join(" ");
    if (text.trim() !== "") return text;
  }
  const own =
    element instanceof HTMLInputElement
      ? textOf(element.labels?.[0])
      : textOf(element);
  if (own.trim() !== "") return isShortLabel(own) ? own : LONG_TEXT_LABEL;
  return element.getAttribute("title") ?? "";
};

const testIdOf = (element: Element): string | null => {
  const testId = element.getAttribute("data-testid");
  return testId === null ? null : redactClickText(testId);
};

const targetRouteOf = (element: Element, page: PageLocation): string | null => {
  if (!(element instanceof HTMLAnchorElement)) return null;
  const url = new URL(element.href, page.origin);
  // Other sites: origin only, so a query string or path secret never reaches the log.
  return url.origin === page.origin
    ? redactClickRoute(url.pathname)
    : url.origin;
};

/** The click-log descriptor for a click on `target`, or null when nothing should be recorded. */
export const describeClick = (
  target: EventTarget | null,
  page: PageLocation
): ClickDescriptor | null => {
  if (!(target instanceof Element)) return null;
  if (target.closest(TEXT_ENTRY) !== null) return null;
  const element = target.closest(INTERACTIVE);
  if (element === null) return null;
  const label = redactClickText(labelOf(element));
  return {
    important: isImportantLabel(label),
    kind: "click",
    label,
    role: roleOf(element),
    route: redactClickRoute(page.pathname),
    targetRoute: targetRouteOf(element, page),
    testId: testIdOf(element),
  };
};

/** The click-log descriptor for a form submit. Field values are never read. */
export const describeSubmit = (
  target: EventTarget | null,
  page: PageLocation
): ClickDescriptor | null => {
  if (!(target instanceof HTMLFormElement)) return null;
  const name =
    target.getAttribute("data-click-label") ??
    (target.closest("[data-click-private]") === null
      ? (target.getAttribute("aria-label") ??
        target.getAttribute("name") ??
        target.getAttribute("id") ??
        "form")
      : PRIVATE_LABEL);
  return {
    important: true,
    kind: "submit",
    label: redactClickText(name),
    role: "form",
    route: redactClickRoute(page.pathname),
    targetRoute: null,
    testId: testIdOf(target),
  };
};

// Size caps on every string the engine emits, so results always fit the chart, panel and
// storage consumers. Longer text is clipped (with a run warning), never rejected.

export const SCRIPT_TITLE_MAX = 80; // indicator()/strategy() title and shorttitle
export const SCRIPT_LABEL_MAX = 60; // plot, hline and input titles
export const SCRIPT_OPTION_MAX = 60; // each input options entry
export const SCRIPT_OPTIONS_MAX = 32; // entries per options list
export const SCRIPT_SIGNAL_TEXT_MAX = 24; // plotshape/strategy marker text
export const SCRIPT_INPUT_ID_MAX = 60; // input ids (variable names), override keys
export const SCRIPT_INPUT_STRING_MAX = 200; // string input default values
export const SCRIPT_INPUTS_MAX = 64; // inputs per script (a compile error beyond)
export const SCRIPT_STRING_MAX = 4096; // any string value while the script runs
export const SCRIPT_OPS_CEILING_FACTOR = 10; // options.maxOps <= factor * SCRIPT_OPS_DEFAULT

export const STRING_TOO_LONG = `String too long (max ${SCRIPT_STRING_MAX} characters)`;

// Clip to at most `max` UTF-16 units without splitting a surrogate pair.
export const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
};

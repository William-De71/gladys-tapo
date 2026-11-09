// -----------------------------------------------------------------------------
// A device name Gladys can derive a selector from.
//
// Gladys builds the internal selector of a device from its name (an integration
// cannot publish one: `setDiscoveredDevices` drops it), with a slugify that
// keeps only `a-z`, `0-9` and dashes after a short French accent table
// (server/utils/slugify.js). A name in Greek, Cyrillic, Chinese, or made of
// emoji slugifies to '' — and `buildUniqueSelector` (5.3.2) returns an empty
// base as is, without suffixing it. The first such device is created with the
// selector '', every next one fails with "409 selector must be unique —
// selector: " (issue #8). The name gets an ASCII tail then, so the selector has
// a base the core knows how to make unique (`t310`, `t310-2`…).
// -----------------------------------------------------------------------------

// The table of the core's slugify, character for character.
const ACCENTS_FROM = 'àáäâèéëêìíïîòóöôùúüûñç';
const ACCENTS_TO = 'aaaaeeeeiiiioooouuuunc';

/**
 * Whether the core's slugify keeps anything of a name.
 * @param {string} name - The device name.
 * @returns {boolean} True when the selector derived from it is not empty.
 * @example
 * hasSelectorBase('Salon'); // true
 * hasSelectorBase('Σαλόνι'); // false
 */
export function hasSelectorBase(name) {
  const lower = String(name || '').toLowerCase();
  let mapped = '';
  for (const char of lower) {
    const index = ACCENTS_FROM.indexOf(char);
    mapped += index === -1 ? char : ACCENTS_TO[index];
  }
  return /[a-z0-9]/.test(mapped);
}

/**
 * The name to publish for a device, with an ASCII tail when Gladys could not
 * derive a selector from it.
 * @param {string} name - The device name.
 * @param {string} [model] - The device model, the preferred tail.
 * @returns {string} The name, unchanged when it already slugifies.
 * @example
 * selectableName('Σαλόνι', 'T310'); // 'Σαλόνι (T310)'
 */
export function selectableName(name, model) {
  if (hasSelectorBase(name)) {
    return name;
  }
  const tail = hasSelectorBase(model) ? String(model).trim() : 'Tapo';
  const text = String(name || '').trim();
  return text ? `${text} (${tail})` : tail;
}

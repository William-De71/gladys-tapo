# Three bugs found while building an external integration

Found while building an external integration (Tapo cameras) against the external
integration branch (`0beb925c`). All three are reproducible against the current
code, and all three have a concrete impact: two make manifest action forms
unusable, the third silently caps camera images below their documented size.

---

## Bug 1 — a `select` with `source: "devices"` is always rejected

### Symptom

Any action carrying a `select` field fed by the dynamic `devices` source fails
with a truncated error message:

```
config.camera: must be one of
```

The list after "must be one of" is empty, and no value is ever accepted.

### Cause

`server/lib/external-integration/externalIntegration.validateConfigValue.js`:

```js
case 'select': {
  const validValues = (field.options || []).map((option) => option.value);
  if (!validValues.includes(value)) {
    throw new Error422(`config.${key}: must be one of ${validValues.join(', ')}`);
  }
  break;
}
```

The value is validated against `field.options`. But a field using `source` has
**no** `options` — the manifest validator explicitly forbids declaring both:

```js
// externalIntegration.validateManifest.js
if (field.options !== undefined) {
  errors.push(`${path}.options: mutually exclusive with source`);
}
```

The front fills the options at render time (`config-page/index.js`, from
`GET /api/v1/service/:selector/device`), so the server never has them.
`validValues` is therefore always `[]`, and every value fails.

The manifest schema allows `source: "devices"` on a `select`
(`SELECT_SOURCES = ['devices']`), so a manifest that passes validation cannot be
used — the two rules contradict each other.

### Suggested fix

Skip the option check when the field has a dynamic source, since the valid
values are unknown server side by design:

```js
case 'select': {
  if (field.source !== undefined) {
    // dynamic options (e.g. "devices"): resolved by the front at render time,
    // the server has no list to check against
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error422(`config.${key}: must be a non-empty string`);
    }
    break;
  }
  const validValues = (field.options || []).map((option) => option.value);
  ...
}
```

Verified: this accepts a dynamic select, still rejects an empty value, and
leaves static selects fully validated. `multi_select` has the identical problem
and needs the same treatment.

### Reproducer

```js
const { validateConfigValue } = require('./externalIntegration.validateConfigValue');
const field = { key: 'camera', type: 'select', source: 'devices', label: { en: 'Camera' } };
validateConfigValue(field, 'ext:ext-dev-tapo:camera:ID1');
// Error422: config.camera: must be one of
```

---

## Bug 2 — a `secret` field in an action form cannot be typed into

### Symptom

In an action mini-form, a `secret` field stays empty: typed characters never
appear and the submitted value is empty. The same field type works correctly in
the main configuration form.

### Cause

`front/src/routes/integration/all/external-integration/config-page/ConfigSchemaForm.jsx`
renders a secret as:

```jsx
value={touchedSecrets[field.key] ? value : ''}
```

The field only shows its value once its key is marked in `touchedSecrets`. That
map is owned by the configuration page, which sets it on input — but
`ActionsCard.jsx` passes a frozen empty object:

```jsx
configuredSecrets={[]}
touchedSecrets={{}}
```

The condition is therefore always false, and the input is forced back to `''` on
every render.

### Suggested fix

Track touched secrets per action, the way the configuration form already does:
keep an `actionTouchedSecrets[action.key]` map next to the existing
`actionFieldValues[action.key]`, and set the key inside the
`updateActionFieldValue` handler.

A secret in an action form has no "already configured" state to represent (the
value is transient, never stored), so `configuredSecrets={[]}` is correct — only
`touchedSecrets` needs wiring.

---

## Bug 3 — camera images are capped at 100 KB, not the documented 150 KB

### Symptom

Publishing a camera image through `publishCameraImage` fails with:

```
PayloadTooLargeError: request entity too large
```

for images well under the documented limit. It is intermittent: it depends on
how well each frame happens to compress.

### Cause

The host API documents — and enforces — a 150 KB bound:

```js
// server/lib/external-integration/constants.js
// mirror of the core bound (camera.setImage MAX_SIZE_IMAGE)
const MAX_CAMERA_IMAGE_SIZE = 150 * 1024;
```

But the HTTP layer never lets a body that large through:

```js
// server/api/index.js
app.use(express.json());
```

`express.json()` defaults to a **100 KB** limit, so any larger request is
rejected by the body parser before reaching the controller. The application
check on `MAX_CAMERA_IMAGE_SIZE` is unreachable, and an integration that follows
the documented 150 KB budget fails whenever a frame encodes above ~75 KB of raw
JPEG (base64 inflates it by ~4/3).

### Suggested fix

Raise the parser limit so it clears the documented application bound:

```js
app.use(express.json({ limit: '1mb' }));
```

or mount a larger limit on the camera image route only. Either way the two
bounds should agree — today the documented one cannot be reached.

### Workaround used here

`IMAGE_MAX_BYTES` is set to 96 KB instead of 150 KB, and the capture lowers the
JPEG quality until the payload fits. This costs image quality for no reason
other than the mismatch.

---

## Impact

Bugs 1 and 2 together make action mini-forms unusable for the case they appear
designed for: asking the user for a credential tied to one device. The
workaround in the Tapo integration is to declare all three fields as `string` —
so the camera is typed by name instead of picked from a list, and its password
is displayed in clear while being typed.

Bug 3 affects every external integration publishing camera images.

## Environment

- Branch: external integrations, commit `0beb925c`
- SDK: `@gladysassistant/integration-sdk` 0.9.0
- Integration: `gladys-tapo` (device type, action `set_camera_account`)

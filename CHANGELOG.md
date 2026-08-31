## [1.2.3](https://github.com/William-De71/gladys-tapo/compare/v1.2.2...v1.2.3) (2026-08-31)

### Bug Fixes

* **tapo:** keep battery cameras off the ONVIF pull point ([d16baf3](https://github.com/William-De71/gladys-tapo/commit/d16baf34f3c79c418a499850a2d3ecaf218b8635))

## [1.2.2](https://github.com/William-De71/gladys-tapo/compare/v1.2.1...v1.2.2) (2026-08-30)

### Bug Fixes

* **tapo:** stop the poll from draining solar cameras, and reject phantom 0% readings ([e9be7d1](https://github.com/William-De71/gladys-tapo/commit/e9be7d1ed5d3bf06bd4b7c3ffd42e1bb09f6b2e0))

## [1.2.1](https://github.com/William-De71/gladys-tapo/compare/v1.2.0...v1.2.1) (2026-08-20)

### Continuous Integration

* generate the changelog automatically on every release ([3371b84](https://github.com/William-De71/gladys-tapo/commit/3371b84897d55a6970172b09eaa7f90303421687))

### Miscellaneous

* restore the manifest formatting broken by jq ([55f43f0](https://github.com/William-De71/gladys-tapo/commit/55f43f015589907ad575ba8d07993223206a5172))

## [1.2.0](https://github.com/William-De71/gladys-tapo/compare/v1.1.0...v1.2.0) (2026-08-20)

### Bug Fixes

* **tapo:** repair the motion detection chain, and stop draining solar cameras ([#4](https://github.com/William-De71/gladys-tapo/issues/4)) ([447137c](https://github.com/William-De71/gladys-tapo/commit/447137c2996ea5a774fd071f937d76d51259c08c))

## [1.1.0](https://github.com/William-De71/gladys-tapo/compare/v1.0.1...v1.1.0) (2026-08-14)

### Features

* **tapo:** aim motorized cameras over ONVIF PTZ ([#3](https://github.com/William-De71/gladys-tapo/issues/3)) ([105bbed](https://github.com/William-De71/gladys-tapo/commit/105bbed41058bcb969d98905689aa9b3ef115687))
* **tapo:** expose the privacy mode as a switch ([#2](https://github.com/William-De71/gladys-tapo/issues/2)) ([dc6850b](https://github.com/William-De71/gladys-tapo/commit/dc6850b5d659b3b2eaacf254e6f89fcdfe3ccf8a))
* **tapo:** push motion over ONVIF instead of polling for it ([d257c37](https://github.com/William-De71/gladys-tapo/commit/d257c37832dae67c90adefbbe805750a395c7046))

## [1.0.1](https://github.com/William-De71/gladys-tapo/compare/v1.0.0...v1.0.1) (2026-08-02)

### Bug Fixes

* **tapo:** stop the poll from draining battery cameras, split their interval ([aa21e69](https://github.com/William-De71/gladys-tapo/commit/aa21e6966caf6da114c5595a4b6851dfb0fb75a6))

## [1.0.0](https://github.com/William-De71/gladys-tapo/compare/68c6ae4aeedfa9031f18c51eaa334345e4e2fa85...v1.0.0) (2026-07-31)

### Features

* **tapo:** add Tapo cameras and doorbells as an external integration ([68c6ae4](https://github.com/William-De71/gladys-tapo/commit/68c6ae4aeedfa9031f18c51eaa334345e4e2fa85))
* **tapo:** read battery and events locally, protect the battery, fix capture ([13bcdd8](https://github.com/William-De71/gladys-tapo/commit/13bcdd8f43d18e22a0e6bbe35b0c623a50a79b40))

### Documentation

* **tapo:** document what battery cameras can and cannot do ([048ec0a](https://github.com/William-De71/gladys-tapo/commit/048ec0ad04a5bbdda32eb98959e9e1010c51f265))

# Implementation plan — v0 Stackport live status → MQTT

Status: **v0 implemented and CI verified, but not live-deployed or smoke-tested against the production endpoints**. The architecture and topic contract are in [docs/v0-design.md](docs/v0-design.md), with Stackport setup in [docs/deployment.md](docs/deployment.md).

Do **not** call the bridge deployable until all acceptance tests and the real VPS integration gate pass. No backwards compatibility to a previous bridge implementation is required; this is a new service.

## Phase 0 — Runtime and transport spike

- [x] Initialize Bun/TypeScript project with strict TypeScript, exact package versions, committed `bun.lock`, and a non-root production image with frozen production dependencies.
- [x] Verify **Bun native WebSocket** sends `Authorization` to a local `/status/ws` test server without an `Origin` header or outgoing application frames (`tests/stackport-client.test.ts`).
- [ ] Verify MQTT.js runs correctly in the selected Bun version: TLS custom CA, `servername`, username/password, QoS1 `publish` callback / PUBACK, Last Will, retained messages, connection timeout, broker restart, offline buffer behavior.
- [ ] Record compatibility/soak results. If MQTT.js/Bun interop is unreliable, use **Node LTS + ws + MQTT.js**; do not disable TLS verification.
- [x] Fail fast on missing/invalid configuration, verify bundled CA and HTTPS/MQTTS scheme, and avoid logging secret values.

**Exit:** one reliable WebSocket receive path and one MQTTS publish path, verified independently.

## Phase 1 — Source protocol

- [x] Implement `src/config.ts`: env validation, safe instance/topic name, root CA reading, secure URL rules.
- [x] Implement `src/stackport.ts` and `src/protocol.ts`: auth header, hello/snapshot/update/heartbeat parser, v1/seq validation, frame/depth limits, silence watchdog, reconnect backoff/jitter.
- [x] Implement `src/bridge.ts`: authoritative four-section in-memory latest snapshot, section replacement (no patches), independent source freshness/availability.
- [x] On reconnect, require a fresh full snapshot, reject premature updates and different instance/scope, avoid fabricated empty sections before snapshot.
- [ ] Tests: schema, authentication denial, instance mismatch, sequence gaps, version mismatch, source stale, disconnect/reconnect and source unavailable.

**Exit:** cleanly maintains a bounded in-memory representation of current Stackport state.

## Phase 2 — MQTT state sink

- [x] Implement the MQTT.js transport in `src/index.ts`: MQTTS/CA/SNI, service credentials, stable client ID, keepalive, QoS1 retained Last Will.
- [x] Implement five active MQTT topics plus two legacy retained tombstones in `src/bridge.ts`, no subscribe and no per-project retained topics.
- [x] Implement `src/bridge.ts`: serialize/coalesce per-section state, track QoS1 ACKs, keep bounded latest state while offline, and replay after reconnect/snapshot.
- [x] Publish source availability (`connecting/online/stale/offline`); never manufacture project `down` on source failure.
- [x] Reject unexpected `SP_INSTANCE` on hello; deployment documents **one live bridge writer** per prefix (not broker-enforced).
- [ ] Tests: full snapshot, single-section update, unchanged value, empty arrays, MQTT reconnect/full resync, LWT, QoS1 backpressure, order and duplicate events.

**Exit:** consumers subscribing to retained topics reconstruct the latest complete state after arbitrary reconnects.

## Phase 3 — Deployment and hardening

- [x] Provide `docker-compose.stackport.yml` and Dockerfile: standalone non-root managed container, no ingress, read-only filesystem, no Docker socket, dropped capabilities, private `.env`.
- [ ] Verify **external `wss://sp.mattediworks.com/status/ws`** from the actual bridge container, validating public TLS and header-only `status` authorization through the real Nginx route. No loopback/plaintext fallback in v0.
- [ ] Verify **external `mqtts://mqtt.mattediworks.com:8883`** from the actual bridge container, validating the NM Root CA, certificate chain and SAN/SNI `mqtt.mattediworks.com`.
- [ ] Create a dedicated `stackport-bridge` broker user and publish-only Dynamic Security ACL; show denied out-of-scope publish attempts.
- [ ] Validate offline/online/stale transitions during independent Stackport, bridge and broker restarts, including retained topic convergence.
- [ ] Confirm that no token, password, header, private key, source payload or privileged URL is written to logs.
- [ ] Record real-VPS external-route integration evidence; retain internal-only network work under [ENG-66](https://linear.app/mattediworks/issue/ENG-66/p1-validate-secure-internal-route-for-stackport-live-ws-mqtt-bridge).
- [ ] Confirm the source group-scoping defect in [ENG-65](https://linear.app/mattediworks/issue/ENG-65/p1-reconcile-scoped-live-status-sections-when-a-project-changes-groups) is fixed before offering group-restricted bridge subscriptions.

**Exit:** deployable v0, verified against real Stackport and Stackport-Mqtt, no unproven Internet-free assumptions.

## Deliberately excluded from v0

- Outbound control / RPC; HTTP admin API; database; notification history and exactly-once event processing.
- Per-project retained topics and tombstone manifests.
- Automatic token creation or MQTT broker administration; those remain controlled by Stackport and Stackport-Mqtt.
- Integration with MW Notification (independent lifecycle).

## Deployment release gates

- The v0 placement is already chosen: **ordinary Stackport-managed outbound-only container with external WSS/MQTTS**. Confirm the real VPS public hostname/hairpin route works, rather than reopening topology selection.
- Confirm v0 `all`-scope, four-section retained state topics, and omission of event history.
- Confirm MQTT subscriber clients are provisioned separately and use unified `status`, and that the two old availability topics are no longer retained after deployment.

# Stackport WSS → MQTT Bridge

A small, **receive-only Stackport live-status → MQTT state bridge**.

**Stage:** v0 implementation available in the feature branch. Automated tests and Docker build must pass; **production WSS and MQTTS connections have not been tested with your private credentials**.

## Purpose

Keep Stackport's current operational state available to MQTT clients through the existing [Stackport-Mqtt](https://github.com/vtmattedi/Stackport-mqtt) broker. The source is [Stackport's live-status WebSocket](https://github.com/vtmattedi/Stackport/blob/main/docs/1.3.11/live-status.md) (`/status/ws`, introduced in Stackport PR #41), **not** its privileged Socket.IO API.

- Host metrics, project states, running actions and currently active alerts.
- On connection, publish a complete snapshot.
- Afterwards, republish only a changed **section**.
- Retain the most recent state in MQTT for clients connecting later.
- When Stackport becomes unreachable or stale, publish source availability separately; **do not turn every project into “down.”**

## Proposed v0 stack

- **Bun + TypeScript**, using the **Bun native WebSocket client** with an Authorization header to `wss://sp.mattediworks.com/status/ws`.
- **MQTT.js** over authenticated **`mqtts://mqtt.mattediworks.com:8883`**. No separate broker, HTTP server, Socket.IO client, database, or incoming port.
- Two upstream service credentials, configured in a private `.env`: `SP_STATUS_TOKEN` (Stackport `status` scope) and `MQTT_USERNAME`/`MQTT_PASSWORD` (dedicated Mosquitto Dynamic Security client).
- TLS verification for MQTT against [`certs/nm-root-ca.crt`](certs/nm-root-ca.crt). **Never use `rejectUnauthorized: false`.** The supplied NM Root CA is public trust material, **not** an application secret; its fingerprint is recorded in the deployment guide.
- MQTT QoS 1 and retained publications; a unified `status` topic with broker Last Will.
- **No subscriptions** and **no per-project retained topics** in v0: each section is one retained JSON topic. This avoids stale per-project topics and the need for a durable deleted-ID registry.

## MQTT topics

Given a fixed `SP_INSTANCE=sp-...` (from Stackport's Settings → Live status):

| Topic | Retained payload |
| --- | --- |
| `stackport/<instance>/status` | JSON health: `connecting`, `online`, `stale`, or `offline`; LWT marks bridge disconnection |
| `stackport/<instance>/state/host` | Entire Stackport `host` section (object or JSON `null`) |
| `stackport/<instance>/state/projects` | Entire `projects` array, retaining Stackport's stable integer project `id` |
| `stackport/<instance>/state/actions` | Entire `actions` array |
| `stackport/<instance>/state/alerts` | Entire `alerts` array (conditions, **not** notification history) |

The retained `status` payload has `state`, `reason`, `observedAt` (health transition timestamp), and `snapshotAt` (timestamp of the last complete Stackport snapshot). A broker Last Will or graceful exit writes `{"state":"offline","reason":"bridge_disconnected"}`. Source failure writes `{"state":"offline","reason":"socket_closed"}` (or another bounded source failure reason). Heartbeats do not republish status solely to update timestamps. Treat section values as **last-known** unless `status.state === "online"`.

**Breaking change:** migrate MQTT subscribers to `status` before upgrading. On **every** MQTT connection, the bridge deletes the old retained `bridge/availability` and `source/availability` with QoS 1 zero-byte messages. Do not run old and new bridges for the same instance simultaneously.

All JSON is UTF-8. State messages are published with `qos: 1`, `retain: true`. An empty array is **`[]`**, not an MQTT retained-message deletion. MQTT clients may receive duplicates: process state idempotently.

## Deploy the runnable v0 in Stackport

1. Create a **new Stackport managed project** using this repository. Set **Compose file** to `docker-compose.stackport.yml`. Do not add an HTTP domain, TCP exposure or published port.
2. Use **Project → Env** to create the project's **root `.env`** from [`.env.example`](.env.example). Provide `SP_INSTANCE` (Stackport Settings → Live status), `SP_STATUS_TOKEN` (dedicated **status-only, unscoped** key), and a dedicated `MQTT_USERNAME`/`MQTT_PASSWORD` with publish-only ACL.
3. Confirm the fixed external URLs `wss://sp.mattediworks.com/status/ws` and `mqtts://mqtt.mattediworks.com:8883`. The **public** NM Root CA is baked into the image at `./certs/nm-root-ca.crt` (never put the private CA key into Stackport).
4. Run **Compose up/redeploy**. The single bridge container has no inbound ports. In its logs look for `bridge.started`, `mqtt.connected`, `stackport.connected`, and `snapshot.synchronized` (after all retained QoS1 publishes complete).
5. With a separately authorized **read-only MQTT client**, subscribe to `stackport/<SP_INSTANCE>/#`. Verify the unified `status` topic, four complete sections, and the absence of retained legacy availability topics. Restart Stackport and the broker separately to test recovery.

**Do not use the MQTT broker's `mqtt-admin` or broad `nmnw` login.** Create a dedicated Dynamic Security role with only `publishClientSend` permissions under the bridge prefix. The bridge does not need subscriptions.

For development and CI:

```sh
bun ci
bun run typecheck
bun test
bun run build
docker compose -f docker-compose.stackport.yml config
docker build -t stackport-wss-mqtt-bridge:v0 .
```

All credentials are supplied privately at runtime. Missing/unsafe settings cause immediate startup failure. **No network integration check against the real Stackport or Mosquitto endpoints can succeed until those private credentials and the matching broker ACL are provisioned.**

## Troubleshooting WSS validation

If logs repeatedly show `stackport.connected` followed immediately by
`stackport.reconnecting` with `reason: bad_protocol`, inspect the new
`stackport.protocol_rejected` event. It reports only a validation **phase**
and fixed **code**. Most importantly, check that `SP_INSTANCE` exactly matches
the instance ID shown in **Stackport → Settings → Live status** and that the
`SP_STATUS_TOKEN` is **status-only, unscoped (`all`)**.

See [the WSS troubleshooting guide](docs/troubleshooting.md) for the codes and
safe recovery steps. Do not paste private credentials or full status frames.

## Files

- [`docs/v0-design.md`](docs/v0-design.md) — contract, algorithm, failure semantics, tests, rollout.
- [`docs/deployment.md`](docs/deployment.md) — selected external WSS/MQTTS topology, broker ACL, CA verification and env setup.
- [`certs/nm-root-ca.crt`](certs/nm-root-ca.crt) — public broker CA supplied for this deployment.
- [`.env.example`](.env.example) — example configuration, **no credentials**.
- [`docker-compose.stackport.yml`](docker-compose.stackport.yml) and [`Dockerfile`](Dockerfile) — runnable managed container.
- [`src/`](src/) and [`tests/`](tests/) — bridge runtime and automated tests.

## Key dependencies / limits

1. Enable **Settings → Live status** in Stackport and create a **status-only** token (not a session or MCP read/write token).
2. Provision a dedicated **publish-only** client in Stackport-Mqtt's Dynamic Security ACL for `stackport/<instance>/#`. No `mqtt-admin` or broad `nmnw` role.
3. **v0 uses the external `wss://sp.mattediworks.com/status/ws` only**, with normal public TLS certificate validation. Never use cleartext `ws://stackport:3000`, relax Stackport's transport checks, or depend on host networking for v0.
4. **v0 uses external `mqtts://mqtt.mattediworks.com:8883`**, validating the broker certificate against the committed NM Root CA and the hostname `mqtt.mattediworks.com`.
5. v0 needs outbound DNS and TLS connectivity to the public endpoints, but exposes **no inbound ports**. Existing [Linear ENG-65](https://linear.app/mattediworks/issue/ENG-65/p1-reconcile-scoped-live-status-sections-when-a-project-changes-groups) and [ENG-66](https://linear.app/mattediworks/issue/ENG-66/p1-validate-secure-internal-route-for-stackport-live-ws-mqtt-bridge) track scoped stream correctness and secure deployment topology.

**Out of scope for v0:** per-project topics, event history/replay, remote control, MQTT subscriptions, per-user configuration, UI, and general-purpose notification dispatch.

# Deployment design — Stackport and Stackport-Mqtt on one VPS

**Design, not deployment instructions for a finished executable.** The repository does not contain the v0 bridge implementation yet. These steps define what its installer and integration test must satisfy.

## Dependencies already available

1. Stackport **v1.3.11 or later** (PR [#41](https://github.com/vtmattedi/Stackport/pull/41) merged) exposes a **receive-only raw WebSocket** at `/status/ws`.
2. [Stackport-Mqtt](https://github.com/vtmattedi/Stackport-mqtt) runs Mosquitto 2.x on TLS-only `8883` (Stackport-managed TCP exposure) and a separate browser WebSocket listener on `9001`. **Use 8883, not 9001.**
3. A verified NM Root CA certificate is committed at [`certs/nm-root-ca.crt`](../certs/nm-root-ca.crt).

## Credentials and broker ACL

### Stackport

In **Settings → Live status**:

- Enable the stream.
- Copy its stable **instance ID** (e.g. `sp-...`) into `SP_INSTANCE`.
- Create a new token with **status** scope and access to all projects (`SP_EXPECTED_SCOPE=all`). Keep it only in `SP_STATUS_TOKEN`.
- Do not use an admin browser session, an MCP read/write token or a token in the WebSocket URL.
- Rotate/revoke the token independently if this bridge is compromised; active sockets are revalidated approximately every 30 seconds.

### Stackport-Mqtt

Use the broker's existing Mosquitto Dynamic Security controls to create a dedicated service client, e.g. `stackport-bridge`, with a unique **24+ character** password.

- Create a dedicated role, e.g. `sp-bridge-publisher`.
- The role grants **`publishClientSend` allow only on `stackport/<SP_INSTANCE>/#`**; no subscribe ACLs, no other topic prefixes, and no `$CONTROL` rights.
- Attach this role to only the bridge client.
- This is the same ACL model used in Stackport-Mqtt's [provision-client.sh](https://github.com/vtmattedi/Stackport-mqtt/blob/main/scripts/provision-client.sh) and [setup-roles.sh](https://github.com/vtmattedi/Stackport-mqtt/blob/main/scripts/setup-roles.sh), but **not** the broad `nmnw` role or the privileged `dynsec-admin` role.
- Separately provision dashboard/NMNW **read-only** subscribers if those clients need to consume `stackport/<SP_INSTANCE>/#`.
- Check retained delivery, QoS1 acknowledgments, offline Last Will publishing, and ACL rejection of an unrelated test topic.

Never put MQTT administrative tokens, the broker bootstrap password, or the private Root CA key into this bridge. Only a scoped publishing identity is required.

## Required v0 deployment route: externally secured WSS and MQTTS

The bridge is an **ordinary standalone Stackport-managed Docker project** with outbound connections only. V0 deliberately uses the two public HTTPS/TLS names, even if the broker and Stackport are on the same VPS:

```text
Bridge container (no listening ports, no Docker socket)
  ├── wss://sp.mattediworks.com/status/ws
  │     TLS: normal publicly trusted Stackport certificate
  │     Auth: Authorization: Bearer <status-only SP token>
  │
  └── mqtts://mqtt.mattediworks.com:8883
        TLS: NM Root CA + verify mqtt.mattediworks.com
        Auth: dedicated publish-only Mosquitto user
```

**Network requirements:** outbound DNS, TCP 443 to `sp.mattediworks.com`, TCP 8883 to `mqtt.mattediworks.com`. Do not add `ports:`, public domains, TCP exposures, host networking, or a privileged attachment to Stackport's management network. Validate the actual host/Docker DNS and public endpoint hairpin route during integration testing.

**This v0 does use external TLS endpoints.** It does *not* assume Internet-free operation, direct host-loopback access, or an internal plaintext Docker route. The internal-only design remains a possible later optimization tracked in [ENG-66](https://linear.app/mattediworks/issue/ENG-66/p1-validate-secure-internal-route-for-stackport-live-ws-mqtt-bridge). Ordinary `ws://stackport:3000/status/ws` from another container is rejected by Stackport's current transport policy; do not weaken that check.

Containers should run non-root, without Docker socket access or inbound ports; use a read-only filesystem, `no-new-privileges` and dropped capabilities as compatible with the chosen image. A single stable bridge instance writes the topic prefix, with `restart: unless-stopped` after implementation.

## Private environment

Copy [`.env.example`](../.env.example) to `.env` and fill secret fields. Do not commit it.

```dotenv
SP_INSTANCE=sp-replace-with-settings-instance
SP_EXPECTED_SCOPE=all
SP_WS_URL=wss://sp.mattediworks.com/status/ws
SP_STATUS_TOKEN=spk_<status-only-secret>

MQTT_URL=mqtts://mqtt.mattediworks.com:8883
MQTT_TLS_SERVERNAME=mqtt.mattediworks.com
MQTT_CA_FILE=./certs/nm-root-ca.crt
MQTT_CLIENT_ID=stackport-bridge-primary
MQTT_USERNAME=stackport-bridge
MQTT_PASSWORD=<dedicated-broker-password>
```

Inside the container, resolve `MQTT_CA_FILE` relative to its working directory (or use an absolute path). The root CA is public but must retain integrity; never auto-replace it with a certificate supplied by the server.

### Validate the broker trust chain

From the bridge runtime/network, once the TCP exposure is live:

```bash
openssl s_client -brief -connect mqtt.mattediworks.com:8883 \
  -servername mqtt.mattediworks.com \
  -verify_hostname mqtt.mattediworks.com \
  -CAfile certs/nm-root-ca.crt < /dev/null
```

The supplied root is self-signed and was parsed/verified locally:

- Subject/issuer: `O=NM, CN=NM Root CA`
- Validity: 2026-10-06 through 2036-10-03 UTC
- SHA-256: `9A:7B:A6:AD:5E:4C:15:F6:14:65:1C:30:B9:D9:35:78:7C:B7:00:81:24:2D:79:A3:5B:41:6C:BF:DD:6A:2D:DC`

**This only validates the provided CA certificate.** A real MQTTS connection and verification of the running broker's leaf/full chain remain required before deployment.

### Verify the Stackport stream

Use a non-browser WebSocket client capable of setting a custom `Authorization` header to **`wss://sp.mattediworks.com/status/ws`**. Check the `hello` frame (`v=1`, expected `instance`, `scope=all`) and the fresh `snapshot`. Verify the normal public HTTPS certificate chain; never disable WSS TLS verification.

A status token is only accepted after the endpoint has been enabled. Stackport returns 404 while it is disabled.

## Runbook (after implementation)

1. Back up both service credentials; do not commit private `.env`.
2. Enable the Stackport live status stream and create its status-only token.
3. Provision the dedicated Stackport-Mqtt publisher and narrow ACL.
4. Validate the WebSocket handshake, MQTT TLS certificate and broker ACL on the real VPS.
5. Start exactly one bridge instance. Wait for an initial `snapshot` and four successful retained section publishes.
6. Subscribe from a separately authorized MQTT consumer to `stackport/<instance>/#`; confirm `bridge/availability`, `source/availability`, and the four section topics.
7. Restart Stackport, the bridge, and Mosquitto separately. Confirm offline/stale status is truthful and current state is fully restored without clearing all projects.

**Release gate:** don't declare v0 operational merely because CI is green; verify the real network paths and broker CA chain (ENG-66).

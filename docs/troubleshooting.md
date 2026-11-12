# Stackport WebSocket: connected, then bad_protocol

The `stackport.connected` event means the HTTP WebSocket upgrade completed.
It **does not** mean the subsequent Stackport `hello` and `snapshot`
frames passed bridge validation.

Before the diagnostic patch, all rejected frames logged only
`stackport.reconnecting {"reason":"bad_protocol"}`; this includes
misconfiguration, invalid stream data, and unrelated processing exceptions.

## Upgrade and inspect the new diagnostic

Build/redeploy the version containing the protocol diagnostics fix. The bridge
now logs a **fixed error code** and the validation phase, without dumping raw
status payloads, tokens, URLs, or project names:

```json
{"event":"stackport.protocol_rejected","phase":"hello","code":"hello_instance_mismatch"}
```

The regular `stackport.reconnecting` event follows. If the hello is accepted
you'll instead see `stackport.hello_accepted` before any snapshot.

| Event/code | Meaning and action |
| --- | --- |
| `hello_instance_mismatch` | Copy the **exact instance ID** from Stackport → Settings → Live status into the project's private `.env` as `SP_INSTANCE`; recreate the container. Keep the previous topic prefix in mind if it had already published messages. |
| `hello_scope_not_all` | The token has a project-group restriction. V0 deliberately requires an unscoped, **status-only**, all-projects token while ENG-65 is unresolved. Create a new token and redeploy. |
| `hello_sections_invalid` / `unsupported_version` | Upstream wire contract changed. Compare with Stackport's current `src/modules/status/types.ts`; **don't disable validation**. |
| `snapshot_missing_section`, `invalid_host`, `invalid_projects`, `invalid_actions`, `invalid_alerts` | The full snapshot has an unexpected section/shape. Check server and bridge versions. Only a safe code is logged, not raw infrastructure state. |
| `sequence_invalid` / `snapshot_expected` | A full snapshot did not arrive in order. The bridge reconnects and requires a fresh snapshot. |
| `frame_too_large` / `frame_too_complex` | Upstream payload exceeds v0 limits. Assess actual resource requirements before raising limits. |
| `stackport.message_processing_failed` | An exception occurred **after a valid frame**, while updating the bridge. This is distinct from a malformed wire message and should be investigated as a bridge bug. |

## Do not change

- WSS remains `wss://sp.mattediworks.com/status/ws`.
- MQTT remains `mqtts://mqtt.mattediworks.com:8883` with the NM Root CA.
- Do not put `SP_STATUS_TOKEN` into a URL or application logs.
- Do not use a group-scoped status token until the scoped-stream consistency
  issue is resolved.

**If the error is still not identified, provide only the new error code and
phase.** There is no need to paste tokens, raw websocket frames, the private
`.env`, or MQTT credentials into an issue.

# Inbound limit for each non-owner sender

## Problem

Angelia drops messages from strangers at the gate. A sender who passes the gate and is not an owner has no limit:

- The sender can start turns without a limit. The chat queue holds 10 messages (`QUEUE_MAX`). When the queue empties, the sender can send 10 more. Each turn uses the subscription quota and server CPU.
- Some messages get a reply without a turn: `/help`, an owner-only command (`NOT_OWNER_LINE`), and a `yes <id>` from a non-owner (`NOT_OWNER_LINE`). A loop of these messages makes Angelia send many replies. Many replies can get the WhatsApp number banned.

## Goal

Limit the messages that each allowed non-owner sender can send to a profile in one hour. Owners have no limit.

## Out of scope

- Limits for owners.
- A total limit for a profile across all senders.
- Changes to the outbound limit (`max_out_per_min`).
- Strangers. The gate drops them already.

## Config

- `defaults.max_in_per_hour`: an integer, 0 or more. The default is 50.
- `profiles.<name>.max_in_per_hour`: optional. It replaces the default for that profile.
- The value 0 turns the limit off.

The limit counts each message from a non-owner that passes the gate: turns, commands, permission replies, bare yes/no answers, and `/sh`.

## Flow

In `Orchestrator.handle()`, directly after `gate()` returns `ok`, and before the permission reply check:

1. If the sender is an owner (`isOwner(i, route)`), continue as today.
2. Find the limit: the profile value, else the default. If it is 0, continue as today.
3. Call `take(key)` on the sender quota. The key is `<profile> <platform>:<sender>`.
4. If `take` returns false:
   1. Call `dropped(sessionKey, 'reason=sender-limit sender=<sender>')`. This function already merges repeated log lines.
   2. If the key is not in `limitTold`, add the key and send one line to the chat. The line is: "Too many messages. Wait up to one hour, then try again."
   3. Return. Angelia does not start a turn and does not send other replies.
5. If `take` returns true, remove the key from `limitTold` and continue as today.

Angelia sends one line for each block. The next block, after a message gets through again, sends one line again. This keeps replies to an attacker at a minimum.

## Components

- **Quota.** Make `SenderQuota` in `src/adapters/inbox.ts` take the limit for each call: `take(key, perHour)`. The file download quota keeps its current limit. The window stays one hour. The class already deletes keys with no timestamps in the window.
- **State in the orchestrator.** One `SenderQuota` for inbound messages, and one `limitTold: Set<string>`. Clear `limitTold` when it reaches 1000 keys, as the code does for `drops`.
- **Schema.** Add `max_in_per_hour` to `defaults` and to `Profile` in `src/instance/config/schema.ts`.
- **Docs.** Add the field to `docs/reference.md` and add one line in `docs/security.md`.

## Error handling

- If the reply line fails to send, log the error. The message stays dropped.
- After a daemon restart, all counts start again at zero. The quota is in memory only.

## Tests

1. A non-owner sends 51 messages. Message 51 gets the line. Messages 52 to 60 get no reply and start no turn.
2. An owner sends 60 messages. All of them pass.
3. After the window moves on (a fake clock), a message passes. The next block sends the line again.
4. A `yes <id>` and `/help` from a non-owner count toward the limit.
5. A profile value replaces the default. The value 0 turns the limit off.
6. Two profiles keep separate counts for the same sender.
7. The schema accepts the field in `defaults` and on a profile, and rejects a negative value.

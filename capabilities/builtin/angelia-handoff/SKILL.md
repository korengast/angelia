---
name: angelia-handoff
description: Move this terminal session to an Angelia chat (WhatsApp or Telegram) and go on there. Only when the user types /angelia-handoff.
disable-model-invocation: true
argument-hint: "[chat number]"
---

The user leaves the terminal and goes on with this work in an Angelia chat.

1. Run `angelia handoff --where $ARGUMENTS`. It prints the mode, the profile and the chat. If it
   fails (a list of chats to pick from, no profile for this folder, the daemon down), show its
   output as it is and stop.

2. Write what it asks for:
   - `mode: session`: one line, at most 200 characters, that says what this conversation is doing
     and where it stands. Plain text: someone reads it on a phone.
   - `mode: brief`: the same line, then a brief for an agent that has seen none of this
     conversation. Write it as you would for /compact, in these sections: Goal. Decisions made, and
     why. Current state (what works, what does not, and test results). Files touched. Next step.
     Open questions. Paths in full. Leave out nothing it needs to go on without asking.

3. Pipe it in, with the same arguments. Keep the quoted `EOF`, so nothing in the text is expanded:

   ```
   angelia handoff $ARGUMENTS <<'EOF'
   <summary line>
   <brief, for mode: brief only>
   EOF
   ```

4. Show the command's last line to the user as it is, and nothing else.

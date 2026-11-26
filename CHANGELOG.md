# Changelog

## Unreleased

- A failed API call (a lost login, a server error) is no longer posted as the agent's answer. The same turn runs once more after one minute. A login that is still lost gets one line that says what to do. `angelia health` counts these as `api errors`.

# Driver defaults

These record the intended defaults. This slice does not configure the host application or enforce them at runtime.

- Session files stay on for every worker. Do not start workers with `--no-session`.
- Use one Pi profile per bot. Do not share a coordinator or another bot's profile.
- Ordinary work is the default route. Use driver lifecycle jobs only when the request names one (P16).
- `.driver/envelope.json` is an example in this slice. Its paths, effects, and caps are not an active grant until an owner reviews them for an enforcing runtime.
- The envelope schema checks file shape; it is not an action guard.

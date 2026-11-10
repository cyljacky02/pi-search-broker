# Key files own their accounts; account ids come from key fingerprints

Users want to install the extension, paste API keys into one text file per provider and have them work, so each key file in `keys/` is the only source of its accounts. Keys are read from those files only when a local Gateway starts, and are never copied into `config.json`. Each account id is the file name plus the first 8 hex characters of the key's SHA-256 (`exa-promo-3f9a1c2e`), so it never depends on line order and is never reused: removing a key removes its account, while its saved spend stays keyed by that id and comes back if the key returns. Changing this id scheme later would detach all saved spend, which is why it is recorded.

## Considered options

- **Explicit import into `config.json` (shipped in 0.5.0, removed in 0.6.0).** It kept every account in one file, but it needed a CLI command with allocation flags on every import, kept a second plaintext copy of each key, and gave the user no way to "just edit the text file".
- **Reading key files on every inspection.** Rejected: status, `doctor` and clients joining a Port owner must never read secrets. Offline status uses the key-free `keys.index.json` the last Gateway wrote instead.
- **Sequential ids (`tavily-01`) for key-file accounts.** Rejected: removing a line would free a number that a new key could reuse, inheriting the old key's spend.

## Consequences

- Moving a key to another key file changes its id, so its spend starts again under the new id.
- An 8-hex fingerprint of each key appears in status output and logs. It identifies the key to someone who already has it, but cannot be turned back into the key.

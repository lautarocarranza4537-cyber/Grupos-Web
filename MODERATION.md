# Private moderation operations

The public UI accepts a bounded report form. Reports are not listed publicly. The private API is intentionally unavailable until the Render web service has a `MODERATION_TOKEN` environment variable containing at least 32 random characters. Never put this value in a checked-in file, client-side code, a URL, or a normal chat message. Configure it through the service's environment settings; this task did not change Render settings.

All actions use HTTPS and the request header `Authorization: Bearer <MODERATION_TOKEN>`. Keep the token in a protected local shell variable or secret manager; do not place the literal token in command history. The app currently has no browser admin page.

- `GET /api/moderation/reports` returns at most 100 oldest open reports, without group links or account identifiers.
- `PATCH /api/moderation/reports/:id` with JSON `{"action":"dismiss"}` closes a report without hiding its group.
- `PATCH /api/moderation/reports/:id` with JSON `{"action":"hide-group"}` hides that group's listing and closes the report.
- `PATCH /api/moderation/reports/:id` with JSON `{"action":"restore-group"}` restores that group's listing and closes the report.

The endpoint is disabled when the token is absent/too short and checks it in constant time. Do not expose this token in any web client. Use the report ID from the protected queue and review before taking action. Groups are not deleted by moderation actions. Existing groups default to visible after the additive schema migration.

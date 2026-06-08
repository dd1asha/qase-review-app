# Qase Review App

Local flow:

1. Paste requirements.
2. Click `Generate`.
3. Select a Qase suite or create a new one.
4. Review and edit test cases.
5. Click `Create in Qase`.

Before running, add your OpenAI key to `outputs/.env`:

```env
OPENAI_API_KEY=put_your_openai_key_here
OPENAI_MODEL=gpt-4o-mini
```

To load requirements from ClickUp tasks, also add:

```env
CLICKUP_API_TOKEN=put_your_clickup_personal_token_here
```

If you paste custom task IDs like `ABC-123`, add the ClickUp Workspace/team ID too:

```env
CLICKUP_TEAM_ID=123456
```

Run:

```powershell
cd C:\Users\d.domina\Documents\Codex\2026-06-02\new-chat
node .\outputs\qase_review_app.mjs
```

Open:

```text
http://localhost:8787
```

The app keeps API keys on the local Node server. The browser only calls local endpoints.

ClickUp agent flow:

1. Paste one ClickUp task URL/ID, or paste multiple task URLs/IDs one per line.
2. Click `Agent mode`.
3. Review generated cases.
4. Click `Create in Qase`.

Multiple ClickUp tasks:

- `Load` accepts up to 10 ClickUp task URLs/IDs at once.
- The app combines all loaded task descriptions into one requirements document before generation.
- If `Comment Qase links back to ClickUp` is enabled, the app comments the created Qase links back to every loaded task.

Suite controls:

- Use the suite dropdown to choose where cases are created.
- Use `AI Suite` to suggest a suite title from the requirement.
- Use `Parent suite for new suite` to choose where the new suite will be created. Leave it as `Top-level suite (no parent)` for a root suite, or pick an existing suite to create a suite inside it.
- Use `Create suite` to create that suite in Qase. The created suite is selected automatically for case creation.
- Enable `Agent creates suite from requirement before review` only when you want Agent mode to create a new suite automatically before generating cases.

Duplicate protection:

After cases are created, the app shows `Created`, locks the generated cases, and disables `Create in Qase` for that batch.
Before creating cases, the app checks the Qase project for existing cases with the same or similar titles. Duplicate checks run in the UI and again on the server before `/api/create`, so accidental duplicate creation is blocked unless `Create anyway` is used intentionally.
Use `Check duplicates` to run the same duplicate scan without creating anything. If duplicates are found, use `Skip duplicate` to remove flagged generated cases before creating the remaining cases.

Run history:

- Click `Run history` to open the history window.
- History is saved locally in the browser after successful Qase creation.
- Each run shows loaded ClickUp tasks and all created test cases with Qase links.
- Use `Generate more` inside a history run to add extra scenarios while keeping the previous ClickUp tasks and created test cases in context.

Generation rules:

- The generator must cover all functionality described in the ClickUp task or pasted requirements.
- It accounts for mentioned features, acceptance criteria, UI states, validation rules, permissions, integrations, API behavior, analytics events, and edge cases.
- The generator creates separate `[Positive]` and `[Negative]` cases for each feature or acceptance criterion.
- Negative cases must describe safe validation behavior, blocked state changes, and what the user can do next.
- A generation can return up to 25 test cases.

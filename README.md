# ChatGPT Web Harness

ChatGPT Web Harness is a durable workflow skill for long-running tasks in ChatGPT Web. It keeps workflow state in the workspace, issues one-use execution tokens, records evidence for acceptance criteria, and resumes interrupted work without relying on the chat history alone.

The skill uses a small `SKILL.md` as its entry point and deterministic Node.js scripts as the workflow runtime. Invalid transitions fail closed, completed work can be re-evaluated when validated knowledge changes, and every released final response includes a locally verifiable delivery receipt.

Before release, an offline audit derived from `MrGeDiao/shuorenhua` checks the final body for deterministic writing violations and discloses a semantic checklist. The response cannot enter the release state until both checks pass.

## Use with ChatGPT Web

1. In ChatGPT Web, select **New project** in the sidebar and create a project for your work.
2. [Download the latest skill ZIP from GitHub](https://github.com/JesseSenior/chatgpt-web-harness/archive/refs/heads/master.zip).
3. Add the downloaded ZIP to the project's sources.
4. Open **Project settings** and set the project instructions to:

```text
Always follow the chatgpt-web-harness skill in the latest ZIP attached to this project. Treat its SKILL.md and bundled scripts as authoritative for every chat and task in this project. Start each new task with the workflow required by that skill. When my message contains skill-continue-or-finalize, follow the skill's recovery instructions before any other action.
```

5. Start a new chat inside the project and send your task.

---

If ChatGPT stops before the task is complete, send:

```text
skill-continue-or-finalize
```

Keep sending `skill-continue-or-finalize` whenever ChatGPT stops until it returns the correct final result.

To update the skill, remove the previous ZIP from the project sources and upload a newly downloaded copy before starting the next task.

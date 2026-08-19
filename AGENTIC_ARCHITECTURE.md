# StreamVerse Agentic Production Architecture

The autonomous production entrypoint is now `src/agentOrchestrator.js -> runProductionAgent()`.

## Ownership

- **Agent**: decides the next production action, calls tools, observes results, chooses recovery or pause, and advances the project.
- **Tools**: execute deterministic operations: DB reads/writes, series initialization, season simulation, episode simulation, script/shot generation, shot-row persistence, media generation, compilation, validation and publishing.
- **Database**: durable source of truth for storyline, episode, shot, checkpoint, event and recovery state.
- **Recovery/validators**: deterministic safety layer. They may block invalid transitions, invalid media, schema violations, or publication.
- **Legacy pipeline**: retained as an implementation library and compatibility surface, but the autonomous cron/manual/resume/bootstrap entrypoints invoke the agent.

## Autonomous production loop

The agent is guided by this sequence but is not hard-coded to blindly follow it:

`initialize_series -> simulate_season -> ensure_episode_draft -> simulate_episode_scenes -> write_episode_script -> prepare_shot_rows -> generate_episode_media -> compile_episode -> validate_episode -> publish_episode`

At every step it can inspect durable state and choose another tool.

## Database tool authority

The agent has general DB tools (`db_select_rows`, `db_update_fields`, `db_insert_row`) plus the existing schema, integrity, recovery and event-history tools. All dynamic table/column identifiers are validated against the authoritative `src/db.js` schema and all values are parameterized.

Arbitrary SQL is not exposed as an execution tool.

## Continuity rules

Locked season simulations, scene simulations and shot simulations remain authoritative. The agent is allowed to repair or continue from incomplete downstream work, but it is not allowed to rewrite locked upstream creative state merely to make the pipeline appear complete.

Publication is blocked unless deterministic episode and media validation succeeds.

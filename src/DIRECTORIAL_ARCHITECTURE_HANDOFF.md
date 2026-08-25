# StreamVerse Studios — Directorial Continuity Regeneration Handoff

This package is the regenerated production layer based on the four StreamVerse source files uploaded for this task:

- `scriptWriter.js`
- `globalContinuity.js`
- `cameraSim.js`
- `constraintEnforcer.js`

The package also adds the directorial intelligence modules required by the new architecture:

- `directorState.js` — canonical Movie/Director State
- `directorialOrchestrator.js` — deterministic bridge between authored state and downstream modules
- `blockingDirector.js` — explicit character blocking + teleport detection
- `travelChoreography.js` — physical origin/departure/transit/arrival choreography
- `dialogueDirector.js` — structured conversation/performance plan
- `editorialDirector.js` — narrative reason for cuts and handoffs
- `audioContinuity.js` — ambience/music/dialogue continuity metadata
- `smoke_test.js` — dependency-light continuity regression test

## Integration model

The intended flow is:

`scene/shot simulation -> canonical director state -> blocking/travel/performance -> camera -> image -> video -> validation -> editorial/audio`

`scriptWriter.js` now invokes the directorial orchestrator during shot simulation and again after dialogue coverage, so persisted or newly generated shots receive the same canonical state.

`cameraSim.js` also self-heals legacy/resumed shots that arrive without `_director_state`.

`constraintEnforcer.js` now treats missing or contradictory canonical state, blocking collisions, and location teleports as validation failures.

## Travel behavior

A location change is no longer represented as a destination field alone.

For a meaningful transition the planner produces:

`origin -> depart -> in_transit -> approach (when shot count allows) -> arrive -> destination`

For a three-shot journey the minimum choreography is:

`depart -> in_transit -> arrive`

The origin remains the authoritative current location during departure/transit. Destination location becomes authoritative at arrival.

## Important compatibility note

These files are regenerated from the uploaded source files, not from an unseen repository snapshot. Any modules referenced by the original code that were not uploaded (for example `config.js`, `db.js`, `util.js`, `shotStaging.js` and other existing StreamVerse modules) are intentionally not recreated here and should remain in the repo.

Copy the regenerated files into the existing StreamVerse source tree using their filenames.

## Verification performed

- Node syntax check passed for every regenerated `.js` file.
- Behavioral smoke test passed for a cross-location drive.
- Teleport/state mismatch is detected as a hard directorial validation failure.



## Source-authoritative continuity architecture

Shot N+1 opening stills are generated from the exact completed Shot N terminal frame plus only the canonical character reference images required for the current shot. The predecessor frame is the authoritative scene canvas; canonical references are identity anchors, not scene redesign inputs. LTX and Agnes both receive the resulting current-shot still as their authoritative I2V image. Agnes does not receive the predecessor frame as a competing second keyframe. When VIDEO_PROVIDER=agnes, the active production duration ceiling is 18 seconds throughout planning and media generation.

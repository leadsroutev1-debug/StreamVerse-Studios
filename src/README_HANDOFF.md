# StreamVerse Studios — Directorial Continuity Complete Handoff

This package is a repo-ready replacement set for the supplied StreamVerse production files.

## Included replacement files

Core integration:
- `pipeline.js`
- `scriptWriter.js`
- `globalContinuity.js`
- `cameraSim.js`
- `constraintEnforcer.js`
- `shotStaging.js`
- `db.js`
- `config.js`
- `util.js`

New directorial layer:
- `directorState.js`
- `blockingDirector.js`
- `travelChoreography.js`
- `dialogueDirector.js`
- `directorialOrchestrator.js`
- `editorialDirector.js`
- `audioContinuity.js`

Validation/documentation:
- `smoke_test.js`
- `DIRECTORIAL_ARCHITECTURE_HANDOFF.md`

## Important existing-repo dependencies

`config.js` intentionally continues to load the repository's existing:
- `configCore.js`
- `providerPromptAdapter.js`

`pipeline.js` and `scriptWriter.js` also continue to use existing StreamVerse production modules that were not supplied in this handoff, including media providers, scene state, temporal consistency, motion, hard-control, compiler, Cloudinary, TTS, and application state/Telegram/Discord modules.

Do not delete those existing repository modules.

## Installation

Copy the files from this package over the matching files in the StreamVerse repository, preserving the exact filenames.

The new directorial files must sit beside `scriptWriter.js`, `pipeline.js`, `cameraSim.js`, `globalContinuity.js`, and `constraintEnforcer.js`.

## Main continuity fix

The canonical state path is now:

authored narrative -> director state -> blocking/travel/performance/camera/editorial/audio -> provider rendering

Travel is represented explicitly as:
`prepare -> depart -> in_transit -> approach -> arrive`

A destination state is no longer allowed to become the starting state of an unresolved journey.

The pipeline rehydrates directorial state at the processing boundary without changing shot indexes, so resume/retry processing does not invalidate persisted `shots` rows.


## Source-authoritative continuity architecture

Shot N+1 opening stills are generated from the exact completed Shot N terminal frame plus only the canonical character reference images required for the current shot. The predecessor frame is the authoritative scene canvas; canonical references are identity anchors, not scene redesign inputs. LTX and Agnes both receive the resulting current-shot still as their authoritative I2V image. Agnes does not receive the predecessor frame as a competing second keyframe. When VIDEO_PROVIDER=agnes, the active production duration ceiling is 18 seconds throughout planning and media generation.

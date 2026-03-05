# funlooper-com: 33 New Tools + DAG Scheduler + Tool Chains

**Repo:** funlooper-com
**Priority:** Medium
**Todo IDs:** 2875-2885

## Features

### 1. Swing Field + 33 New Tools (2875-2877)
- Add swing field to `funlooper_song_t` in midi.h
- Implement 33 new tools in `fl_tools.h` + `fl_tools.c`
- Write tests for all 33 tools

### 2. DAG Scheduler (2878-2880)
- Build DAG scheduler for tool chain execution
- Test DAG scheduler
- Wire into EKKO and update CMakeLists.txt

### 3. Tool Chains (2881-2885)
- Create `data/tool_chains.json` with 300+ chains
- Validation test for chains
- Few-shot chain sampling in instrument panel
- Build and run full test suite

## Notes
This is the funlooper DSP pipeline expansion. The 33 tools are audio manipulation primitives. The DAG scheduler enables composable tool chains — key for the EKKO live performance engine.

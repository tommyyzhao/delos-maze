// Runs under JavaScriptCore:  jsc -m test/tools/jsc-run.mjs -- <path to maze-replay.json>   (prints the probe as JSON)
import { probe } from '../probe.mjs';
const path = arguments[0];
print(JSON.stringify(probe(JSON.parse(read(path)))));

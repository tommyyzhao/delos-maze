// Pages maps functions/api/runs.js to /api/runs only; this catch-all serves /api/runs/<id or name>/replay.
export { onRequestGet, onRequestPost } from '../runs.js';

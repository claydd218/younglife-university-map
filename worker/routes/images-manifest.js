// Routes GET /bigtime/api/images-manifest — lists every filename currently
// in images/, in one request. bigtime/report/report.js needs this to
// resolve each staff member's photo: staff photos aren't stored with a
// known filename the way a ministry's own `photos` column is (see
// lib/ministries.js), only a slugified name, so the actual extension
// (png/jpg/jpeg/webp — CONFIG.IMAGE_EXTENSIONS) has to be guessed. The
// report page used to guess by firing a HEAD request per candidate
// extension per staff member — with
// 100+ staff across a report, that's hundreds of requests fired at once
// via Promise.all, which showed up in production as multi-thousand-request
// spikes in Workers analytics every time a report was generated. Fetching
// this manifest once and checking membership in-memory replaces all of
// that with a single request.

import { listDir } from '../lib/github.js';
import { jsonResponse } from '../lib/http.js';

const IMAGES_DIR = 'images';

export async function onRequestGet({ env }) {
  const files = await listDir(env, IMAGES_DIR);
  return jsonResponse({ files: files.map((f) => f.name) });
}

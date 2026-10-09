// The single Vercel Function for the whole API. vercel.json rewrites /api/* here.
import { getHandler } from '../server/production.js';

export default {
  fetch(request: Request): Promise<Response> {
    return getHandler()(request);
  },
};

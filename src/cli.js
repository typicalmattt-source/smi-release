// Runs the backend without a window, for tests and for working on the UI in a browser.
import { startServer } from './server.js';

startServer().then(url => console.log(`Source Map Importer running at ${url}`)).catch(e => {
  console.error(e.message);
  process.exit(1);
});
